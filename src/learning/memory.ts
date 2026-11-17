import { db } from '../db/db'
import type { MerchantRow } from '../db/schema'
import { matchMerchant } from './merchants'

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

/**
 * §11: "corrected twice the same way becomes the default". Exported because the Intelligence screen has to tell the
 * owner how many more corrections a merchant needs, and a second copy of this number in the screen would be one more
 * instance of the duplicated rule this project has had to remove five times.
 */
export const CORRECTIONS_NEEDED = 2

interface Latest { at: number; id: string; categoryId: string | null; isCorrection: boolean }

/** Narrows an untyped payload; a malformed or legacy one yields null and is skipped, never thrown on. */
function readCategoryPayload(payload: unknown): { transactionId: string; categoryId: string | null; isCorrection: boolean } | null {
  if (typeof payload !== 'object' || payload === null) return null
  const p = payload as Record<string, unknown>
  if (typeof p.transactionId !== 'string') return null
  if (p.new !== null && typeof p.new !== 'string') return null
  // An absent intent means correction (see LearningEventRow); only an explicit 'confirmation' is not one.
  // Excluding confirmations loses no signal: writeAnnotation marks 'confirmation' only when the old and new
  // EFFECTIVE category are equal (stored or ING-derived). A classifier suggestion is neither stored nor derived,
  // so confirming one is already a 'correction' and does graduate into memory.
  return { transactionId: p.transactionId, categoryId: p.new, isCorrection: p.intent !== 'confirmation' }
}

/**
 * `merchants` is optional: a caller that has already read the merchant list (the import preview does) passes it
 * so the table is read once per operation. Omitted, the memory reads it itself, once.
 */
export async function categoryMemory(knownMerchants?: MerchantRow[]): Promise<CategoryMemory> {
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
    // Total order: later `at` wins; equal `at` falls back to the event id, so the result never depends on read order.
    if (seen === undefined || row.at > seen.at || (row.at === seen.at && row.id > seen.id)) {
      latest.set(p.transactionId, { at: row.at, id: row.id, categoryId: p.categoryId, isCorrection: p.isCorrection })
    }
  }

  // Only a transaction whose latest event is a real correction to a category teaches anything.
  const taught = [...latest].filter(([, l]) => l.isCorrection && l.categoryId !== null)
  if (taught.length === 0) return new Map()

  const ids = taught.map(([id]) => id)
  const [txs, anns, merchants] = await Promise.all([db.transactions.bulkGet(ids), db.annotations.bulkGet(ids), knownMerchants ?? db.merchants.toArray()])

  // merchantId -> categoryId -> tally
  const tallies = new Map<string, Map<string, { corrections: number; lastAt: number }>>()
  taught.forEach(([, l], i) => {
    // A soft-deleted (or vanished) transaction no longer reflects the owner's current books.
    const tx = txs[i]
    if (tx === undefined || tx.deletedAt !== null) return
    // A stored merchantId always wins. Without one, fall back to matching the BANK description (never
    // descriptionOverride: stored patterns are anchored to the bank text) against the owner's merchant patterns,
    // so one naming covers every later correction on a matching row and nothing has to be written (§34.3).
    // A row that matches no merchant cannot feed per-merchant memory and is skipped.
    const stored = anns[i]?.merchantId
    const merchantId = stored !== null && stored !== undefined ? stored : matchMerchant(tx.description, merchants)?.id
    if (merchantId === undefined) return
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
      // Total order, like the per-transaction fold above: most corrections wins, a tie goes to the most recent
      // correction, and a tie on both falls back to the category id — so the answer never depends on read order.
      if (best === null || t.corrections > best.corrections
        || (t.corrections === best.corrections && t.lastAt > best.lastAt)
        || (t.corrections === best.corrections && t.lastAt === best.lastAt && categoryId > best.categoryId)) {
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
