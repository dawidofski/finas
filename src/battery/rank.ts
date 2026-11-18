import { db } from '../db/db'
import { resolveMany } from '../db/annotations'
import type { TransactionRow } from '../db/schema'
import { annotatedTransactions } from '../learning/regret'
import { cached } from '../analytics/cache'
import { addDays, isoWeekday } from '../lib/dates'
import { mannWhitneyU, spearmanRhoBp } from './stats'
import { mannWhitneyBracket, spearmanBracket, type Bracket } from './critical'
import { BATTERY, isMet, type BatteryData, type Gate, type RelationshipId } from './battery'

/**
 * The three rank relationships of §12: mood against amount (Spearman), stress against amount (Mann-Whitney) and
 * weekend against weekday (Mann-Whitney).
 *
 * Figures versus classifications (§41/§43): the AMOUNT and the DATE of every row used here are the bank's, read from the
 * TransactionRow, never from the resolved view, which would carry the owner's `amountCentsOverride` and `dateOverride`.
 * What the owner decides is only classification: whether a row is a spend (kind), its category, its mood.
 *
 * Gate versus bracket: a relationship's GATE (from BATTERY) decides whether a figure may be shown at all; its BRACKET
 * decides whether that figure may be called a finding. A result can therefore carry a real `effectBp` with
 * `bracket: 'none'`: an effect size that is not yet certain. 'none' is an answer, not an error.
 *
 * A result is either the finding or the list of gates still unmet. No decimal and no float anywhere: basis points
 * and integer cents.
 */
export interface RankFinding {
  /** Basis points: Spearman rho, or Kerby's rank-biserial r. Its sign is documented at each call site. */
  effectBp: number
  bracket: Bracket
  /** Observations used in the statistic. */
  n: number
  /** First and last BANK date among the rows used. */
  period: { from: string; to: string }
}
export type RankResult = RankFinding | Gate[]

const STRESSED_MOOD = 'mood.stressed'

/** One spend, as the statistics see it: bank figures plus the owner's classifications. */
interface Spend {
  centsOut: number            // the BANK amount, negated: money out, positive
  date: string                // the BANK value date
  moodId: string | null
  valence: number | null      // null: the mood has no valence (Other, or custom and unassigned): unusable, not zero
  discretionary: boolean
}

async function loadSpends(keep: Parameters<typeof annotatedTransactions>[0]): Promise<Spend[]> {
  const bank: TransactionRow[] = await annotatedTransactions(keep)
  const byId = new Map(bank.map(t => [t.id, t]))
  const resolved = await resolveMany(bank)
  const [moods, categories] = await Promise.all([db.moods.toArray(), db.categories.toArray()])
  const valence = new Map(moods.map(m => [m.id, m.valence]))
  const discretionary = new Set(categories.filter(c => c.kind === 'discretionary').map(c => c.id))
  const out: Spend[] = []
  for (const r of resolved) {
    const t = byId.get(r.id)
    // The kind is the owner's (§43); the sign, amount and date are the bank's.
    if (!t || r.kind !== 'spend' || t.amountCents >= 0) continue
    out.push({
      centsOut: -t.amountCents,
      date: t.valueDate,
      moodId: r.moodId,
      valence: r.moodId === null ? null : valence.get(r.moodId) ?? null,
      discretionary: r.categoryId !== null && discretionary.has(r.categoryId),
    })
  }
  return out
}

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

function periodOf(spends: readonly Spend[]): { from: string; to: string } {
  const dates = spends.map(s => s.date).sort()
  return { from: dates[0] ?? '', to: dates[dates.length - 1] ?? '' }
}

/** A shortfall the gates do not describe: the data passed the count but cannot carry the statistic. */
const unusable = (have: number, need: number, what: string): Gate[] => [{ have, need, what }]

/** The Saturday that starts the weekend a Saturday or Sunday belongs to. */
const weekendKey = (date: string): string => (isoWeekday(date) === 7 ? addDays(date, -1) : date)

export function moodAmount(computedAt: number): Promise<RankResult> {
  return cached('battery.rank.mood-amount', async (): Promise<RankResult> => {
    const all = await loadSpends(a => a.moodId !== null)
    // A null valence is unusable, not neutral: those rows are left out of the count and of the statistic.
    const usable = all.filter(s => s.discretionary && s.valence !== null)
    const perMood = new Map<string, number>()
    for (const s of usable) if (s.moodId !== null) perMood.set(s.moodId, (perMood.get(s.moodId) ?? 0) + 1)
    const short = unmet('mood-amount', {
      discretionarySpendsWithMood: usable.length,
      moodGroupsOfTen: [...perMood.values()].filter(c => c >= 10).length,
    })
    if (short.length > 0) return short
    // x = mood valence, y = money out: a POSITIVE rho means happier moods go with larger purchases.
    const rho = spearmanRhoBp(usable.map(s => s.valence ?? 0), usable.map(s => s.centsOut))
    if (rho === null) return unusable(0, 2, 'The moods you recorded all sit at the same point on the happy-to-unhappy scale, so there is nothing to compare yet.')
    return { effectBp: rho, bracket: spearmanBracket(rho, usable.length), n: usable.length, period: periodOf(usable) }
  }, computedAt)
}

export function stressDiscretionary(computedAt: number): Promise<RankResult> {
  return cached('battery.rank.stress-discretionary', async (): Promise<RankResult> => {
    const spends = (await loadSpends(a => a.moodId !== null)).filter(s => s.moodId !== null)
    const stressed = spends.filter(s => s.moodId === STRESSED_MOOD)
    const calm = spends.filter(s => s.moodId !== STRESSED_MOOD)
    const short = unmet('stress-discretionary', { stressedSpends: stressed.length, unstressedSpends: calm.length })
    if (short.length > 0) return short
    // a = the STRESSED purchases, b = the rest: a POSITIVE r means the stressed purchases were the larger ones.
    const mw = mannWhitneyU(stressed.map(s => s.centsOut), calm.map(s => s.centsOut))
    if (mw === null) return unusable(0, 1, 'There are no purchases to compare yet.')
    return {
      effectBp: mw.rBp,
      bracket: mannWhitneyBracket(mw.uDoubled, stressed.length, calm.length),
      n: spends.length,
      period: periodOf(spends),
    }
  }, computedAt)
}

export function weekend(computedAt: number): Promise<RankResult> {
  return cached('battery.rank.weekend', async (): Promise<RankResult> => {
    const spends = await loadSpends(() => true)
    // By the BANK date: a date the owner typed in does not move a purchase across the weekend line.
    const onWeekend = spends.filter(s => isoWeekday(s.date) >= 6)
    const onWeekday = spends.filter(s => isoWeekday(s.date) < 6)
    const short = unmet('weekend', { weekendsObserved: new Set(onWeekend.map(s => weekendKey(s.date))).size })
    if (short.length > 0) return short
    // a = the WEEKEND purchases, b = the weekday ones: a POSITIVE r means weekend purchases were the larger ones.
    const mw = mannWhitneyU(onWeekend.map(s => s.centsOut), onWeekday.map(s => s.centsOut))
    if (mw === null) return unusable(0, 1, 'There are no weekday purchases to compare the weekends with yet.')
    return {
      effectBp: mw.rBp,
      bracket: mannWhitneyBracket(mw.uDoubled, onWeekend.length, onWeekday.length),
      n: spends.length,
      period: periodOf(spends),
    }
  }, computedAt)
}
