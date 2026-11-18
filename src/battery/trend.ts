import { annotatedTransactions } from '../learning/regret'
import { afterPayday } from '../analytics/habits'
import { monthSeries, type MonthPoint } from '../analytics/series'
import { cached } from '../analytics/cache'
import { monthlyBudget } from '../budget/month'
import { incomeByMonth } from '../analysis/income'
import { addDays, isoWeekday } from '../lib/dates'
import { divRound } from '../lib/money'
import { nextMonthStart } from '../analysis/transactionsInRange'
import { spendsOf } from './rank'
import { mannWhitneyU, spearmanRhoBp } from './stats'
import { mannWhitneyBracket, spearmanBracket, type Bracket } from './critical'
import { BATTERY, isMet, type BatteryData, type Gate, type RelationshipId } from './battery'

/**
 * The four remaining relationships of §12: days since payday against daily spending (Spearman), a change of income
 * against the share spent on wants (Mann-Whitney), mood against how OFTEN the owner buys (Mann-Whitney on weekly
 * counts) and a category against savings (Spearman).
 *
 * Gate versus bracket, as in rank.ts: the GATE (from BATTERY) decides whether a figure may be shown at all, the BRACKET
 * whether it may be called a finding. category -> savings gates at four months but spearmanBracket will not bracket
 * below ten, so between four and nine months it legitimately returns a real effect with `bracket: 'none'`. Neither
 * number is wrong and 'none' is an answer, not an error.
 *
 * Figures versus classifications (§41/§43): every amount and every date is the BANK's; the owner decides only
 * classifications. Nothing here reads a clock: "today" and `computedAt` arrive as arguments.
 *
 * A MONTH WITH NO RECORDS IS NOT A MONTH OF ZERO. monthSeries marks it `hasData: false` with blanked income, and every
 * relationship below that walks months drops such a month before it counts one. Admitting it would put an invented
 * month of poverty into the correlation and drag it toward a finding that is only missing data.
 */
export interface TrendFinding {
  /** Basis points: Spearman rho, or Kerby's rank-biserial r. Its sign is documented at each call site. */
  effectBp: number
  bracket: Bracket
  /** Observations used in the statistic. */
  n: number
  /** First and last BANK date covered by the rows used, 'YYYY-MM-DD': for months, the first day of the first and the last day of the last. */
  period: { from: string; to: string }
}
export type TrendResult = TrendFinding | Gate[]

export interface MoodFrequencyFinding extends TrendFinding {
  /** How many weeks each side was observed for, and how many purchases it made in them: the lengths the rate is over. */
  lowMood: { weeks: number; purchases: number }
  goodMood: { weeks: number; purchases: number }
  /** Weeks with as many low-mood as good-mood purchases: left out of both sides. */
  tiedWeeks: number
}
export type MoodFrequencyResult = MoodFrequencyFinding | Gate[]

export interface CategorySavingsFinding {
  categoryId: string
  label: string
  /** Spearman rho of that category's monthly spending against the month's savings: POSITIVE means more spent, more saved. */
  effectBp: number
  bracket: Bracket
}
export interface CategorySavings {
  months: number
  period: { from: string; to: string }
  /** Strongest first. A category whose spending never varies across the months has no correlation and is left out. */
  categories: CategorySavingsFinding[]
}
export type CategorySavingsResult = CategorySavings | Gate[]

const EMPTY: BatteryData = {
  discretionarySpendsWithMood: 0, moodGroupsOfTen: 0, weeksOfMoodCoverage: 0, stressedSpends: 0, unstressedSpends: 0,
  impulseTaggedSpends: 0, spendsWithReasonAndWorthwhile: 0, weekendsObserved: 0, incomeEvents: 0, fullMonths: 0,
  incomeLevelsWithTwoMonths: 0, monthsObserved: 0,
}

/** The gates of one relationship that are not met. Empty means the figure may be shown. */
function unmet(id: RelationshipId, data: Partial<BatteryData>): Gate[] {
  const rel = BATTERY.find(r => r.id === id)
  if (!rel) throw new Error(`Unknown relationship ${id}`)
  return rel.gates({ ...EMPTY, ...data }).filter(g => !isMet(g))
}

/** A shortfall the gates do not describe: the data passed the count but cannot carry the statistic. */
const unusable = (have: number, need: number, what: string): Gate[] => [{ have, need, what }]

/** The period covered by whole months: the first day of the first and the last day of the last, derived from the months USED. */
const monthsPeriod = (months: readonly string[]): { from: string; to: string } => {
  const sorted = [...months].sort()
  const first = sorted[0]
  const last = sorted[sorted.length - 1]
  return { from: first === undefined ? '' : `${first}-01`, to: last === undefined ? '' : addDays(nextMonthStart(last), -1) }
}

/**
 * The months with data (a gap month, hasData false, is NOT zero, so it is not here), optionally only the COMPLETE ones.
 * The running month is a part of a month: as an observation it is not a small version of a whole month (a part-month
 * spend against a part-month saving would read as a fall that is only the calendar), so a month-unit relationship
 * leaves it out entirely, and it does not count toward the gate either.
 */
async function observedMonths(from: string, to: string, today: string, computedAt: number, completeOnly: boolean): Promise<MonthPoint[]> {
  return (await monthSeries(from, to, today, computedAt)).filter(p => p.hasData && (!completeOnly || p.month < today.slice(0, 7)))
}

/**
 * Days since payday against that day's spending, pooled over every month that has a payday. x = days since the
 * month's largest income (bank dates, from afterPayday), y = money out that day: a POSITIVE rho means the days further
 * from payday are the bigger spending days. A month with no income event has no payday and contributes nothing.
 */
export function paydayTrend(from: string, to: string, today: string, computedAt: number): Promise<TrendResult> {
  return cached(`battery.trend.payday:${from}:${to}:${today}`, async (): Promise<TrendResult> => {
    const xs: number[] = []
    const ys: number[] = []
    const dates: string[] = []
    let incomeEvents = 0
    // A day-unit relationship KEEPS the running month but only the days that have happened. afterPayday runs to month end,
    // so its later days are the calendar, not behaviour: a day that has not happened is ABSENT, not a zero-spend day. Today
    // itself is unfinished, so only days strictly before it are used.
    for (const p of await observedMonths(from, to, today, computedAt, false)) {
      const pay = await afterPayday(p.month, computedAt)
      if (pay === null) continue
      const lastDay = addDays(nextMonthStart(p.month), -1)
      const payday = addDays(lastDay, 1 - pay.daysObserved)
      const happened = pay.days.filter(d => addDays(payday, d.dayOffset) < today)
      if (happened.length === 0) continue
      // The count the gate words in PAYMENTS: income events, not months that had one (three salary payments in two
      // months are three).
      incomeEvents += (await incomeByMonth(p.month, p.month)).get(p.month)?.rows ?? 0
      for (const d of happened) { xs.push(d.dayOffset); ys.push(d.spentCents); dates.push(addDays(payday, d.dayOffset)) }
    }
    const short = unmet('payday', { incomeEvents })
    if (short.length > 0) return short
    const rho = spearmanRhoBp(xs, ys)
    if (rho === null) return unusable(0, 2, 'Your spending is the same on every day after payday, or the days observed are too few, so there is no pattern to measure yet.')
    return {
      effectBp: rho, bracket: spearmanBracket(rho, xs.length), n: xs.length,
      period: { from: [...dates].sort()[0] ?? '', to: [...dates].sort().reverse()[0] ?? '' },
    }
  }, computedAt)
}

/**
 * Two incomes belong to one level when the higher is within this many basis points of the level's lowest (10 %): a salary
 * moves a little from month to month (overtime, a bonus) without the owner having moved to a different standard of living.
 * It is a judgement, named here so it can be changed in one place.
 */
const LEVEL_TOLERANCE_BP = 1000

interface ShareMonth { month: string; incomeCents: number; shareBp: number }

/** Income levels: months sorted by income, a new level starting once income passes the level's lowest by the tolerance. */
function incomeLevels(months: readonly ShareMonth[]): ShareMonth[][] {
  const sorted = [...months].sort((a, b) => a.incomeCents - b.incomeCents)
  const levels: ShareMonth[][] = []
  for (const m of sorted) {
    const level = levels[levels.length - 1]
    const lowest = level?.[0]
    if (level !== undefined && lowest !== undefined && (m.incomeCents - lowest.incomeCents) * 10000 <= lowest.incomeCents * LEVEL_TOLERANCE_BP) level.push(m)
    else levels.push([m])
  }
  return levels
}

/**
 * Whether the share of spending that goes on wants differs between the highest and the lowest income level the owner
 * has lived at for two months or more. Only months with an ACTUAL income count: a month with data but no income of its
 * own carries a trailing-average estimate, and putting an estimate into a level would invent a month at that income.
 *
 * Mann-Whitney U on the monthly discretionary share, in basis points of that month's spending. a = the months at the
 * HIGHER income level, b = the lower: a POSITIVE r means the share spent on wants was higher when income was higher.
 * It is a comparison of two sets of months, not a before-and-after of the same one, and says nothing about cause.
 * mannWhitneyBracket brackets nothing below eight months a side, so with fewer the effect is shown and the bracket is 'none'.
 */
export function salaryLifestyle(from: string, to: string, today: string, computedAt: number): Promise<TrendResult> {
  return cached(`battery.trend.salary-lifestyle:${from}:${to}:${today}`, async (): Promise<TrendResult> => {
    const months: ShareMonth[] = (await observedMonths(from, to, today, computedAt, true))
      .filter(p => p.incomeBasis === 'actual' && p.spentCents > 0)
      .map(p => ({ month: p.month, incomeCents: p.incomeCents, shareBp: divRound(p.discretionaryCents * 10000, p.spentCents) }))
    const levels = incomeLevels(months).filter(l => l.length >= 2)
    const short = unmet('salary-lifestyle', { incomeLevelsWithTwoMonths: levels.length })
    if (short.length > 0) return short
    const lower = levels[0] ?? []
    const higher = levels[levels.length - 1] ?? []
    // a = the HIGHER-income months, b = the lower: POSITIVE r means the discretionary share rose with income.
    const mw = mannWhitneyU(higher.map(m => m.shareBp), lower.map(m => m.shareBp))
    if (mw === null) return unusable(0, 2, 'There are no months to compare yet.')
    const used = [...higher, ...lower].map(m => m.month).sort()
    return {
      effectBp: mw.rBp, bracket: mannWhitneyBracket(mw.uDoubled, higher.length, lower.length), n: used.length,
      period: monthsPeriod(used),
    }
  }, computedAt)
}

/** The Monday of the week a date falls in, by the bank's date: a Sunday belongs to the week that began six days before. */
const weekOf = (date: string): string => addDays(date, -(isoWeekday(date) - 1))

/**
 * Whether purchases come more often in weeks of low mood than in weeks of good mood.
 *
 * THIS IS A RANK COMPARISON OF WEEKLY COUNTS, NOT A POISSON RATE TEST. Purchases cluster (one shopping trip is several
 * transactions), so the Poisson shape does not hold and no claim that it does is made here.
 *
 * Each week goes to EXACTLY ONE side, so the two samples are disjoint and Mann-Whitney's independence assumption holds
 * (a week counted on both sides would correlate them). A week belongs to the side holding the MAJORITY of its mood-tagged
 * purchases: low mood is valence below zero, good mood above zero; neutral and valence-less moods are not counted at all.
 * A week where the two sides tie is EXCLUDED and counted for neither, since assigning it either way would be a coin
 * toss that moves the bracket. The week's value is its total mood-tagged (valenced) purchases.
 *
 * Mood exists in this app only as an annotation on a purchase, so a week with no purchases has no mood and cannot be
 * placed on either side: every weekly value is at least one, and the measure is conditioned on having bought. The
 * finding must be worded "in weeks when you recorded feeling low", never "when you are low".
 *
 * a = the LOW-mood weeks, b = the good-mood weeks: a POSITIVE r means more purchases in weeks of low mood.
 */
export function moodFrequency(computedAt: number): Promise<MoodFrequencyResult> {
  return cached('battery.trend.mood-frequency', async (): Promise<MoodFrequencyResult> => {
    // The shared spend loader of rank.ts: one definition of what counts as a spend, bank sign, amount and date.
    const spends = await spendsOf(await annotatedTransactions(a => a.moodId !== null))
    const perWeek = new Map<string, { low: number; good: number; first: string; last: string }>()
    for (const s of spends) {
      if (s.valence === null || s.valence === 0) continue
      const week = weekOf(s.date)
      const w = perWeek.get(week) ?? { low: 0, good: 0, first: s.date, last: s.date }
      if (s.date > w.last) w.last = s.date
      if (s.date < w.first) w.first = s.date
      if (s.valence < 0) w.low++
      else w.good++
      perWeek.set(week, w)
    }
    const short = unmet('mood-frequency', { weeksOfMoodCoverage: perWeek.size })
    if (short.length > 0) return short
    const bankDates: string[] = []
    const lowCounts: number[] = []
    const goodCounts: number[] = []
    for (const w of perWeek.values()) {
      if (w.low === w.good) continue // tied: counted nowhere
      bankDates.push(w.first, w.last)
      if (w.low > w.good) lowCounts.push(w.low + w.good)
      else goodCounts.push(w.low + w.good)
    }
    const mw = mannWhitneyU(lowCounts, goodCounts)
    if (mw === null) return unusable(0, 1, 'Only one kind of mood week has been recorded so far, so there is nothing to compare it with.')
    const sum = (xs: number[]): number => xs.reduce((t, x) => t + x, 0)
    return {
      effectBp: mw.rBp,
      bracket: mannWhitneyBracket(mw.uDoubled, lowCounts.length, goodCounts.length),
      n: lowCounts.length + goodCounts.length,
      // The first and last BANK dates actually used, never the Monday and Sunday that bound the weeks: either may hold no
      // purchase and the Sunday may not have happened yet.
      period: { from: bankDates.sort()[0] ?? '', to: bankDates.sort().reverse()[0] ?? '' },
      lowMood: { weeks: lowCounts.length, purchases: sum(lowCounts) },
      goodMood: { weeks: goodCounts.length, purchases: sum(goodCounts) },
      tiedWeeks: perWeek.size - lowCounts.length - goodCounts.length,
    }
  }, computedAt)
}

/**
 * Whether spending in each category goes with how much was saved that month: Spearman rho per category over the months.
 * x = the category's spending that month (monthlyBudget's line, net of refunds, zero in a month it had none), y = the
 * month's savings (monthSeries): a POSITIVE rho means more spent in that category, more saved. Only months with data are
 * walked, so every rho is over the same n months; one that never varies has no rho and is left out.
 * Many categories are many tests, so a caller wanting findings passes these brackets through the correction in correction.ts.
 */
export function categorySavings(from: string, to: string, today: string, computedAt: number): Promise<CategorySavingsResult> {
  return cached(`battery.trend.category-savings:${from}:${to}:${today}`, async (): Promise<CategorySavingsResult> => {
    const months = await observedMonths(from, to, today, computedAt, true)
    const short = unmet('category-savings', { monthsObserved: months.length })
    if (short.length > 0) return short
    const budgets = await Promise.all(months.map(p => monthlyBudget(p.month, today)))
    const labels = new Map<string, string>()
    const spend = budgets.map(b => {
      const m = new Map<string, number>()
      for (const line of b.lines) {
        if (line.targetKind !== 'category') continue
        labels.set(line.targetId, line.label)
        m.set(line.targetId, line.spentCents)
      }
      return m
    })
    const saved = months.map(p => p.savedCents)
    const categories: CategorySavingsFinding[] = []
    for (const [categoryId, label] of labels) {
      const rho = spearmanRhoBp(spend.map(m => m.get(categoryId) ?? 0), saved)
      if (rho !== null) categories.push({ categoryId, label, effectBp: rho, bracket: spearmanBracket(rho, months.length) })
    }
    if (categories.length === 0) return unusable(0, 2, 'No category was spent in differently from month to month, or your savings never changed, so there is nothing to compare yet.')
    categories.sort((a, b) => Math.abs(b.effectBp) - Math.abs(a.effectBp) || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))
    return { months: months.length, period: monthsPeriod(months.map(m => m.month)), categories }
  }, computedAt)
}
