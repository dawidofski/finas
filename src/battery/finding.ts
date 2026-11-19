import { addDays, formatMonthTitle, formatSpanishDate } from '../lib/dates'
import { formatBp, formatEur, percentBpOf } from '../lib/money'
import { nextMonthStart } from '../analysis/transactionsInRange'
import type { SmallPurchases } from '../analytics/habits'
import type { RelationshipId } from './battery'
import type { Bracket } from './critical'
import type { Corrected } from './correction'
import type { RankFinding } from './rank'
import type { CategorySavings, MoodFrequencyFinding, TrendFinding } from './trend'
import type { ContingencyResult, ContingencyRow } from './contingency'

/**
 * §12's eight fields, in the words a person reads about their own money. This is the ONE place the battery's wording
 * lives, and nothing here computes a statistic: it is handed a result and says what it means in plain language.
 *
 * WHAT IS DELIBERATELY NOT HERE.
 *
 * - The `test` field of BATTERY is never rendered. A finding names what was compared, never what compared it. "Your
 *   mood and the size of a purchase moved together", not "a Spearman rank correlation". finding.test.ts derives the
 *   banned words from BATTERY's own `test` strings, so a relationship added later brings its test name under the rule.
 *
 * - No causal language and no statistical jargon. Both lists are owned by src/ui/screens/Reports.test.tsx and
 *   src/learning/categorise.test.ts; finding.test.ts READS those two lines rather than restating them, because a third
 *   copy of a rule is how the first two drift apart.
 *
 * - No p-value, no percentage of confidence, no digit at all in `confidence`. A rung is said in words. The brackets
 *   are upper bounds standing in for a p this application never computes (critical.ts), so printing one as a figure
 *   would be precision the arithmetic does not have.
 *
 * A GATE AND A BRACKET ARE DIFFERENT THINGS, and a third thing decides the sentence as well:
 *   the GATE (battery.ts) decides whether a figure may be shown at all — unmet gates never reach this module;
 *   the BRACKET decides whether the figure may be called a finding;
 *   `survives` (correction.ts) decides whether it still stands once all ten comparisons are counted together.
 * A real effect beside `bracket: 'none'` is ordinary and is worded "not certain yet" — NEVER "no effect".
 *
 * TWO FIELDS CARRY THE WEIGHT. `limitation` must name the actual limit — how few observations, which subset of
 * spending, what the measure cannot tell apart, what it is conditioned on. "This may not be accurate" tells the owner
 * nothing they can act on and teaches them to skip the field, so finding.test.ts fails any limitation that reads like
 * one and any that counts nothing. `action` must be something the app can do TODAY: five of the fourteen screens are
 * stubs (Learning, AI coach, Goals, Recurring, Money Score), and the test reads that list out of the router rather
 * than trusting this comment. Where an action can be a thing to do in the owner's own life rather than a tap, it is.
 *
 * No float: every figure arrives in integer cents or basis points and is rendered with formatEur, formatBp or
 * percentBpOf from src/lib/money.ts. There is no second formatter here.
 */
/**
 * What ONE observation is for a relationship, so the count beside it can be labelled rather than guessed at.
 *
 * §12 calls the count "the number of transactions analysed" and for six of the ten it is exactly that, but
 * mood -> frequency counts weeks, days-after-payday counts single days, and both month-walking relationships count
 * months. The template is the only place that knows which, so it says so in a field: a screen that had to read the
 * unit out of the limitation's prose would be inferring it, and a screen that labelled the count "transactions"
 * would be stating something false four times in ten.
 */
export type Observation = 'purchases' | 'weeks' | 'days' | 'months'

/**
 * WHAT AN EFFECT FIGURE IS, declared by the template rather than guessed at from its size.
 *
 * Every effect leaves here as basis points, which makes three different quantities look alike, and rendering all
 * three as a percentage made two of them claim things the arithmetic does not support:
 *
 *   'percent'    a genuine proportion: Cramer's V, Kerby's rank-biserial r (the net share of compared pairs that
 *                went one way), and the small purchases' share of a month's spending. "42 %" is honest.
 *   'points'     a DIFFERENCE of two shares — stress -> discretionary is literally one share minus the other, so it
 *                is percentage POINTS. "18,5 % more of them" reads as relative, which is a different and smaller
 *                claim: 40 % against 58,5 % is 18,5 points apart and about 46 % more, so the percentage reading
 *                understates it by more than half.
 *   'closeness'  a CORRELATION. Spearman's rho is not a percentage of anything at all; 0.42 is not "42 %" of
 *                anything the owner could count. It reads as a closeness on a stated scale or not at all.
 *
 * A closed union, so a relationship added later cannot inherit the wrong one by omission, and finding.test.ts pins
 * the scale each of the ten declares — the same reason `unit` exists and is pinned the same way.
 */
export type Scale = 'percent' | 'points' | 'closeness'

export interface Finding {
  id: RelationshipId
  pattern: string
  /** Observations the figure was computed from. `unit` says what one of them is; `limitation` also names it in words. */
  transactions: number
  /** The ninth field, and not one of §12's eight: what `transactions` counts. */
  unit: Observation
  period: string
  effect: { label: string; bp: number; scale: Scale }
  /** The bracket in plain words, never a number. */
  confidence: string
  limitation: string
  meaning: string
  action: string
}

/** What benjaminiHochberg said about this relationship. Taken from `Corrected<T>` so the two cannot drift. */
export type CorrectionVerdict = Pick<Corrected<unknown>, 'bracket' | 'survives'>

/**
 * §12 asks for no test on the small purchases, so there is no result object: the figure is `smallPurchases` from
 * src/analytics/habits.ts plus the scope it was taken over. `monthSpendCents` is the month's whole spending, which the
 * screen already holds, and is what makes the small total a SHARE rather than a bare sum — the one effect size a
 * descriptive aggregation can honestly carry.
 */
export interface SmallPurchasesContext {
  small: SmallPurchases
  month: string
  ceilingCents: number
  monthSpendCents: number
}

/**
 * The result each relationship hands in. A key missing here makes TEMPLATES fail to type-check.
 *
 * All four result modules report their own `period`, and for NINE of the ten that is the period reported: the module
 * that built the figure is the only code that knows which bank dates its data actually spans, while the caller is the
 * screen, which knows only the window it ASKED for. Echoing a request back would claim months the owner may have no
 * records in, and it would do so worst where the records are thinnest.
 *
 * THE ONE EXCEPTION is the small purchases, whose period IS built here, from the `month` the caller names. §12 gives
 * that relationship no test and `SmallPurchases` carries no dates, so its scope is a month key and the two ends of
 * that month are its honest period — and a month key cannot overstate coverage the way a multi-month window can,
 * since the caller only ever names a month it has already found records in. finding.test.ts skips it for that reason
 * and says so at the skip.
 */
export interface BatteryResults {
  'mood-amount': RankFinding
  'mood-frequency': MoodFrequencyFinding
  'stress-discretionary': RankFinding
  'boredom-impulse': ContingencyResult
  'reason-worthwhile': ContingencyResult
  weekend: RankFinding
  payday: TrendFinding
  'small-purchases': SmallPurchasesContext
  'salary-lifestyle': TrendFinding
  'category-savings': CategorySavings
}

interface Parts {
  pattern: string
  transactions: number
  unit: Observation
  period: { from: string; to: string }
  effect: { label: string; bp: number; scale: Scale }
  limitation: string
  meaning: string
  action: string
  /** Set only where the bracket is NOT what the owner should be told: a table no test was run on, or a plain count. */
  confidence?: string
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/

/**
 * `period` is `{ from, to }` as 'YYYY-MM-DD' bank dates in every module, so one formatter serves all ten. An empty or
 * malformed end says so rather than throwing: formatSpanishDate rejects a non-date, and an exception raised here would
 * land on a screen the owner merely opened.
 */
function periodText(period: { from: string; to: string }): string {
  if (!ISO_DAY.test(period.from) || !ISO_DAY.test(period.to)) return 'No dates recorded yet'
  return `${formatSpanishDate(period.from)} to ${formatSpanishDate(period.to)}`
}

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/**
 * The figure out of formatBp without its per-cent sign. formatBp is the repository's only basis-point formatter and
 * the only code that gets the fractional digit right, so the two non-percentage scales reuse it and drop the sign
 * rather than a second formatter being written beside it.
 */
const bareFigure = (bp: number): string => formatBp(bp).replace(' %', '')

/**
 * An effect figure in words, and the ONLY place that happens: both this module's own prose and the screen call it, so
 * the scale cannot be honoured in one and guessed at in the other. A correlation gets its scale spelled out, because
 * a bare number against "how closely these moved together" invites being read as a percentage, which is the reading
 * this function exists to stop.
 */
export function formatEffect(effect: { bp: number; scale: Scale }): string {
  if (effect.scale === 'percent') return formatBp(effect.bp)
  if (effect.scale === 'points') return `${bareFigure(effect.bp)} percentage points`
  return `${bareFigure(effect.bp)} out of 100, where 100 would be moving together perfectly, 0 not at all, and -100 perfectly the opposite way`
}

const rowTotal = (row: ContingencyRow): number => row.counts[0] + row.counts[1]

/**
 * Two removed purchase reasons both read 'Removed reason' (src/learning/regret.ts keeps them as separate clusters,
 * which is right: the purchases tagged with each still happened). The counts tell them apart and the name does not, so
 * the wording says so instead of presenting two different answers as one.
 */
function sharedLabelClause(rows: readonly ContingencyRow[]): string {
  const seen = new Map<string, number>()
  for (const row of rows) seen.set(row.label, (seen.get(row.label) ?? 0) + 1)
  return [...seen.entries()]
    .filter(([, n]) => n > 1)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([label, n]) => ` ${n} of the rows carry the same name, ${label}: they are ${n} different answers of yours, kept apart in the counts but not in their names.`)
    .join('')
}

/**
 * Category -> savings reports the STRONGEST of however many categories were compared, so the sentence has to say how
 * many that was: the battery's correction runs across the ten relationships and sees one bracket from this one, which
 * leaves the search inside it uncorrected. Naming the number is what lets the owner discount it themselves. With one
 * category there was no search to discount, and with none there was nothing to compare, so neither claims otherwise.
 */
function searchClause(compared: number, label: string | undefined): string {
  if (compared === 0 || label === undefined) return 'No category moved enough from month to month to be compared at all.'
  if (compared === 1) return `${label} is the only category your spending moved in from month to month, so nothing was picked out of a field of them.`
  return `${label} is the strongest of ${count(compared, 'category', 'categories')} compared, and picking the strongest of several is itself a comparison: a figure found that way reads as more certain than one you had gone looking for on its own, and the more categories you spend in, the more it overstates.`
}

/** The row with the smallest share in the first column, compared by cross-multiplication so no division is needed. */
function lowestFirstColumn(rows: readonly ContingencyRow[]): ContingencyRow | undefined {
  let lowest: ContingencyRow | undefined
  for (const row of rows) {
    if (lowest === undefined) { lowest = row; continue }
    if (row.counts[0] * rowTotal(lowest) < lowest.counts[0] * rowTotal(row)) lowest = row
  }
  return lowest
}

/**
 * A contingency result carries `verdict`, and the caller must read it rather than the bracket: 'sparse' and
 * 'too-many-categories' both carry a real vBp beside `bracket: 'none'` AS A PLACEHOLDER. Letting either produce the
 * sentence a genuine 'none' produces would tell the owner their answers do not go together when the truth is that the
 * app declined to look, which is the one thing on this screen that would be a lie rather than a limit.
 */
function verdictWords(
  result: ContingencyResult,
  tested: { meaning: string; action: string },
  untested: { sparseAction: string; tooManyAction: string },
): { meaning: string; action: string; confidence?: string } {
  const held = 'The strength figure here is a hint about where to look and nothing more'
  const neither = 'It has not said your answers go together, and it has not said they do not.'
  if (result.verdict === 'sparse') {
    return {
      confidence: 'Some corners of this comparison hold too few of your answers for the app to say how certain it is, so it did not judge. The strength figure stands; the certainty behind it is not known.',
      meaning: `${held}: too few of your answers fall in some corners of the comparison for the app to judge it. ${neither}`,
      action: untested.sparseAction,
    }
  }
  if (result.verdict === 'too-many-categories') {
    return {
      confidence: 'You have recorded more different answers here than this comparison can weigh at once, so the app did not judge how certain it is rather than judge it wrongly. The strength figure stands; the certainty behind it is not known.',
      meaning: `${held}: there are more different answers here than this comparison can weigh at once, so the app has not judged it. ${neither}`,
      action: untested.tooManyAction,
    }
  }
  return tested
}

/**
 * Cramer's V FLOORS (stats.ts: at most a basis point low, never high). The honest word for that is "rounded down",
 * not "at least": a floor is a rounding fact, and "at least" reads as a statement about certainty, which is the one
 * distinction the contingency module exists to keep separate. Spearman's rho is correctly ROUNDED, so it gets no such
 * clause at all — one phrasing must not serve both.
 */
const FLOORED_STRENGTH = 'The strength figure is rounded down, so it is never larger than what your own answers show.'

const TEMPLATES: { [K in RelationshipId]: (result: BatteryResults[K]) => Parts } = {
  // rank.ts moodAmount: x = mood valence, y = money out, so a POSITIVE rho means happier moods went with larger
  // purchases. Discretionary purchases only — fixed essentials cannot plausibly move with a mood, so they are left out
  // on purpose, and the honest sentence is therefore narrower than "what you spend".
  'mood-amount': (r) => ({
    pattern: r.effectBp > 0
      ? 'On the discretionary purchases you gave a mood to, the happier the mood you recorded, the larger the purchase tended to be.'
      : r.effectBp < 0
        ? 'On the discretionary purchases you gave a mood to, the lower the mood you recorded, the larger the purchase tended to be.'
        : 'The discretionary purchases you gave a mood to came to much the same size whichever mood you recorded.',
    transactions: r.n,
    unit: 'purchases',
    period: r.period,
    effect: { label: 'How closely the mood you recorded and the size of a discretionary purchase moved together', bp: r.effectBp, scale: 'closeness' },
    limitation: `This is ${count(r.n, 'discretionary purchase', 'discretionary purchases')} you gave a mood to. Rent, bills and the other fixed essentials are left out on purpose, as they cannot move with a mood, and a purchase you gave no mood to is not here at all: these are the purchases you chose to annotate, not everything you spent.`,
    meaning: 'One reading is that how you feel and what a want seems worth travel together in the moment of buying. Another is that the purchases you stop to annotate are the ones you already felt something about, which would look the same from here.',
    action: 'Next time you are about to buy something you want rather than need, note how the day is going on the Dashboard first, and give it an hour before you decide.',
  }),

  // trend.ts moodFrequency: a = the LOW-mood weeks, so a POSITIVE r means more purchases in weeks of low mood. A mood
  // exists only as an annotation on a purchase, so a week with no purchases has no mood and can be on neither side:
  // the wording is "in weeks when you recorded feeling low", never "when you are low". Tied weeks are counted nowhere
  // and have to be accounted for to the owner.
  'mood-frequency': (r) => ({
    pattern: r.effectBp > 0
      ? 'In the weeks when most of what you recorded was feeling low, you gave a mood to more purchases than in the weeks when most of it was feeling good.'
      : r.effectBp < 0
        ? 'In the weeks when most of what you recorded was feeling good, you gave a mood to more purchases than in the weeks when most of it was feeling low.'
        : 'You gave a mood to about as many purchases in the weeks when most of what you recorded was feeling low as in the weeks when most of it was feeling good.',
    transactions: r.n,
    unit: 'weeks',
    period: r.period,
    effect: { label: 'How far apart the two kinds of week were in the number of purchases they held', bp: r.effectBp, scale: 'percent' },
    limitation: `This is ${count(r.n, 'week', 'weeks')} of records rather than a count of purchases: ${count(r.lowMood.weeks, 'week', 'weeks')} of mostly low mood holding ${count(r.lowMood.purchases, 'purchase', 'purchases')}, against ${count(r.goodMood.weeks, 'week', 'weeks')} of mostly good mood holding ${count(r.goodMood.purchases, 'purchase', 'purchases')}, and it leaves out ${count(r.tiedWeeks, 'week', 'weeks')} that held as many of one as of the other. A week counts only the purchases you gave a mood to and not everything you bought in it, so a week of twenty purchases with a mood on three of them counts as three. A mood lives here only as a note on a purchase, so a week you bought nothing in has no mood and is counted nowhere: these are weeks when you recorded feeling something while buying, and not weeks of your life.`,
    meaning: 'One reading is that a low week is a week of more small trips to buy something. Another is that a low week is a week you open the app more often, which would put a mood on more purchases and look the same from here.',
    action: 'In a week you have already noticed feels low, keep one list instead of buying as each thing comes to mind, and do a single shop at the end of it.',
  }),

  // rank.ts stressDiscretionary: a = the STRESSED spends, so a POSITIVE r means spending shifted TOWARD discretionary.
  // With two values (1 for a want, 0 for a need) Kerby's r is exactly the difference in discretionary SHARE between
  // the groups, which is why it can be spelled as a percentage here and why the sentence must never claim purchases
  // got bigger: it is a share, not an amount.
  'stress-discretionary': (r) => {
    // The figure is one share MINUS the other, so it is percentage points and is worded as points. "18,5 % more of
    // them" would read as relative — 40 % against 58,5 % is 18,5 points apart but about 46 % more — and the relative
    // reading is the smaller claim, so saying it that way would understate the owner's own figure by more than half.
    const gap = formatEffect({ bp: Math.abs(r.effectBp), scale: 'points' })
    return {
      pattern: r.effectBp > 0
        ? `The share of your purchases that went on wants rather than needs was ${gap} higher among the ones you recorded while stressed than among the ones you recorded while not stressed.`
        : r.effectBp < 0
          ? `The share of your purchases that went on wants rather than needs was ${gap} lower among the ones you recorded while stressed than among the ones you recorded while not stressed.`
          : 'The same share of your purchases went on wants rather than needs whether or not you recorded feeling stressed.',
      transactions: r.n,
      unit: 'purchases',
      period: r.period,
      effect: { label: 'The gap in the share of purchases that went on wants rather than needs', bp: r.effectBp, scale: 'points' },
      limitation: `This is a share and not an amount: across ${count(r.n, 'purchase', 'purchases')} it says which way your spending leaned and nothing at all about how much each one came to. Only the purchases you gave a mood to and sorted into wants or needs are counted, so an uncategorised one is in neither group, and these are the purchases you chose to annotate rather than everything you spent.`,
      meaning: 'One reading is that a stressed hour is an hour when a want feels like a need. Another is that the hours you record as stressed are your busiest, when a want is whatever is nearest to hand.',
      action: 'Name the one want you reach for when stressed, the coffee or the takeaway, and settle now on what you would rather do instead, so the choice is already made the next time.',
    }
  },

  // contingency.ts boredomImpulse: bored against any other mood, impulse-tagged against any other reason. Read
  // `verdict`, not `bracket`: a sparse table carries a placeholder 'none'.
  'boredom-impulse': (r) => {
    const bored = r.rows[0]
    const other = r.rows[1]
    const tag = r.columns[0].toLowerCase()
    return {
      pattern: bored === undefined || other === undefined
        ? 'There were not two groups of purchases here to set beside one another.'
        : `Of the ${count(rowTotal(bored), 'purchase', 'purchases')} you recorded while ${bored.label.toLowerCase()}, ${bored.counts[0]} carried the ${tag} tag; of the ${count(rowTotal(other), 'purchase', 'purchases')} you recorded in ${other.label.toLowerCase()}, ${other.counts[0]} did.`,
      transactions: r.n,
      unit: 'purchases',
      period: r.period,
      effect: { label: 'How strongly the mood you recorded and the tag you gave a purchase went together', bp: r.vBp, scale: 'percent' },
      limitation: `This covers ${count(r.n, 'purchase', 'purchases')} that carry both a mood and a reason. ${FLOORED_STRENGTH} It also cannot tell apart a purchase that felt like an impulse at the time from one you tagged that way afterwards.`,
      ...verdictWords(r, {
        meaning: 'One reading is that an empty hour and a quick purchase keep each other company. Another is that boredom is the mood you are readiest to admit to on a purchase you have already tagged that way.',
        action: 'When you next notice you are bored and reaching for your phone, put the one thing you were about to buy on a list for tomorrow instead.',
      }, {
        sparseAction: 'Open a few more purchases from your Transactions list and give each one a mood and a reason; the thin corners of this comparison need filling in before it can be judged.',
        tooManyAction: 'Keep to the few moods and reasons that really describe how you buy, rather than reaching for a new one each time.',
      }),
    }
  },

  // contingency.ts reasonWorthwhile: each reason against worthwhile / not worthwhile. The row named is the one you
  // were least often glad about, which is the row worth acting on; a label two removed reasons share is flagged as
  // shared rather than quietly presented as one answer.
  'reason-worthwhile': (r) => {
    const worst = lowestFirstColumn(r.rows)
    const shared = r.rows.filter((row) => worst !== undefined && row.label === worst.label).length
    const name = worst === undefined ? '' : shared > 1 ? `${worst.label} (one of ${shared} rows reading the same way)` : worst.label
    return {
      pattern: worst === undefined
        ? 'There were no answered purchases here to set beside one another.'
        : `Across ${count(r.n, 'purchase', 'purchases')} where you gave both a reason and a verdict afterwards, ${name} is the reason you were least often glad about: ${worst.counts[0]} of ${rowTotal(worst)} felt worthwhile.`,
      transactions: r.n,
      unit: 'purchases',
      period: r.period,
      effect: { label: 'How strongly the reason you give for a purchase and how worthwhile it felt afterwards go together', bp: r.vBp, scale: 'percent' },
      limitation: `This covers ${count(r.n, 'purchase', 'purchases')} that carry both a reason and a verdict, spread over ${count(r.rows.length, 'reason', 'reasons')}. ${FLOORED_STRENGTH}${sharedLabelClause(r.rows)} It also cannot tell whether a reason was chosen before you bought or picked afterwards to fit the purchase.`,
      ...verdictWords(r, {
        meaning: 'One reading is that some of your reasons for buying hold up better in hindsight than others. Another is that you answer the hindsight question days later, when the reason you picked at the time is already part of what you remember.',
        action: 'Before the next purchase you would give that reason, say what you expect to feel about it in a week, then answer it honestly on the Worth it? screen when it comes round.',
      }, {
        sparseAction: 'Work through a few more cards on the Worth it? screen; the thin corners of this comparison need filling in before it can be judged.',
        tooManyAction: 'Keep to the few reasons that really describe how you buy, rather than reaching for a new one each time: this comparison can only weigh so many at once.',
      }),
    }
  },

  // rank.ts weekend: a = the WEEKEND purchases, so a POSITIVE r means the weekend ones were the larger. This is the
  // one relationship that reads the window's live transactions rather than only the annotated ones, so it carries NO
  // annotation caveat - and the limitations it does carry are its own.
  //
  // IT STILL FILTERS, so the sentence does not say "all". spendsOf keeps only what treatmentOf calls spending, which
  // is the Budget screen's own definition, and drops both legs of every non-refund transfer; "all the purchases"
  // would claim nothing was left out, which is false of this relationship and of every other one in the battery. It
  // also KEEPS a refunded purchase, deliberately (the decision was still made), where monthlyBudget nets the refund
  // out - so this count can legitimately exceed the Budget screen's total for the same weeks, and the owner can put
  // the two side by side. A limitation that let them find that difference for themselves would have been the kind
  // this field exists to prevent.
  weekend: (r) => ({
    pattern: r.effectBp > 0
      ? 'Your weekend purchases ran larger than your weekday ones.'
      : r.effectBp < 0
        ? 'Your weekday purchases ran larger than your weekend ones.'
        : 'Your weekend and weekday purchases came to much the same size.',
    transactions: r.n,
    unit: 'purchases',
    period: r.period,
    effect: { label: 'How consistently a weekend purchase outsized a weekday one', bp: r.effectBp, scale: 'percent' },
    limitation: `This reads ${count(r.n, 'purchase', 'purchases')} from the window and not only the ones you annotated — counted the way the Budget screen counts spending, so money you moved into savings, a transfer between your own accounts and anything you marked as income are not purchases here. A purchase you were later refunded for still counts, since the decision to buy it was still made, so this figure can sit above the total the Budget screen shows for the same weeks. It sets single purchases beside one another, so a weekend that is one big shop and a weekend of many small ones are not told apart, and a Friday night counts as a weekday.`,
    meaning: 'One reading is that the weekend is when the bigger wants get bought. Another is that weekday spending is mostly fixed and small by its nature, which would widen the same gap on its own.',
    action: 'Pick one weekend day and look through your Transactions list before you go out, so the weekend’s bigger purchases are a decision rather than a surprise.',
  }),

  // trend.ts paydayTrend: x = days since the month's largest income, y = that day's spending, so a POSITIVE rho means
  // the days FURTHER from payday were the bigger spending days. An observation is a single day, not a purchase.
  payday: (r) => ({
    pattern: r.effectBp > 0
      ? 'Your spending ran higher on the days further from payday than on the days just after it.'
      : r.effectBp < 0
        ? 'Your spending ran higher on the days just after payday and eased off later in the month.'
        : 'Your daily spending sat about level across the days after payday.',
    transactions: r.n,
    unit: 'days',
    period: r.period,
    effect: { label: 'How closely the number of days since payday and that day’s spending moved together', bp: r.effectBp, scale: 'closeness' },
    limitation: `This is ${count(r.n, 'single day', 'single days')} of spending, pooled across the months that had a payment in them. Each day is counted whole, so one large purchase and a day of many small ones look alike, and a month whose payday fell late contributes only the few days left in it.`,
    meaning: 'One reading is that the month has a shape for you: a fuller start and a thinner end, or the other way round. Another is that bills land on fixed days of the month, so part of this shape is the calendar rather than a choice.',
    action: 'Look at the Budget screen in the first days after your next payment, so what the rest of the month needs is clear before the easy spending starts.',
  }),

  // §12 asks for no test here: it is a descriptive aggregation. The one effect size it can honestly carry is the SHARE
  // of the month's spending that went in purchases under the line, which percentBpOf gives in basis points.
  'small-purchases': (c) => ({
    pattern: `Your purchases under ${formatEur(c.ceilingCents)} in ${formatMonthTitle(c.month)} came to ${formatEur(c.small.totalCents)} between them.`,
    transactions: c.small.count,
    unit: 'purchases',
    period: { from: `${c.month}-01`, to: addDays(nextMonthStart(c.month), -1) },
    effect: { label: `The part of that month’s spending that went in purchases under ${formatEur(c.ceilingCents)}`, bp: percentBpOf(c.small.totalCents, c.monthSpendCents), scale: 'percent' },
    limitation: `This is a straight count of the ${count(c.small.count, 'purchase', 'purchases')} under ${formatEur(c.ceilingCents)} that ${formatMonthTitle(c.month)} holds${c.small.medianCents === null ? '' : `, where the middle one of them came to ${formatEur(c.small.medianCents)}`}. It is one month standing on its own, and it counts every purchase under that line whether it was a coffee or a bus fare, so it says what the small ones came to and nothing about which of them you would miss.`,
    meaning: 'Small purchases of this kind add up to a total, and some of them are essentials that happen to be cheap. The figure is what they came to, and it is for you to say which of them was worth it.',
    action: `Pick the one kind of purchase under ${formatEur(c.ceilingCents)} you make most often and buy it in a weekly batch instead of one at a time, then look at this figure again next month.`,
    confidence: 'This one is a count of your own purchases rather than a comparison, so there is nothing here to be uncertain about.',
  }),

  // trend.ts salaryLifestyle: a = the months at the HIGHER income level, so a POSITIVE r means the share spent on
  // wants rose with income. An observation is a whole month, and the two sides are different months rather than the
  // same month before and after.
  'salary-lifestyle': (r) => ({
    pattern: r.effectBp > 0
      ? 'In the months at your higher income, a larger share of your spending went on wants than in the months at your lower income.'
      : r.effectBp < 0
        ? 'In the months at your higher income, a smaller share of your spending went on wants than in the months at your lower income.'
        : 'The share of your spending that went on wants was much the same at both income levels.',
    transactions: r.n,
    unit: 'months',
    period: r.period,
    effect: { label: 'How consistently the months at the higher income held the larger share of wants', bp: r.effectBp, scale: 'percent' },
    limitation: `This compares ${count(r.n, 'whole month', 'whole months')}, grouped into a higher and a lower income level. They are two sets of different months and not one month before and after, a month whose income had to be estimated is left out, and with this few on each side the comparison can show a gap without being able to say how settled it is.`,
    meaning: 'One reading is that a step up in income goes mostly to wants rather than to the fixed costs. Another is that the higher-income months fell in a different part of the year, with spending of its own.',
    action: 'The next time your income steps up, write down the one thing you want the difference to go to before the month starts, then check it against the Budget screen at the end of it.',
  }),

  // trend.ts categorySavings: one rho per category, x = that category's monthly spending, y = the month's savings, so
  // a POSITIVE rho means the months you spent more in it were the months you saved more. Strongest first.
  //
  // THIS RELATIONSHIP IS ITSELF A SEARCH, AND THE SENTENCE HAS TO SAY SO. Every other relationship in the battery runs
  // one comparison; this one runs one per category the owner's spending varies in and reports the BEST of them. The
  // screen then takes that one bracket into Benjamini-Hochberg, which corrects across the ten relationships and knows
  // nothing of the search inside this one — so the certainty reaching the owner is overstated by exactly what picking
  // the strongest of N is worth. "Your spending on groceries moves against your saving" reads as one test; over twelve
  // categories it is the best of twelve. So the limitation NAMES the number compared, and the owner can discount it.
  //
  // DEFERRED, NOT MISSED: correcting WITHIN the relationship — a Bonferroni or Benjamini-Hochberg step over the
  // categories before the strongest is chosen — is the fuller answer, and it belongs in trend.ts rather than here. It
  // was considered and put off deliberately: it needs its own threshold, its own tests, and a decision about what the
  // screen says when no category survives, which is more than this plan should take on at its end. Naming the search
  // is the honest minimum in the meantime, not a substitute for that work.
  'category-savings': (r) => {
    const top = r.categories[0]
    const many = count(r.categories.length, 'category', 'categories')
    return {
      pattern: top === undefined
        ? 'No category you spend in moved with your savings from one month to the next.'
        : top.effectBp > 0
          ? `Of the ${many} that moved from month to month, ${top.label} tracked your savings most closely: the months you spent more in it were the months you saved more.`
          : top.effectBp < 0
            ? `Of the ${many} that moved from month to month, ${top.label} tracked your savings most closely: the months you spent more in it were the months you saved less.`
            : `None of the ${many} that moved from month to month tracked your savings either way.`,
      transactions: r.months,
      unit: 'months',
      period: r.period,
      effect: {
        label: top === undefined
          ? 'How closely spending in a category and that month’s savings moved together'
          : `How closely spending in ${top.label} and that month’s savings moved together`,
        bp: top?.effectBp ?? 0,
        scale: 'closeness',
      },
      limitation: `This is ${count(r.months, 'month', 'months')} of records rather than a count of purchases. ${searchClause(r.categories.length, top?.label)} A category you spent the same in every month was not compared at all, and the savings figure is what was left at the end of a month, which one large purchase can move on its own.`,
      meaning: 'One reading is that this is where the spare money goes in a month that has any. Another is that this category and your savings both follow the same quiet and busy months, which would look the same from here.',
      action: top === undefined
        ? 'Keep importing your statements each month on the Import screen: this one needs a longer run of months before any category stands out.'
        : `Set a figure for ${top.label} on the Budget screen for next month, and see whether what is left at the end of it moves with it.`,
    }
  },
}

/**
 * The bracket, and the battery-wide correction, in words. 'none' is "not certain yet" and never "no effect": the
 * figure beside it may be perfectly real, and saying otherwise would be the screen making a claim the arithmetic did
 * not. A bracket that does not survive the correction is SHOWN and not called, which is a third thing to say and not a
 * softer way of saying either of the other two.
 */
function confidenceOf(verdict: CorrectionVerdict): string {
  if (verdict.bracket === 'none') {
    return 'There is not enough here yet to call this certain either way. That is not the same as there being nothing to see: it means the app cannot tell yet.'
  }
  if (!verdict.survives) {
    return 'On its own this looks clear, but it does not hold up once every other comparison the app ran this time is counted alongside it, so it is shown here and not called a finding.'
  }
  if (verdict.bracket === 'p<0.001') {
    return 'This is as clear as this app will ever call a pattern, and it holds up alongside every other comparison the app ran this time.'
  }
  if (verdict.bracket === 'p<0.01') {
    return 'This is clear, and it holds up alongside every other comparison the app ran this time.'
  }
  return 'This is clear enough to call, and it holds up alongside every other comparison the app ran this time.'
}

/**
 * One relationship's result as the eight fields §12 asks for.
 *
 * `corrected` is what the Benjamini-Hochberg pass said about this relationship, not a second copy of the result: the
 * bracket on the result itself is the uncorrected one, and a screen showing ten findings must speak from the corrected
 * verdict. Where the result says no test was run at all — a sparse or oversized contingency table, or the small
 * purchases, which §12 gives no test — the template overrides the sentence and `corrected` is not consulted.
 */
export function findingFor<K extends RelationshipId>(id: K, result: BatteryResults[K], corrected: CorrectionVerdict): Finding {
  // The index into TEMPLATES is sound (the mapped type has one entry per RelationshipId), but TypeScript cannot see
  // that `TEMPLATES[id]` and `result` carry the same K once the union is formed, so the call is cast and nothing else.
  const template = TEMPLATES[id] as (r: BatteryResults[K]) => Parts
  const parts = template(result)
  return {
    id,
    pattern: parts.pattern,
    transactions: parts.transactions,
    unit: parts.unit,
    period: periodText(parts.period),
    effect: parts.effect,
    confidence: parts.confidence ?? confidenceOf(corrected),
    limitation: parts.limitation,
    meaning: parts.meaning,
    action: parts.action,
  }
}

/** Re-exported so a screen can name the rung without reaching into critical.ts for a type it only passes through. */
export type { Bracket }
