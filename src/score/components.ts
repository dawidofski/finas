import type { MonthlyBudget } from '../budget/month'
import type { MonthPoint } from '../analytics/series'
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
 * Share of allocations respected, weighted by allocation size, over every month given. A line is respected when spent
 * does not exceed allocated. A line with no allocation has no ratio (varianceBp is null for the same reason) and is left out.
 */
export function budgetAwareness(budgets: readonly MonthlyBudget[]): Component {
  const lines = budgets.flatMap((b) => b.lines).filter((l) => l.allocatedCents > 0)
  if (lines.length === 0) {
    return { kind: 'not-measured', why: 'No allocations have been set in the months recorded yet, so there is nothing to compare spending against.' }
  }
  let total = 0
  let respected = 0
  let respectedLines = 0
  for (const l of lines) {
    total += l.allocatedCents
    if (l.spentCents <= l.allocatedCents) {
      respected += l.allocatedCents
      respectedLines += 1
    }
  }
  return {
    kind: 'measured',
    score: clamp(divRound(respected * 100, total)),
    inputs: `You stayed within ${respectedLines} of ${plural(lines.length, 'allocation')}, weighted by size: ${formatEur(respected)} of ${formatEur(total)} allocated.`,
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
      why: `Not enough months recorded yet: this compares the last ${BASELINE_WINDOW} against the ${BASELINE_WINDOW} before them, so it needs ${MIN_IMPROVEMENT_MONTHS} and there ${usable.length === 1 ? 'is' : 'are'} ${usable.length}.`,
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
    inputs: `Discretionary spending was ${formatBp(priorBp)} of your spending over the ${BASELINE_WINDOW} months before, and ${formatBp(recentBp)} over the latest ${BASELINE_WINDOW}.`,
  }
}
