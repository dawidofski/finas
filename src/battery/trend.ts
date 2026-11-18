import { db } from '../db/db'
import { resolveMany } from '../db/annotations'
import { annotatedTransactions } from '../learning/regret'
import { afterPayday } from '../analytics/habits'
import { monthSeries, type MonthPoint } from '../analytics/series'
import { cached } from '../analytics/cache'
import { monthlyBudget } from '../budget/month'
import { addDays, isoWeekday } from '../lib/dates'
import { divRound } from '../lib/money'
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
  /** First and last month ('YYYY-MM') or bank date ('YYYY-MM-DD') among the rows used: the key says which. */
  period: { from: string; to: string }
}
export type TrendResult = TrendFinding | Gate[]

export interface MoodFrequencyFinding extends TrendFinding {
  /** How many weeks each side was observed for, and how many purchases it made in them: the lengths the rate is over. */
  lowMood: { weeks: number; purchases: number }
  goodMood: { weeks: number; purchases: number }
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

/** The months that were actually observed. A gap month (hasData false) is NOT zero, so it is not here. */
async function observedMonths(from: string, to: string, today: string, computedAt: number): Promise<MonthPoint[]> {
  return (await monthSeries(from, to, today, computedAt)).filter(p => p.hasData)
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
    const paydayMonths: string[] = []
    for (const p of await observedMonths(from, to, today, computedAt)) {
      const pay = await afterPayday(p.month, computedAt)
      if (pay === null) continue
      paydayMonths.push(p.month)
      for (const d of pay.days) { xs.push(d.dayOffset); ys.push(d.spentCents) }
    }
    const short = unmet('payday', { incomeEvents: paydayMonths.length })
    if (short.length > 0) return short
    const rho = spearmanRhoBp(xs, ys)
    if (rho === null) return unusable(0, 2, 'Your spending is the same on every day after payday, or the days observed are too few, so there is no pattern to measure yet.')
    return {
      effectBp: rho, bracket: spearmanBracket(rho, xs.length), n: xs.length,
      period: { from: paydayMonths[0] ?? '', to: paydayMonths[paydayMonths.length - 1] ?? '' },
    }
  }, computedAt)
}

/** Two incomes belong to one level when the higher is within this many basis points of the level's lowest (10 %). */
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
    const months: ShareMonth[] = (await observedMonths(from, to, today, computedAt))
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
      period: { from: used[0] ?? '', to: used[used.length - 1] ?? '' },
    }
  }, computedAt)
}

/** The Monday of the week a date falls in, by the bank's date: a Sunday belongs to the week that began six days before. */
const weekOf = (date: string): string => addDays(date, -(isoWeekday(date) - 1))

/**
 * Whether purchases come more often in a low mood than in a good one.
 *
 * THIS IS A RANK COMPARISON OF WEEKLY COUNTS, NOT A POISSON RATE TEST. Purchases cluster (one shopping trip is several
 * transactions), so the Poisson shape does not hold and no claim that it does is made here. For each side the unit is
 * the WEEK: the side's purchases are counted per week in which that side was observed, and the two sets of weekly
 * counts go to Mann-Whitney. Comparing raw totals would report only which mood was recorded for longer.
 *
 * A week is observed for a side when at least one purchase carried a mood on that side; the app has no other record of
 * a mood, so a week of buying nothing in a low mood is not visible and counts for neither side. The weekly counts are
 * therefore all at least one and the comparison is of how heavily a side buys when it buys at all: a floor, and said so.
 * Low mood is valence below zero and good mood is above zero; neutral and valence-less moods are left out.
 *
 * a = the LOW-mood weeks, b = the good-mood weeks: a POSITIVE r means more purchases per week in a low mood.
 */
export function moodFrequency(computedAt: number): Promise<MoodFrequencyResult> {
  return cached('battery.trend.mood-frequency', async (): Promise<MoodFrequencyResult> => {
    const bank = await annotatedTransactions(a => a.moodId !== null)
    const byId = new Map(bank.map(t => [t.id, t]))
    const [resolved, moods] = await Promise.all([resolveMany(bank), db.moods.toArray()])
    const valence = new Map(moods.map(m => [m.id, m.valence]))
    const low = new Map<string, number>()
    const good = new Map<string, number>()
    for (const r of resolved) {
      const t = byId.get(r.id)
      // The kind is the owner's (§43); the sign and the date are the bank's (§41).
      if (!t || r.kind !== 'spend' || t.amountCents >= 0 || r.moodId === null) continue
      const v = valence.get(r.moodId) ?? null
      const side = v === null || v === 0 ? null : v < 0 ? low : good
      if (side === null) continue
      const week = weekOf(t.valueDate)
      side.set(week, (side.get(week) ?? 0) + 1)
    }
    const covered = [...new Set([...low.keys(), ...good.keys()])].sort()
    const short = unmet('mood-frequency', { weeksOfMoodCoverage: covered.length })
    if (short.length > 0) return short
    const lowCounts = [...low.values()]
    const goodCounts = [...good.values()]
    const mw = mannWhitneyU(lowCounts, goodCounts)
    if (mw === null) return unusable(0, 1, 'Only one kind of mood has been recorded so far, so there is nothing to compare it with.')
    const sum = (xs: number[]): number => xs.reduce((s, x) => s + x, 0)
    return {
      effectBp: mw.rBp,
      bracket: mannWhitneyBracket(mw.uDoubled, lowCounts.length, goodCounts.length),
      n: lowCounts.length + goodCounts.length,
      period: { from: covered[0] ?? '', to: addDays(covered[covered.length - 1] ?? '', 6) },
      lowMood: { weeks: lowCounts.length, purchases: sum(lowCounts) },
      goodMood: { weeks: goodCounts.length, purchases: sum(goodCounts) },
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
    const months = await observedMonths(from, to, today, computedAt)
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
    return { months: months.length, period: { from: months[0]?.month ?? '', to: months[months.length - 1]?.month ?? '' }, categories }
  }, computedAt)
}
