import type { SavingsGoalRow } from '../db/schema'
import { epochMsToIso, monthKeyOf } from '../lib/dates'
import { medianOf } from '../lib/stats'
import type { GoalMonth } from './contributions'

export interface GoalProgress {
  goalId: string; targetCents: number
  contributedCents: number; remainingCents: number      // remaining never below 0
  /**
   * Null when it cannot honestly be estimated; otherwise a range of months, never a single date.
   * `latestMonth` is null when some months had nothing put toward the goal: the slow end is then unbounded and only
   * "no sooner than earliestMonth" is true. (The brief's type had no way to say this, so it is nullable here.)
   */
  estimate: { earliestMonth: string; latestMonth: string | null } | null
  estimateWhy: string | null                             // owner-facing reason when estimate is null
  reached: boolean
}

export const MIN_ESTIMATE_MONTHS = 3

/** Month `n` after 'YYYY-MM' (n >= 0), integer arithmetic. */
function addMonths(month: string, n: number): string {
  const year = Number(month.slice(0, 4))
  const index = year * 12 + (Number(month.slice(5, 7)) - 1) + n
  const y = Math.floor(index / 12)
  return `${String(y).padStart(4, '0')}-${String(index - y * 12 + 1).padStart(2, '0')}`
}

/** ceil(a / b) for positive integers. */
const divCeil = (a: number, b: number): number => Math.floor((a + b - 1) / b)

/**
 * Where the owner stands on a goal, and a range for when it might be reached.
 *
 * Only months of this goal on or after the month it was created (UTC calendar) count. The range comes from the owner's
 * own months: sort the monthly contributions, split into a lower and an upper half of floor(n / 2) months each (with an
 * odd count the middle month belongs to neither), and take the middle value of each half. The upper half's middle sets
 * the faster end, the lower half's the slower end. Months to go = remaining / that rate, rounded UP, counted from the
 * month after `lastCompletedMonth`. A month with no record is not counted as a zero month.
 */
export function progressOf(goal: SavingsGoalRow, months: readonly GoalMonth[], lastCompletedMonth: string): GoalProgress {
  const createdMonth = monthKeyOf(epochMsToIso(goal.createdAt))
  const counted = months.filter((m) => m.goalId === goal.id && m.month >= createdMonth)
  let contributedCents = 0
  for (const m of counted) contributedCents += m.contributedCents
  const remainingCents = Math.max(0, goal.targetCents - contributedCents)
  const reached = contributedCents >= goal.targetCents
  const base = { goalId: goal.id, targetCents: goal.targetCents, contributedCents, remainingCents, reached }
  if (reached) return { ...base, estimate: null, estimateWhy: null }

  const withMoney = counted.filter((m) => m.contributedCents > 0).length
  if (withMoney < MIN_ESTIMATE_MONTHS) {
    const have = withMoney === 0
      ? 'Nothing has been put toward this goal in a finished month yet.'
      : `So far ${withMoney} finished ${withMoney === 1 ? 'month has' : 'months have'} something put toward this goal.`
    return { ...base, estimate: null, estimateWhy: `${have} A range needs at least ${MIN_ESTIMATE_MONTHS} months with something put toward it.` }
  }

  const sorted = counted.map((m) => m.contributedCents).sort((a, b) => a - b)
  const half = Math.floor(sorted.length / 2)
  const slower = medianOf(sorted.slice(0, half)) ?? 0
  const faster = medianOf(sorted.slice(sorted.length - half)) ?? 0
  if (faster <= 0) {
    return { ...base, estimate: null, estimateWhy: 'Too few months have had money put toward this goal to give a useful range yet.' }
  }

  const earliestMonth = addMonths(lastCompletedMonth, divCeil(remainingCents, faster))
  if (slower <= 0) {
    return {
      ...base, estimate: { earliestMonth, latestMonth: null },
      estimateWhy: 'Some months had nothing put toward this goal, so there is no latest date, only that it will be no sooner than the earliest one.',
    }
  }
  return { ...base, estimate: { earliestMonth, latestMonth: addMonths(lastCompletedMonth, divCeil(remainingCents, slower)) }, estimateWhy: null }
}
