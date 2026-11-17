import { monthlyBudget } from '../budget/month'
import { liveTransactionsBetween } from '../analysis/transactionsInRange'
import { cached } from './cache'

export interface MonthSummary {
  month: string
  /** The income basis of the month: the bank's income when any landed, otherwise an ESTIMATE (see incomeBasis). */
  incomeCents: number
  spentCents: number
  savedCents: number
  essentialCents: number
  discretionaryCents: number
  /** Spending that is in neither of the two classes: no category, or a category that classifies nothing (a parent). */
  uncategorisedCents: number
  /** income − spent − saved. Built on incomeCents, so it is as provisional as the income is. */
  netCents: number
  /** The income basis is not an observation of this month (netIncome's invariant: provisional === incomeBasis !== 'actual'). */
  provisional: boolean
  /**
   * Which kind of figure incomeCents is. 'none' with incomeCents 0 means "no income known", NOT "earned nothing"; a screen
   * must say so rather than print a confident 0. 'trailing-average' is an estimate from earlier months.
   */
  incomeBasis: 'actual' | 'trailing-average' | 'none'
  /** Live bank transactions dated in the month. 0 means the month has no data at all: every figure above is then empty, not measured. */
  transactions: number
}

/**
 * One month's figures. Every money figure comes from monthlyBudget, which takes amount, sign and date from the BANK and lets
 * the owner's corrections decide only classifications (§41/§43); nothing is re-derived here, so the two screens cannot drift.
 *
 * The split is conserved by construction: uncategorised is spent − essential − discretionary, not a third independent sum,
 * so the three always add to spentCents whatever monthlyBudget does with a row it cannot classify.
 *
 * `computedAt` is the cache row's timestamp. The clock is read only at sanctioned boundaries, so the caller supplies it: the route
 * module reads the clock once, as it already does for `today`, and passes both down through the screen's props.
 */
export async function monthSummary(month: string, today: string, computedAt: number): Promise<MonthSummary> {
  return cached(`monthSummary:${month}`, async () => {
    const [budget, rows] = await Promise.all([monthlyBudget(month, today), liveTransactionsBetween(month, month)])
    const { spentCents, essentialCents, discretionaryCents, savingsCents } = budget.totals
    return {
      month,
      incomeCents: budget.income.cents,
      spentCents,
      savedCents: savingsCents,
      essentialCents,
      discretionaryCents,
      uncategorisedCents: spentCents - essentialCents - discretionaryCents,
      netCents: budget.income.cents - spentCents - savingsCents,
      provisional: budget.income.provisional,
      incomeBasis: budget.income.basis,
      transactions: rows.length,
    }
  }, computedAt)
}
