import { db } from '../db/db'
import type { CandidateRow } from './normalise'

/**
 * `review` is never resolved here: the owner decides (design 9.10, 34.1).
 * A `new` verdict guarantees the unique dedupKey will not collide on insert, whether with a stored row or with
 * another row of the same file. `firstIndex` is the position, in the batch, of the earlier row sharing the key.
 */
export type DedupVerdict =
  | { kind: 'new' }
  | { kind: 'duplicate'; existingId: string }
  | { kind: 'review'; existingId: string; reason: 'deleted' | 'same-slot-different-description' }
  | { kind: 'review'; reason: 'duplicate-within-file'; firstIndex: number }

export type ReviewReason = Extract<DedupVerdict, { kind: 'review' }>['reason']

/** What the owner reads next to a review row. */
export const REVIEW_REASON_TEXT: Record<ReviewReason, string> = {
  deleted:
    'You deleted this transaction earlier, so it was not imported again. To bring it back, open Transactions, ' +
    'choose Show, then Deleted, and press Restore.',
  'same-slot-different-description':
    'A transaction with the same date, amount and balance is already imported, but its description differs. ' +
    'It was left as it is and this one was not imported; nothing more is needed.',
  'duplicate-within-file':
    'This file lists another transaction with the same date, amount and balance, so the file looks malformed here. ' +
    'The first one will be imported and this one skipped; the rest of the file is unaffected.',
}

/**
 * Classifies a whole file against the ledger with one indexed lookup on `dedupKey`, soft-deleted rows included.
 * A deleted row must be found and surfaced: treating it as absent would make the insert throw on the unique key
 * and roll back the entire import (34.1). The lookup reads bank values only, never an annotation, so a row the owner
 * has edited is still recognised (Review Focus 5). Verdicts are returned in input order.
 *
 * Two candidates in one file sharing a key would make the second insert throw and roll the whole import back, so the
 * first keeps its verdict and each later one is sent to review as 'duplicate-within-file'.
 */
export async function classifyRows(rows: CandidateRow[]): Promise<DedupVerdict[]> {
  if (rows.length === 0) return []
  const stored = await db.transactions.where('dedupKey').anyOf(rows.map((r) => r.dedupKey)).toArray()
  const byKey = new Map(stored.map((t) => [t.dedupKey, t]))
  const firstSeen = new Map<string, number>()
  return rows.map((row, index): DedupVerdict => {
    const earlier = firstSeen.get(row.dedupKey)
    if (earlier !== undefined) return { kind: 'review', reason: 'duplicate-within-file', firstIndex: earlier }
    firstSeen.set(row.dedupKey, index)
    const hit = byKey.get(row.dedupKey)
    if (!hit) return { kind: 'new' }
    if (hit.deletedAt !== null) return { kind: 'review', existingId: hit.id, reason: 'deleted' }
    // Both descriptions have been through the same scrub, so they are comparable. (No row was ever stored under an
    // older scrub, so no spurious mismatch can arise; a mismatch would only fail safe, into review.)
    if (hit.description !== row.description) {
      return { kind: 'review', existingId: hit.id, reason: 'same-slot-different-description' }
    }
    return { kind: 'duplicate', existingId: hit.id }
  })
}
