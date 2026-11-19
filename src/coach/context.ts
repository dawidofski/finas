import { monthSeries } from '../analytics/series'
import { addMonths, formatMonthTitle, monthKeyOf } from '../lib/dates'
import { formatEur } from '../lib/money'

/** How many completed months of totals a question carries. */
export const COACH_MONTHS = 6

/**
 * One month as the coach is told about it: totals only. There is no transaction, description, merchant, person, account
 * or note in this shape, so none can be sent by a caller that only has this. Amounts are integer cents.
 */
export interface CoachMonth {
  month: string
  /** null when no income is known for the month: "not known", never "earned nothing". */
  incomeCents: number | null
  /** The income figure is an estimate from earlier months, not what the bank recorded for this one. */
  incomeIsEstimate: boolean
  spentCents: number
  savedCents: number
  essentialCents: number
  discretionaryCents: number
  /** Spending filed under neither. */
  otherSpendingCents: number
  /** Income less spending and saving; null when the income is not known. */
  leftOverCents: number | null
}

/**
 * The totals of the last COACH_MONTHS completed months before the month `today` falls in, oldest first, leaving out months
 * with no data. The running month is never included: a part-month is not a month. Reads through monthSeries, the same
 * figures the Dashboard shows, so the coach is never told something the owner cannot see on their own screens.
 */
export async function coachContext(today: string, computedAt: number): Promise<CoachMonth[]> {
  const current = monthKeyOf(today)
  const points = await monthSeries(addMonths(current, -COACH_MONTHS), addMonths(current, -1), today, computedAt)
  return points.filter((p) => p.hasData).map((p) => {
    const known = p.incomeBasis !== 'none'
    return {
      month: p.month,
      incomeCents: known ? p.incomeCents : null,
      incomeIsEstimate: known && p.incomeBasis !== 'actual',
      spentCents: p.spentCents,
      savedCents: p.savedCents,
      essentialCents: p.essentialCents,
      discretionaryCents: p.discretionaryCents,
      otherSpendingCents: p.uncategorisedCents,
      leftOverCents: known ? p.netCents : null,
    }
  })
}

/** One month as a line of plain text, the form in which it is sent and shown. */
export function monthLine(m: CoachMonth): string {
  const income = m.incomeCents === null ? 'income not known' : `income ${formatEur(m.incomeCents)}${m.incomeIsEstimate ? ' (an estimate)' : ''}`
  const left = m.leftOverCents === null ? '' : `, left over ${formatEur(m.leftOverCents)}`
  return `${formatMonthTitle(m.month)}: ${income}, spent ${formatEur(m.spentCents)} (essentials ${formatEur(m.essentialCents)}, wants ${formatEur(m.discretionaryCents)}, other ${formatEur(m.otherSpendingCents)}), saved ${formatEur(m.savedCents)}${left}`
}
