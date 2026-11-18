import type { SavingsGoalRow } from '../db/schema'
import { addMonths, epochMsToIso, monthKeyOf } from '../lib/dates'

/** The most completed months of goal history read for any figure; a goal older than this counts only its last 36 months, and the screens say so. */
export const GOAL_MONTHS = 36

/**
 * The months goal figures are computed over: from the month the earliest goal was created (the UTC month of its instant) to
 * `lastCompletedMonth`, but never more than GOAL_MONTHS months. `capped` says the cap took months away. `from` is after
 * `lastCompletedMonth` when every goal was created this month, and there is then nothing to read. Shared by the Money Score
 * and the Goals screen, so the two read the same months and show the same figures.
 */
export function goalWindow(goals: readonly SavingsGoalRow[], lastCompletedMonth: string): { from: string; capped: boolean } {
  const earliest = goals.map((g) => monthKeyOf(epochMsToIso(g.createdAt))).sort()[0] ?? lastCompletedMonth
  const start = addMonths(lastCompletedMonth, -(GOAL_MONTHS - 1))
  return earliest < start ? { from: start, capped: true } : { from: earliest, capped: false }
}
