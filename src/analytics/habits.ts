import { resolveMany } from '../db/annotations'
import type { TransactionRow } from '../db/schema'
import { addDays, daysBetween } from '../lib/dates'
import { sumCents } from '../lib/money'
import { medianOf } from '../lib/stats'
import { liveTransactionsBetween, nextMonthStart } from '../analysis/transactionsInRange'
import { loadCategoryKinds } from '../analysis/queues'
import { excludedTransactionIds, treatmentOf } from '../analysis/income'
import { cached } from './cache'

/**
 * Two descriptive figures about habits: what the small purchases of a month add up to, and how the month's spending is spread
 * over the days after income arrived. Counts and sums only; nothing here says why the owner spent.
 *
 * §41: the amount, the sign and the DATE are the BANK's, on both sides of "days since income". An `amountCentsOverride` or a
 * `dateOverride` never moves a purchase between days or resizes it. The owner's classifications (kind, category) decide only
 * whether a row is spending or income at all (§43), through the same `treatmentOf` and income rule the budget uses.
 *
 * Figures are cached (§7.1) under keys that name the figure and every parameter of its scope; the clock arrives as `computedAt`.
 * The month is read with `liveTransactionsBetween`, which is already bounded by the date range.
 */

export interface SmallPurchases {
  count: number
  totalCents: number
  /** Integer cents, tie rule in `src/lib/stats.ts`. null exactly when `count` is 0: there is nothing to take a median of. */
  medianCents: number | null
}

export interface AfterPayday {
  /**
   * How many days the series covers: from the payday to the end of that month, inclusive. A payday on the 28th observes 3.
   * Every figure is bucketed by the bank's month (§41), so the series stops at month end and a late payday gives a SHORT
   * series, not the shape of a whole one. A screen must say how much was observed, and this is the number it says it with.
   */
  daysObserved: number
  days: PaydayDay[]
}

export interface PaydayDay {
  /** Days since the income arrived, by bank dates: 0 is the day it landed. */
  dayOffset: number
  spentCents: number
  transactions: number
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/
function assertMonth(month: string): void {
  if (!MONTH_RE.test(month)) throw new Error(`Invalid month, expected YYYY-MM: ${month}`)
}

/** The month's live bank rows paired with whether each is spending (owner's kind and category, bank's sign) or income. */
async function classified(month: string): Promise<{ spends: TransactionRow[]; incomes: TransactionRow[] }> {
  const bank = await liveTransactionsBetween(month, month)
  const [resolved, kinds, excluded] = await Promise.all([resolveMany(bank), loadCategoryKinds(), excludedTransactionIds(month)])
  const byId = new Map(bank.map((t) => [t.id, t]))
  const spends: TransactionRow[] = []
  const incomes: TransactionRow[] = []
  for (const r of resolved) {
    const t = byId.get(r.id)
    if (!t || excluded.has(t.id)) continue
    // The kind and the category are the owner's; the sign (which side of the ledger a row can be on) is the bank's.
    const categoryKind = r.categoryId === null ? null : (kinds.get(r.categoryId) ?? null)
    if (t.amountCents < 0 && treatmentOf(r.kind, categoryKind) === 'spending') spends.push(t)
    else if (t.amountCents > 0 && r.kind === 'income') incomes.push(t)
  }
  return { spends, incomes }
}

/**
 * The purchases of `month` strictly under `ceilingCents` (money out, bank amount), with how many there were, what they came to
 * and their median. The median is reported beside the total so one large row, or a handful, cannot pass for many small ones.
 */
export async function smallPurchases(month: string, ceilingCents: number, computedAt: number): Promise<SmallPurchases> {
  assertMonth(month)
  if (!Number.isSafeInteger(ceilingCents) || ceilingCents <= 0) throw new Error(`Invalid ceiling, expected positive integer cents: ${ceilingCents}`)
  return cached(`habits.small:${month}:${ceilingCents}`, async () => {
    const { spends } = await classified(month)
    const cents = spends.map((t) => -t.amountCents).filter((c) => c < ceilingCents)
    return { count: cents.length, totalCents: sumCents(cents), medianCents: medianOf(cents) }
  }, computedAt)
}

/**
 * Spending by days since the month's largest income arrived, one entry per day from 0 to the end of the month, in order.
 * A day with no spending is an entry of zeros, never a gap. Spending before the income landed is not "after payday" and is
 * not in the series.
 *
 * Returns null when the month holds no income event: with no payday there is no pattern, and that is not the same statement
 * as a flat one. "Income event" is the rule `netIncome` uses: money in by the bank's sign, resolved kind income, and not a
 * netted transfer or refund.
 */
export async function afterPayday(month: string, computedAt: number): Promise<AfterPayday | null> {
  assertMonth(month)
  return cached(`habits.afterPayday:${month}`, async () => {
    const { spends, incomes } = await classified(month)
    // The payday is the LARGEST income of the month, not the first: §13.1 asks about spending after the salary, and a small
    // early deposit would otherwise start the clock before the money that drives the pattern arrived. Refunds and netted
    // transfers are already out of `incomes`, so the largest remaining inflow is the salary. Ties go to the earlier date.
    const payday = [...incomes].sort((x, y) => y.amountCents - x.amountCents || (x.valueDate < y.valueDate ? -1 : x.valueDate > y.valueDate ? 1 : 0))[0]
    if (payday === undefined) return null
    const first = payday.valueDate
    const lastDay = addDays(nextMonthStart(month), -1)
    const days: PaydayDay[] = []
    for (let offset = 0; offset <= daysBetween(first, lastDay); offset++) days.push({ dayOffset: offset, spentCents: 0, transactions: 0 })
    for (const t of spends) {
      const day = days[daysBetween(first, t.valueDate)]
      if (day === undefined) continue // before the income landed
      day.spentCents += -t.amountCents
      day.transactions += 1
    }
    return { daysObserved: days.length, days }
  }, computedAt)
}
