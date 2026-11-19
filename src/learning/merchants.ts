import { db } from '../db/db'
import { writeAnnotation } from '../db/annotations'
import type { MerchantRow } from '../db/schema'
import { canonicaliseMerchant } from './canonicalise'

// Merchant identity the owner can correct. canonicaliseMerchant is a guess with documented limits: it keeps a
// locality when no country code follows, and a three-word name followed by a country code loses its last word.
// This module is the remedy. When the owner names a merchant we store the pattern that description produced, and a
// stored pattern is consulted BEFORE the canonical guess, so a wrong guess is corrected once and never returns.
// matchPatterns was read by nothing until now; it is the owner's memory of what a description means.

/** Case-, accent- and punctuation-insensitive form, with single spaces, used on both sides of every comparison. */
function normalise(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

const byIdOrder = (a: MerchantRow, b: MerchantRow): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
const oldestFirst = (a: MerchantRow, b: MerchantRow): number => a.createdAt - b.createdAt || byIdOrder(a, b)

/** Length of the longest of the merchant's patterns found in the description, 0 for none. An empty pattern never counts. */
function longestMatch(normalisedDescription: string, merchant: MerchantRow): number {
  const padded = ` ${normalisedDescription} `
  let best = 0
  for (const pattern of merchant.matchPatterns) {
    const p = normalise(pattern)
    // Whole-token containment, so "ana" does not match "banana".
    if (p !== '' && p.length > best && padded.includes(` ${p} `)) best = p.length
  }
  return best
}

/**
 * The merchant a description belongs to, or null. A stored pattern wins; only when none matches do we fall back to
 * the canonical name. Among several matching patterns the longest wins (a specific pattern beats a general one);
 * equal lengths break by createdAt, then id, so the answer never depends on array order.
 */
export function matchMerchant(description: string, merchants: MerchantRow[]): MerchantRow | null {
  const text = normalise(description)
  const hits = merchants
    .map((m) => ({ m, length: longestMatch(text, m) }))
    .filter((h) => h.length > 0)
    .sort((a, b) => b.length - a.length || oldestFirst(a.m, b.m))
  const byPattern = hits[0]
  if (byPattern) return byPattern.m

  const canonical = normalise(canonicaliseMerchant(description))
  if (canonical === '') return null // "no merchant here" must not become a merchant
  return merchants.filter((m) => normalise(m.canonicalName) === canonical).sort(oldestFirst)[0] ?? null
}

/**
 * The owner names the merchant behind a transaction. Creates the merchant, or reuses the one with that name, and adds
 * the pattern derived from the transaction's bank description. The pattern is stored in the owner's reading of the
 * description (the canonical form, original spelling) and compared normalised. A pattern the owner now claims is taken
 * from any other merchant, so the correction wins instead of tying. The check and the write share one transaction, so
 * two quick taps cannot create two merchants. `createdAt` is supplied by the caller: the clock is read only where
 * sourceRules.test.ts sanctions it.
 */
export async function rememberMerchantName(transactionId: string, canonicalName: string, createdAt: number): Promise<MerchantRow> {
  const name = canonicalName.trim().replace(/\s+/g, ' ')
  if (normalise(name) === '') throw new Error('A merchant needs a name. Nothing was saved.')
  return db.transaction('rw', [db.merchants, db.transactions, db.annotations, db.learningEvents, db.categories, db.settings], async () => {
    const tx = await db.transactions.get(transactionId)
    if (!tx) throw new Error('That transaction could not be found. Nothing was saved.')
    // When the bank text has no merchant left, the whole description is the pattern: still specific, never empty.
    // The owner's own words are the right breadth when they occur in the bank text: "Tienda Uno" then also covers the next
    // branch, where the whole canonical ("Tienda Uno Madrid") would need one rename per town. A name the bank text does not
    // contain cannot describe it, so only then do we derive the pattern from the description.
    const typedFits = ` ${normalise(tx.description)} `.includes(` ${normalise(name)} `)
    const pattern = typedFits ? name : canonicaliseMerchant(tx.description) || tx.description.trim().replace(/\s+/g, ' ')
    const key = normalise(pattern)
    if (key === '') throw new Error('That transaction has no description to remember. Nothing was saved.')

    const all = await db.merchants.toArray()
    const existing = all.filter((m) => normalise(m.canonicalName) === normalise(name)).sort(oldestFirst)[0]
    const merchant: MerchantRow = existing ?? {
      id: crypto.randomUUID(), canonicalName: name, kind: 'merchant', matchPatterns: [],
      defaultCategoryId: null, isSubscription: false, createdAt,
    }
    for (const other of all) {
      if (other.id === merchant.id || !other.matchPatterns.some((p) => normalise(p) === key)) continue
      await db.merchants.put({ ...other, matchPatterns: other.matchPatterns.filter((p) => normalise(p) !== key) })
    }
    const patterns = merchant.matchPatterns.filter((p) => normalise(p) !== '')
    const next: MerchantRow = { ...merchant, matchPatterns: patterns.some((p) => normalise(p) === key) ? patterns : [...patterns, pattern] }
    await db.merchants.put(next)
    await writeAnnotation(transactionId, { merchantId: next.id }, 'owner')
    return next
  })
}
