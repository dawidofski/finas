import Dexie from 'dexie'
import { db } from '../db/db'

export interface AccountBalance {
  accountId: string
  label: string
  last4: string | null
  /** The bank's running balance after the latest movement imported for this account. */
  balanceCents: number
  /** The bank date of that movement: the balance is "as of" this day, not today. */
  asOf: string
}

/**
 * The latest balance the bank printed for each account that is not archived. The figure is the BANK's (the SALDO column
 * of the newest imported movement), never a sum worked out here, so it is right even when only part of an account's
 * history has been imported. One short indexed read per account: the rows of its newest date, never the whole table.
 *
 * Within that date, the newest row is the one nearest the top of the most recently imported file (a statement lists the
 * newest movement first, and `fileSeq` counts from the top).
 *
 * An account with no movements has no balance to show and is left out. Ordered by label, then id.
 */
export async function accountBalances(): Promise<AccountBalance[]> {
  const accounts = (await db.accounts.toArray()).filter((a) => !a.archived)
  const out: AccountBalance[] = []
  for (const a of accounts) {
    const newest = await db.transactions.where('[accountId+valueDate]').between([a.id, Dexie.minKey], [a.id, Dexie.maxKey]).last()
    if (!newest) continue
    const sameDay = await db.transactions.where('[accountId+valueDate]').equals([a.id, newest.valueDate]).toArray()
    const latest = sameDay.reduce((best, r) =>
      r.createdAt > best.createdAt || (r.createdAt === best.createdAt && r.fileSeq < best.fileSeq) ? r : best, newest)
    out.push({ accountId: a.id, label: a.label, last4: a.last4, balanceCents: latest.balanceCents, asOf: latest.valueDate })
  }
  return out.sort((x, y) => (x.label < y.label ? -1 : x.label > y.label ? 1 : x.accountId < y.accountId ? -1 : 1))
}
