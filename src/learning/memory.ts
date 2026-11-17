import { db } from '../db/db'

/**
 * Frequency memory (§11): what the owner has taught the app about each merchant's category.
 *
 * It is DERIVED from the append-only event log on every call and never stored as a counter: a stored
 * counter could disagree with the log, and the log is the record.
 *
 * A full scan of `learningEvents` is sanctioned in THIS module and nowhere else in the app. The table is
 * indexed only by id, at and type, and the memory needs every category event to fold per transaction.
 * Do not copy this pattern into a screen; screens read the memory this returns.
 */

export type CategoryMemory = ReadonlyMap<string, { categoryId: string; corrections: number; lastAt: number }>

/** §11: "corrected twice the same way becomes the default". */
const CORRECTIONS_NEEDED = 2

interface Latest { at: number; categoryId: string | null; isCorrection: boolean }

/** Narrows an untyped payload; a malformed or legacy one yields null and is skipped, never thrown on. */
function readCategoryPayload(payload: unknown): { transactionId: string; categoryId: string | null; isCorrection: boolean } | null {
  if (typeof payload !== 'object' || payload === null) return null
  const p = payload as Record<string, unknown>
  if (typeof p.transactionId !== 'string') return null
  if (p.new !== null && typeof p.new !== 'string') return null
  // An absent intent means correction (see LearningEventRow); only an explicit 'confirmation' is not one.
  return { transactionId: p.transactionId, categoryId: p.new, isCorrection: p.intent !== 'confirmation' }
}

export async function categoryMemory(): Promise<CategoryMemory> {
  // One scan of the log (the single sanctioned one).
  const rows = await db.learningEvents.toArray()

  // Fold per transaction first: the log keeps every change (Groceries, then Transport is two events),
  // but the owner's intent is the latest one, so a revert cannot inflate a count.
  const latest = new Map<string, Latest>()
  for (const row of rows) {
    if (row.type !== 'category') continue
    const p = readCategoryPayload(row.payload)
    if (p === null) continue
    const seen = latest.get(p.transactionId)
    if (seen === undefined || row.at >= seen.at) {
      latest.set(p.transactionId, { at: row.at, categoryId: p.categoryId, isCorrection: p.isCorrection })
    }
  }

  // Only a transaction whose latest event is a real correction to a category teaches anything.
  const taught = [...latest].filter(([, l]) => l.isCorrection && l.categoryId !== null)
  if (taught.length === 0) return new Map()

  const ids = taught.map(([id]) => id)
  const [txs, anns] = await Promise.all([db.transactions.bulkGet(ids), db.annotations.bulkGet(ids)])

  // merchantId -> categoryId -> tally
  const tallies = new Map<string, Map<string, { corrections: number; lastAt: number }>>()
  taught.forEach(([, l], i) => {
    // A soft-deleted (or vanished) transaction no longer reflects the owner's current books.
    const tx = txs[i]
    if (tx === undefined || tx.deletedAt !== null) return
    // No merchant means nothing to attribute the correction to, so it cannot feed per-merchant memory.
    const merchantId = anns[i]?.merchantId
    if (merchantId === null || merchantId === undefined) return
    const categoryId = l.categoryId as string
    const byCategory = tallies.get(merchantId) ?? new Map<string, { corrections: number; lastAt: number }>()
    const t = byCategory.get(categoryId) ?? { corrections: 0, lastAt: 0 }
    t.corrections += 1
    t.lastAt = Math.max(t.lastAt, l.at)
    byCategory.set(categoryId, t)
    tallies.set(merchantId, byCategory)
  })

  const memory = new Map<string, { categoryId: string; corrections: number; lastAt: number }>()
  for (const [merchantId, byCategory] of tallies) {
    let best: { categoryId: string; corrections: number; lastAt: number } | null = null
    for (const [categoryId, t] of byCategory) {
      // Most corrections wins; a tie goes to the most recent correction.
      if (best === null || t.corrections > best.corrections || (t.corrections === best.corrections && t.lastAt > best.lastAt)) {
        best = { categoryId, ...t }
      }
    }
    if (best !== null) memory.set(merchantId, best)
  }
  return memory
}

/** The category to assume for a merchant, or null until the owner has corrected it the same way twice. */
export function rememberedCategoryFor(merchantId: string, memory: CategoryMemory): string | null {
  const m = memory.get(merchantId)
  return m !== undefined && m.corrections >= CORRECTIONS_NEEDED ? m.categoryId : null
}
