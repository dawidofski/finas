import type { MonthlyBudget } from '../budget/month'
import type { MonthPoint } from '../analytics/series'
import type { SavingsGoalRow } from '../db/schema'
import { annotatedTransactions, type RegretCluster } from '../learning/regret'
import { liveTransactionsBetween } from '../analysis/transactionsInRange'
import { divRound, formatBp, formatEur } from '../lib/money'

/** A component is measured, or it is not; it is never a zero standing in for "unknown" (§13.3). */
export type Component =
  | { kind: 'measured'; score: number; inputs: string }   // score 0-100; `inputs` is the owner-facing arithmetic
  | { kind: 'not-measured'; why: string }                 // `why` names what is missing, in the owner's terms

const MIN_SAVINGS_MONTHS = 3
const BASELINE_WINDOW = 3
const MIN_IMPROVEMENT_MONTHS = BASELINE_WINDOW * 2
const POINTS_PER_100_BP = 5

const clamp = (n: number): number => Math.max(0, Math.min(100, n))
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * Share of allocations respected, weighted by allocation size, pooled over the completed months with data (one ratio over
 * all their lines, not an average of monthly scores). Left out: a month with `hasData` false (its lines come from the
 * allocations, so they exist with nothing spent and would all read as respected), a month still in progress
 * (`partial`: a part-month of spending against a whole month's allocation), and any line with no allocation (no ratio,
 * as varianceBp is null for the same reason). A category line is respected when spent does not exceed allocated; a
 * savings-goal line when it is met, spent not below allocated. The score is 100 only when every line was respected.
 */
export function budgetAwareness(months: readonly { budget: MonthlyBudget; hasData: boolean }[]): Component {
  // Two kinds of month are not evidence. A month with no records still has lines (they come from the allocations) with
  // nothing spent, so every one would read as respected. The month still in progress (`partial`) has only part of its
  // spending so far, almost always under a whole month's allocation, so it would read as respected before it has happened.
  const lines = months
    .filter((m) => m.hasData && !m.budget.partial)
    .flatMap((m) => m.budget.lines)
    .filter((l) => l.allocatedCents > 0)
  if (lines.length === 0) {
    return { kind: 'not-measured', why: 'No completed month with an allocation is recorded yet, so there is nothing to compare spending against.' }
  }
  let total = 0
  let respected = 0
  let respectedLines = 0
  for (const l of lines) {
    total += l.allocatedCents
    // A category is respected by spending no more than allocated; a savings goal by setting aside no less than planned.
    const met = l.targetKind === 'goal' ? l.spentCents >= l.allocatedCents : l.spentCents <= l.allocatedCents
    if (met) {
      respected += l.allocatedCents
      respectedLines += 1
    }
  }
  return {
    kind: 'measured',
    // 100 means every allocation was respected: rounding must not award it while one was not.
    score: clamp(respected < total ? Math.min(99, divRound(respected * 100, total)) : 100),
    inputs: `You respected ${respectedLines} of ${plural(lines.length, 'allocation')} in completed months, weighted by size: ${formatEur(respected)} of ${formatEur(total)} allocated.`,
  }
}

/** Proportion of months with data in which net savings were positive. A month with no records is not a month of no saving. */
export function savingsConsistency(points: readonly MonthPoint[]): Component {
  const observed = points.filter((p) => p.hasData)
  if (observed.length < MIN_SAVINGS_MONTHS) {
    return {
      kind: 'not-measured',
      why: `Not enough months recorded yet: this needs ${MIN_SAVINGS_MONTHS} and there ${observed.length === 1 ? 'is' : 'are'} ${observed.length}.`,
    }
  }
  const positive = observed.filter((p) => p.savedCents > 0).length
  return {
    kind: 'measured',
    score: clamp(divRound(positive * 100, observed.length)),
    inputs: `You saved something in ${positive} of ${plural(observed.length, 'recorded month')}.`,
  }
}

/** Mean discretionary share, in basis points, of a window of months that each have spending. */
function meanShareBp(window: readonly MonthPoint[]): number {
  let sum = 0
  for (const p of window) sum += divRound(p.discretionaryCents * 10000, p.spentCents)
  return divRound(sum, window.length)
}

/**
 * Trend in the discretionary share of spending against the owner's own trailing baseline: the mean share of the most
 * recent 3 months against the mean of the 3 before. A falling share is improvement; 50 is no change. Only months with
 * data and some spending have a share (a ratio needs a denominator), so only those count toward the 6 months needed.
 */
export function improvement(points: readonly MonthPoint[]): Component {
  const usable = points
    .filter((p) => p.hasData && p.spentCents > 0)
    .sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0))
  if (usable.length < MIN_IMPROVEMENT_MONTHS) {
    return {
      kind: 'not-measured',
      why: `Not enough months recorded yet: this compares the latest ${BASELINE_WINDOW} months with spending recorded against the ${BASELINE_WINDOW} earlier ones, so it needs ${MIN_IMPROVEMENT_MONTHS} and there ${usable.length === 1 ? 'is' : 'are'} ${usable.length}.`,
    }
  }
  const recent = usable.slice(-BASELINE_WINDOW)
  const prior = usable.slice(-MIN_IMPROVEMENT_MONTHS, -BASELINE_WINDOW)
  const recentBp = meanShareBp(recent)
  const priorBp = meanShareBp(prior)
  const gainBp = priorBp - recentBp // positive when the share fell
  return {
    kind: 'measured',
    score: clamp(50 + divRound(gainBp * POINTS_PER_100_BP, 100)),
    inputs: `Discretionary spending was ${formatBp(priorBp)} of your spending over the ${BASELINE_WINDOW} earlier months with spending recorded, and ${formatBp(recentBp)} over the latest ${BASELINE_WINDOW} such months. Months with no spending recorded are not counted.`,
  }
}

const MIN_SHARED_CLUSTERS = 2

/** `part` of `total` as whole points; 100 only when nothing is short, so rounding never awards a full score. */
const wholePoints = (part: number, total: number): number =>
  clamp(part < total ? Math.min(99, divRound(part * 100, total)) : 100)

/**
 * Share of the window's live bank transactions the owner has reviewed. Reviewed means the owner's own `reviewed` flag is
 * set; having an annotation row is not enough (a note alone is not a review). Not measured when the window has no
 * transactions, or when none has been touched at all: an untouched window would score 0, which says the owner
 * did nothing rather than that this has not started. The annotated rows come through `annotatedTransactions`, bounded by the
 * owner's own activity (§39.4); the denominator is a date-bounded read of the window, never the whole ledger.
 * `from` and `to` are inclusive 'YYYY-MM-DD'.
 */
export async function spendingAwareness(from: string, to: string): Promise<Component> {
  const inWindow = (valueDate: string): boolean => valueDate >= from && valueDate <= to
  const live = (await liveTransactionsBetween(from.slice(0, 7), to.slice(0, 7))).filter((t) => inWindow(t.valueDate))
  if (live.length === 0) {
    return { kind: 'not-measured', why: 'No transactions are recorded in this period, so there is nothing to have reviewed.' }
  }
  const liveIds = new Set(live.map((t) => t.id))
  const touched = (await annotatedTransactions(() => true)).filter((t) => liveIds.has(t.id))
  if (touched.length === 0) {
    return { kind: 'not-measured', why: 'None of the transactions in this period has been reviewed or annotated yet, so there is nothing to measure.' }
  }
  const reviewedIds = new Set((await annotatedTransactions((a) => a.reviewed)).map((t) => t.id))
  const reviewed = live.filter((t) => reviewedIds.has(t.id)).length
  return {
    kind: 'measured',
    score: wholePoints(reviewed, live.length),
    inputs: `You have reviewed ${reviewed} of ${plural(live.length, 'transaction')} in this period.`,
  }
}

/**
 * Progress against the owner's own goals, weighted by each goal's target: the share of the total target that belongs to
 * goals marked completed. The row records no amount set aside, so completion is the only progress it can state. An
 * archived goal that was never completed is one the owner put away, and is left out; a completed one still counts.
 * With no goal at all the owner has not set one: that is a different statement from making no progress, and the only
 * true one.
 */
export function goalProgress(goals: readonly SavingsGoalRow[]): Component {
  if (goals.length === 0) {
    return { kind: 'not-measured', why: 'You have not set a savings goal yet, so there is no goal to measure progress against.' }
  }
  const counted = goals.filter((g) => g.targetCents > 0 && (!g.archived || g.completedAt !== null))
  if (counted.length === 0) {
    return { kind: 'not-measured', why: 'None of your savings goals is active with a target, so there is no goal to measure progress against.' }
  }
  let total = 0
  let reached = 0
  let reachedGoals = 0
  for (const g of counted) {
    total += g.targetCents
    if (g.completedAt !== null) {
      reached += g.targetCents
      reachedGoals += 1
    }
  }
  return {
    kind: 'measured',
    score: wholePoints(reached, total),
    inputs: `You have reached ${reachedGoals} of ${plural(counted.length, 'savings goal')}, weighted by target: ${formatEur(reached)} of ${formatEur(total)}.`,
  }
}

/** Regret rate of a cluster in basis points; null when it holds no answered spend (no denominator). */
const regretRateBp = (c: RegretCluster): number | null => (c.total > 0 ? divRound(c.regretted * 10000, c.total) : null)

/**
 * Reduction in repeated regret within previously flagged clusters: of the clusters present in both windows (same
 * dimension and key), the share whose regret rate fell, late against early. Equal is not a fall. A cluster seen in only
 * one window has nothing to be compared with and is left out; fewer than 2 in both is too few to call a pattern.
 */
export function learning(early: readonly RegretCluster[], late: readonly RegretCluster[]): Component {
  const lateByKey = new Map(late.map((c) => [JSON.stringify([c.by, c.key]), c]))
  let shared = 0
  let fell = 0
  for (const e of early) {
    const l = lateByKey.get(JSON.stringify([e.by, e.key]))
    if (l === undefined) continue
    const before = regretRateBp(e)
    const after = regretRateBp(l)
    if (before === null || after === null) continue
    shared += 1
    if (after < before) fell += 1
  }
  if (shared < MIN_SHARED_CLUSTERS) {
    return {
      kind: 'not-measured',
      why: `Not enough repeated patterns yet: this compares the same pattern across two periods, so it needs ${MIN_SHARED_CLUSTERS} patterns in both and there ${shared === 1 ? 'is' : 'are'} ${shared}.`,
    }
  }
  return {
    kind: 'measured',
    score: wholePoints(fell, shared),
    inputs: `The share of spends you marked as not worth it fell in ${fell} of ${plural(shared, 'pattern')} that appear in both periods.`,
  }
}
