/**
 * The declared battery: the ten relationships of spec §12, each with the minimum data it needs. Pure data plus pure
 * gate functions; it reads no database. `BatteryData` is gathered once by the screen and handed in. Gates are
 * inclusive: "at least 30" means 30 runs and 29 does not.
 */
export type RelationshipId =
  | 'mood-amount' | 'mood-frequency' | 'stress-discretionary' | 'boredom-impulse'
  | 'reason-worthwhile' | 'weekend' | 'payday' | 'small-purchases'
  | 'salary-lifestyle' | 'category-savings'

/** `what` is owner-facing: it says what is missing and how much more is needed, never a guess. */
export interface Gate { have: number; need: number; what: string }

/** Every count §12's minimum-data column asks about, gathered once so each gate stays pure. */
export interface BatteryData {
  discretionarySpendsWithMood: number
  moodGroupsOfTen: number           // mood groups holding at least ten spends
  weeksOfMoodCoverage: number
  stressedSpends: number
  unstressedSpends: number
  impulseTaggedSpends: number
  spendsWithReasonAndWorthwhile: number
  weekendsObserved: number
  incomeEvents: number
  fullMonths: number
  incomeLevelsWithTwoMonths: number
  monthsObserved: number
}

export interface Relationship {
  id: RelationshipId
  question: string          // owner-facing, no jargon, no causal wording
  /** The named test from §12, or null where §12 says there is none. */
  test: string | null
  gates: (data: BatteryData) => Gate[]
}

export const isMet = (g: Gate): boolean => g.have >= g.need

/** Builds a gate whose wording states what the app has, what it needs, and how many more are missing. */
function gate(have: number, need: number, subject: string, unit: string, units: string): Gate {
  const missing = need - have
  const what = have >= need
    ? `You have enough ${subject}: ${have} where ${need} ${need === 1 ? 'is' : 'are'} needed.`
    : `The app needs ${need} ${subject} before it can look at this. You have ${have}, so ${missing} more ${missing === 1 ? `${unit} is` : `${units} are`} needed.`
  return { have, need, what }
}

export const BATTERY: readonly Relationship[] = [
  {
    id: 'mood-amount',
    question: 'Does the amount you spend on a purchase go up or down with your mood?',
    test: 'Spearman rank correlation of mood against amount',
    gates: d => [
      gate(d.discretionarySpendsWithMood, 30, 'discretionary purchases with a mood recorded', 'purchase', 'purchases'),
      gate(d.moodGroupsOfTen, 2, 'moods that each have at least 10 purchases', 'mood', 'moods'),
    ],
  },
  {
    id: 'mood-frequency',
    question: 'Do you make more purchases on some kinds of mood days than on others?',
    // NOT a Poisson rate test: purchases cluster (one shopping trip is several transactions), so the Poisson
    // shape does not hold. src/battery/trend.ts says the same in capitals over moodFrequency, which is what runs.
    test: 'Mann-Whitney U on weekly purchase counts, low-mood weeks against good-mood weeks',
    gates: d => [gate(d.weeksOfMoodCoverage, 8, 'weeks with a mood recorded', 'week', 'weeks')],
  },
  {
    id: 'stress-discretionary',
    question: 'Is a larger share of your spending discretionary when you are stressed?',
    test: 'Mann-Whitney U',
    gates: d => [
      gate(d.stressedSpends, 10, 'purchases made while stressed', 'purchase', 'purchases'),
      gate(d.unstressedSpends, 10, 'purchases made while not stressed', 'purchase', 'purchases'),
    ],
  },
  {
    id: 'boredom-impulse',
    question: 'Are the purchases you tag as impulse buys more common when you are bored?',
    test: 'Chi-square',
    gates: d => [gate(d.impulseTaggedSpends, 20, 'purchases tagged as impulse buys', 'purchase', 'purchases')],
  },
  {
    id: 'reason-worthwhile',
    question: 'Do the reasons you give for a purchase go with how worthwhile it felt afterwards?',
    test: "Chi-square with Cramer's V",
    gates: d => [gate(d.spendsWithReasonAndWorthwhile, 30, 'purchases with both a reason and a worthwhile rating', 'purchase', 'purchases')],
  },
  {
    id: 'weekend',
    question: 'Do you spend differently at weekends than on weekdays?',
    test: 'Mann-Whitney U',
    gates: d => [gate(d.weekendsObserved, 8, 'weekends of recorded spending', 'weekend', 'weekends')],
  },
  {
    id: 'payday',
    question: 'Does your daily spending change in the days after payday?',
    test: 'Spearman rank correlation of days since income against daily spend',
    gates: d => [gate(d.incomeEvents, 3, 'payments received', 'payment', 'payments')],
  },
  {
    id: 'small-purchases',
    question: 'How much do your small purchases add up to over a month?',
    test: null, // §12: "Descriptive aggregation, no test". The figure is `smallPurchases` in src/analytics/habits.ts.
    // 'complete month' is singular because `need` here is literally 1: the subject phrase is written
    // out, not pluralised by the helper, so the author has to match it to the number beside it. The
    // agreement test below is what catches the next one of these.
    gates: d => [gate(d.fullMonths, 1, 'complete month of spending', 'month', 'months')],
  },
  {
    id: 'salary-lifestyle',
    question: 'When your income steps up or down, does the share you spend on wants change with it?',
    // §12 words this "paired comparison", but what runs is mannWhitneyU over two DISJOINT groups of months
    // (src/battery/trend.ts salaryLifestyle), which is the independent-samples test. Nothing here is paired, so the
    // declaration says what the statistic actually claims.
    test: 'Mann-Whitney U on monthly discretionary share, higher income levels against lower',
    gates: d => [gate(d.incomeLevelsWithTwoMonths, 2, 'income levels that each last at least 2 months', 'income level', 'income levels')],
  },
  {
    id: 'category-savings',
    question: 'Do the categories you spend in go with how much you manage to save?',
    test: 'Spearman rank correlation',
    gates: d => [gate(d.monthsObserved, 4, 'months of spending', 'month', 'months')],
  },
]
