import { wholePoints, type Component } from './components'

export type ComponentId =
  | 'budget-awareness' | 'savings-consistency' | 'improvement'
  | 'spending-awareness' | 'goal-progress' | 'learning'

export interface ScoredComponent { id: ComponentId; label: string; weight: number; component: Component }

export interface MoneyScore {
  /** Null when no component could be measured: the score is withheld, never shown as 0 (§13.3). */
  score: number | null
  components: ScoredComponent[]
  /** The denominator actually used (the measured components' weights), so the screen can show the arithmetic. */
  weightUsed: number
}

/**
 * Plain integers summing to 14, not basis points: the measured set changes month to month and the denominator is the sum
 * of the measured weights, so renormalising integers is exact. No component may exceed a quarter of the total (the spec's
 * only constraint: no component can dominate); a test reads this table to hold that.
 */
export const WEIGHTS: Readonly<Record<ComponentId, number>> = {
  'budget-awareness': 3, 'savings-consistency': 3, 'improvement': 2,
  'spending-awareness': 2, 'goal-progress': 2, 'learning': 2,
}

/** Owner-facing names: what is looked at, in neutral terms. Order is the order the screen shows them. */
const LABELS: Readonly<Record<ComponentId, string>> = {
  'budget-awareness': 'Budget awareness',
  'savings-consistency': 'Savings consistency',
  'improvement': 'Discretionary share over time',
  'spending-awareness': 'Spending review',
  'goal-progress': 'Goal progress',
  'learning': 'Repeated regrets',
}

const ORDER: readonly ComponentId[] = [
  'budget-awareness', 'savings-consistency', 'improvement', 'spending-awareness', 'goal-progress', 'learning',
]

/**
 * Weighted mean of the measured components only, renormalised: the denominator is the sum of the measured weights, not
 * the full total. Not-measured components are left out of the arithmetic, never counted as 0. With none measured the score
 * is null and weightUsed is 0 (a 0 out of 100 would tell the owner they are failing at something never measured).
 * The cap is wholePoints's: 100 only when every measured component scored 100, so rounding never conceals a shortfall (99 and five
 * 100s is 99, not 100). The guard for nothing measured must stay before that call, which throws on a zero total.
 * No runtime validation of the record is deliberate: callers are typed, and a missing id fails at the call site.
 * Every component stays in `components` so the screen can show all six.
 */
export function moneyScore(components: Readonly<Record<ComponentId, Component>>): MoneyScore {
  const scored: ScoredComponent[] = ORDER.map((id) => ({ id, label: LABELS[id], weight: WEIGHTS[id], component: components[id] }))
  let weightUsed = 0
  let weighted = 0
  for (const s of scored) {
    if (s.component.kind !== 'measured') continue
    weightUsed += s.weight
    weighted += s.weight * s.component.score
  }
  return { score: weightUsed === 0 ? null : wholePoints(weighted, weightUsed * 100), components: scored, weightUsed }
}
