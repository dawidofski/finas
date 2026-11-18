import type { MonthlyBudget } from '../budget/month'
import type { MonthPoint } from '../analytics/series'
import type { SavingsGoalRow } from '../db/schema'
import type { GoalProgress } from '../goals/progress'
import { type RegretCluster } from '../learning/regret'
import { liveTransactionsBetween } from '../analysis/transactionsInRange'
import { loadCategoryKinds, worthAnnotating } from '../analysis/queues'
import { resolveMany } from '../db/annotations'
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
/** `part` of `total` as whole points; 100 only when nothing is short, so rounding never awards a full score. */
export function wholePoints(part: number, total: number): number {
  // 0 of 0 is no measurement, not a full score: every caller guards its denominator, and a missed guard must fail loudly.
  if (total <= 0) throw new RangeError('wholePoints needs a positive total')
  return clamp(part < total ? Math.min(99, divRound(part * 100, total)) : 100)
}
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * Share of allocations respected, weighted by allocation size, pooled over the completed months with data (one ratio over
 * all their lines, not an average of monthly scores). Left out: a month with `hasData` false (its lines come from the
 * allocations, so they exist with nothing spent and would all read as respected), a month still in progress
 * (`partial`: a part-month of spending against a whole month's allocation), and any line with no allocation (no ratio,
 * as varianceBp is null for the same reason; an archived or completed goal has one). The two kinds are respected in opposite
 * directions: a category line when what was spent does not exceed what was allocated, a savings-goal line when what was
 * set aside for it (its attributed savings, see monthlyBudget) reaches what was allocated. The score is 100 only when every
 * line was respected.
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
    // A category is respected by spending no more than allocated; a goal by setting aside at least what was allocated.
    if (l.targetKind === 'goal' ? l.spentCents >= l.allocatedCents : l.spentCents <= l.allocatedCents) {
      respected += l.allocatedCents
      respectedLines += 1
    }
  }
  return {
    kind: 'measured',
    // 100 means every allocation was respected: rounding must not award it while one was not.
    score: wholePoints(respected, total),
    inputs: `You respected ${respectedLines} of ${plural(lines.length, 'allocation')} in completed months, weighted by size: ${formatEur(respected)} of ${formatEur(total)} allocated. A spending allocation counts as respected when spending stayed within it; a savings goal counts as respected only when its full planned amount was set aside that month, so a month with no savings lowers this figure.`,
  }
}

/** Proportion of months with data in which the savings movements (`savedCents`, the amount moved into savings) were above zero. A month with no records is not a month of no saving. */
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
    score: wholePoints(positive, observed.length),
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
/** A pattern needs this many answered spends in each period before its rate is a rate (A2). */
const MIN_ANSWERED_SPENDS = 3

/**
 * Share of the transactions the app asks the owner to review that they have reviewed. The denominator is the window's live
 * bank transactions that `worthAnnotating` accepts, the same test the review queue applies: income, internal movements,
 * round-ups and essentials are never offered, so counting them would cap the score below 100 by rows the owner cannot act
 * on. Reviewed means the owner's own `reviewed` flag; an annotation row alone (a note) is not a review. Not measured when no
 * such transaction is in the window, or when none of them has been reviewed (a window with nothing reviewed would score 0,
 * which says the owner did nothing rather than that this has not started, and would make a note lower the score). The
 * window is a date-bounded read, never the whole ledger, and is by the bank's date, as the regret clusters are. `from` and `to` are inclusive 'YYYY-MM-DD'.
 */
export async function spendingAwareness(from: string, to: string): Promise<Component> {
  const live = (await liveTransactionsBetween(from.slice(0, 7), to.slice(0, 7))).filter((t) => t.valueDate >= from && t.valueDate <= to)
  const [resolved, kinds] = await Promise.all([resolveMany(live), loadCategoryKinds()])
  const eligible = resolved.filter((t) => worthAnnotating(t, kinds))
  if (eligible.length === 0) {
    return { kind: 'not-measured', why: 'No transactions in this period are ones the app asks you to review, so there is nothing to have reviewed.' }
  }
  const reviewed = eligible.filter((t) => t.reviewed).length
  // Measured only once something in the window has actually been reviewed. A note, or an annotation row left at its
  // defaults, is engagement and not a review: counting it would turn "not measured" into 0 out of 100 the moment the owner
  // touched anything, so using the app would lower the score.
  if (reviewed === 0) {
    return { kind: 'not-measured', why: 'Nothing in this period has been reviewed yet, so there is nothing to measure.' }
  }
  return {
    kind: 'measured',
    score: wholePoints(reviewed, eligible.length),
    inputs: `You have reviewed ${reviewed} of ${plural(eligible.length, 'transaction')} the app asks you to review in this period. Income, transfers between your accounts, round-ups and essentials are not counted.`,
  }
}

/**
 * Progress against the owner's own goals (§13.3), weighted by each goal's target: every active goal counts what has been
 * put toward it, up to its own target and no further, as a share of its target, and the shares are weighted by target (which
 * makes the score the sum of what is funded over the sum of the targets, so a big goal counts for more than a small one).
 * A goal marked completed counts as fully reached. An archived goal that was never completed is one the owner put away, and
 * is left out; a completed one still counts. The figures are the `progressOf` values the goals screen shows, passed in so the
 * two cannot disagree. With no goal at all the owner has not set one, which is a different statement from making no
 * progress; and while nothing has yet been put toward any goal there is no progress to measure, so that is not scored 0 either.
 */
export function goalProgress(goals: readonly { goal: SavingsGoalRow; progress: GoalProgress }[]): Component {
  if (goals.length === 0) {
    return { kind: 'not-measured', why: 'You have not set a savings goal yet, so there is no goal to measure progress against.' }
  }
  const counted = goals.filter(({ goal }) => goal.targetCents > 0 && (!goal.archived || goal.completedAt !== null))
  if (counted.length === 0) {
    return { kind: 'not-measured', why: 'None of your savings goals is active with a target, so there is no goal to measure progress against.' }
  }
  let total = 0
  let funded = 0
  let started = false
  for (const { goal, progress } of counted) {
    total += goal.targetCents
    const done = goal.completedAt !== null ? goal.targetCents : Math.min(goal.targetCents, Math.max(0, progress.contributedCents))
    funded += done
    if (done > 0) started = true
  }
  if (!started) {
    return { kind: 'not-measured', why: 'Nothing has been put toward your savings goals in a completed month yet, so there is no progress to measure.' }
  }
  return {
    kind: 'measured',
    score: wholePoints(funded, total),
    inputs: `Across ${plural(counted.length, 'savings goal')}, ${formatEur(funded)} of ${formatEur(total)} of the targets is funded, weighted by target. Each goal counts up to its own target, and a goal marked completed counts in full. Goals archived before they were completed are not counted.`,
  }
}

/**
 * Reduction in repeated regret within previously flagged clusters: of the clusters present in both windows (same
 * dimension and key) with at least 3 answered spends in each, the share whose regret rate fell, late against early. Equal
 * is not a fall. A cluster seen in only one window has nothing to be compared with and is left out, as is one with fewer
 * answered spends (a rate from 1 or 2 spends is not a pattern). The five dimensions overlap (one spend sits in up to five
 * clusters), so the clusters are not independent evidence; fewer than 2 is too few to call a pattern.
 *
 * The caller supplies each window with its zero-regret clusters kept (`regretClustersBetween`), so a pattern whose regret
 * fell to none is present in the later window with its answered spends and counts as a fall. A pattern with no answered
 * spends in a period is absent from it and has nothing to compare, so it is left out.
 */
export function learning(early: readonly RegretCluster[], late: readonly RegretCluster[]): Component {
  const lateByKey = new Map(late.map((c) => [JSON.stringify([c.by, c.key]), c]))
  let shared = 0
  let fell = 0
  for (const e of early) {
    const l = lateByKey.get(JSON.stringify([e.by, e.key]))
    if (l === undefined || e.total < MIN_ANSWERED_SPENDS || l.total < MIN_ANSWERED_SPENDS) continue
    shared += 1
    if (divRound(l.regretted * 10000, l.total) < divRound(e.regretted * 10000, e.total)) fell += 1
  }
  if (shared < MIN_SHARED_CLUSTERS) {
    return {
      kind: 'not-measured',
      why: `Not enough repeated patterns yet: this compares the same pattern across two periods, and only patterns with at least ${MIN_ANSWERED_SPENDS} answered spends in each. It needs ${MIN_SHARED_CLUSTERS} such patterns and there ${shared === 1 ? 'is' : 'are'} ${shared}.`,
    }
  }
  return {
    kind: 'measured',
    score: wholePoints(fell, shared),
    inputs: `In ${fell} of ${plural(shared, 'pattern')}, a smaller share of your spends was marked not worth it in the later period than in the earlier one. Only patterns with at least ${MIN_ANSWERED_SPENDS} answered spends in both periods are compared. Patterns overlap (one spend can belong to several), so they are not independent. A pattern with no answered spends in one of the periods has nothing to compare, so it is left out.`,
  }
}
