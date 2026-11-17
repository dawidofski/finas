import { db } from '../db/db'
import type { TransactionRow } from '../db/schema'
import { addDays, monthKeyOf } from '../lib/dates'

/** The first day of the month after `month`: an exclusive upper bound for a date range. Goes through dates.ts. */
export function nextMonthStart(month: string): string {
  return `${monthKeyOf(addDays(`${month}-28`, 4))}-01`
}

/**
 * Live transactions with a bank valueDate in [firstMonth, lastMonth], across every account. The one place that
 * answers "the transactions of a month", shared by income and the budget so the two can never disagree about a bound.
 *
 * Query strategy: the only index is [accountId+valueDate], so we list the distinct accountIds actually present in
 * the transactions table (an index-only read, no rows) and run one bounded range per account. That scales with the
 * window rather than the whole ledger, and unlike reading db.accounts it cannot miss an account whose row is gone.
 * Soft-deleted rows are excluded. Dates are the bank's; owner date overrides are the caller's concern.
 */
export async function liveTransactionsBetween(firstMonth: string, lastMonth: string): Promise<TransactionRow[]> {
  const start = `${firstMonth}-01`
  const endExclusive = nextMonthStart(lastMonth)
  const accountIds = await db.transactions.orderBy('accountId').uniqueKeys()
  const perAccount = await Promise.all(
    accountIds.map((accountId) =>
      db.transactions.where('[accountId+valueDate]').between([accountId, start], [accountId, endExclusive], true, false).toArray(),
    ),
  )
  return perAccount.flat().filter((t) => t.deletedAt === null)
}
