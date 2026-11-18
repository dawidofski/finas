import { addDays, monthKeyOf } from '../lib/dates'
import type { RelationshipId } from './battery'
import { benjaminiHochberg, type Corrected } from './correction'
import { boredomImpulse, reasonWorthwhile, type ContingencyOutcome } from './contingency'
import type { Bracket } from './critical'
import { moodAmount, stressDiscretionary, weekend, type RankResult } from './rank'
import {
  categorySavings, moodFrequency, paydayTrend, salaryLifestyle,
  type CategorySavings, type CategorySavingsResult, type MoodFrequencyResult, type TrendResult,
} from './trend'

/**
 * Running the battery and deciding which results are held against one another. Two consumers need exactly the same
 * answer to "which comparisons were made, and which of them survived": the Intelligence screen, which shows the findings,
 * and the advice module, which acts on them. If each kept its own copy of the entry rule the two would drift, and the
 * owner would be given advice the screen beside it calls "not a finding". So the rule lives here and nowhere else.
 *
 * THE ENTRY RULE. Only a validly TESTED relationship enters the correction, because Benjamini-Hochberg's m is the number
 * of hypotheses tested. An unmet gate was never tested; a sparse or oversized contingency table was not validly tested
 * (the assumption its certainty rests on failed), and a withheld one had nothing to test; the small purchases are a count
 * and §12 gives them no test. A result that WAS tested and came back 'none' DOES count: it was looked at and came back
 * unremarkable, and dropping it would shrink m and loosen the bar for everything else.
 */

/**
 * The months the battery reads over. Twelve is the shortest window that can hold what the longest gates ask for —
 * four months of spending for the category comparison, two income levels of two months each — while still being a
 * bounded read (§39.4) rather than the whole ledger.
 */
export const WINDOW_MONTHS = 12

export const previousMonth = (month: string): string => monthKeyOf(addDays(`${month}-01`, -1))

export function windowOf(month: string): { from: string; to: string } {
  let from = month
  for (let i = 1; i < WINDOW_MONTHS; i++) from = previousMonth(from)
  return { from, to: month }
}

/** Nine of the ten relationships' results. The tenth, the small purchases, is a count with no test and has none. */
export interface BatteryReads {
  mood: RankResult
  frequency: MoodFrequencyResult
  stress: RankResult
  boredom: ContingencyOutcome
  reasons: ContingencyOutcome
  week: RankResult
  payday: TrendResult
  salary: TrendResult
  savings: CategorySavingsResult
}

/** The nine reads, together, each through the analytics cache. */
export async function readBattery(today: string, computedAt: number): Promise<BatteryReads> {
  const { from, to } = windowOf(today.slice(0, 7))
  const [mood, frequency, stress, boredom, reasons, week, payday, salary, savings] = await Promise.all([
    moodAmount(computedAt),
    moodFrequency(computedAt, today),
    stressDiscretionary(computedAt),
    boredomImpulse(computedAt),
    reasonWorthwhile(computedAt),
    weekend(from, to, computedAt),
    paydayTrend(from, to, today, computedAt),
    salaryLifestyle(from, to, today, computedAt),
    categorySavings(from, to, today, computedAt),
  ])
  return { mood, frequency, stress, boredom, reasons, week, payday, salary, savings }
}

/** A contingency outcome: gated, withheld, sparse and too-many-categories were none of them validly tested. */
export const contingencyBracket = (o: ContingencyOutcome): Bracket | null =>
  Array.isArray(o) || 'withheld' in o || o.verdict !== 'tested' ? null : o.bracket

/** Category -> savings reports the strongest category, so its certainty is that category's bracket; no category at all is a tested 'none'. */
export const savingsBracket = (s: CategorySavings): Bracket => s.categories[0]?.bracket ?? 'none'

/** Every comparison that was validly made, with its bracket: the input to the correction. */
export function enteredBrackets(r: BatteryReads): { item: RelationshipId; bracket: Bracket }[] {
  const out: { item: RelationshipId; bracket: Bracket }[] = []
  const add = (item: RelationshipId, bracket: Bracket | null): void => { if (bracket !== null) out.push({ item, bracket }) }
  // A rank, trend or mood-frequency result that is an array is the list of unmet gates: nothing was tested.
  add('mood-amount', Array.isArray(r.mood) ? null : r.mood.bracket)
  add('mood-frequency', Array.isArray(r.frequency) ? null : r.frequency.bracket)
  add('stress-discretionary', Array.isArray(r.stress) ? null : r.stress.bracket)
  add('boredom-impulse', contingencyBracket(r.boredom))
  add('reason-worthwhile', contingencyBracket(r.reasons))
  add('weekend', Array.isArray(r.week) ? null : r.week.bracket)
  add('payday', Array.isArray(r.payday) ? null : r.payday.bracket)
  add('salary-lifestyle', Array.isArray(r.salary) ? null : r.salary.bracket)
  add('category-savings', Array.isArray(r.savings) ? null : savingsBracket(r.savings))
  return out
}

/** Benjamini-Hochberg over the comparisons that were made, as a lookup by relationship. */
export function correct(judged: readonly { item: RelationshipId; bracket: Bracket }[]): {
  verdicts: Map<RelationshipId, Corrected<RelationshipId>>
  thresholdBp: number | null
  tested: number
} {
  const { results, thresholdBp, tested } = benjaminiHochberg(judged)
  return { verdicts: new Map(results.map((c) => [c.item, c])), thresholdBp, tested }
}
