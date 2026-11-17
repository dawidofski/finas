import { db } from './db'
import type { TransferRow } from './schema'

/**
 * Transfer rows that name any of `ids` as a leg, as a map from each leg id to its row. Two index lookups on the ids
 * asked about, instead of reading every transfer the owner has ever had (spec 39.4): the cost follows the question, not
 * the history. Both legs of a found row are keys, so a caller can also see which row claimed an id.
 */
export async function linkedAmong(ids: readonly string[]): Promise<Map<string, TransferRow>> {
  const out = new Map<string, TransferRow>()
  for (const t of await transfersTouching(ids)) { out.set(t.outTransactionId, t); out.set(t.inTransactionId, t) }
  return out
}

/** Every transfer row with a leg in `ids`, once each. A purchase refunded twice has two rows; the map above keeps one per leg id, this keeps both. */
export async function transfersTouching(ids: readonly string[]): Promise<TransferRow[]> {
  if (ids.length === 0) return []
  const [asOut, asIn] = await Promise.all([
    db.transfers.where('outTransactionId').anyOf(ids).toArray(),
    db.transfers.where('inTransactionId').anyOf(ids).toArray(),
  ])
  return [...new Map([...asOut, ...asIn].map((t) => [t.id, t])).values()]
}
