import { db } from '../db/db'
import { resolveMany } from '../db/annotations'
import type { TransactionRow } from '../db/schema'
import { annotatedTransactions } from '../learning/regret'
import { liveTransactionsBetween } from '../analysis/transactionsInRange'
import { cached } from '../analytics/cache'
import { treatmentOf } from '../analysis/income'
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
export interface Spend {
  /** The transaction this spend is. */
  id: string
  /** The resolved merchant (the owner's, else none); null when the row has no merchant. Recurring detection leaves such spends out: it clusters by merchant. */
  merchantId: string | null
  centsOut: number            // the BANK amount, negated: money out, positive
  date: string                // the BANK value date
  moodId: string | null
  valence: number | null      // null: the mood has no valence (Other, or custom and unassigned): unusable, not zero
  discretionary: boolean
  /** The resolved category's kind; null for an uncategorised spend, which is not evidence either way. */
  categoryKind: string | null
  reasonId: string | null
  worthwhile: boolean | null
}

/**
 * THE definition of "a spend" for the whole battery, and the app's own: the resolved kind and category must make
 * `treatmentOf(kind, categoryKind) === 'spending'` (the rule Budget, Reports and payday already show), and the BANK
 * amount must be strictly negative, so a 0,00 row is not a purchase anywhere. A spend sitting in a savings, internal or
 * income category is not one. The kind and category are the owner's (§43); the sign, amount and date are the bank's (§41).
 *
 * This is the app's definition (Budget, Reports and payday show it) with ONE DELIBERATE DIVERGENCE and one addition:
 * - A leg of a matched transfer (internal or round-up) is never a purchase, whatever kind a row carries: moving money
 *   between the owner's own accounts is not spending under any reading, so those ids are removed here.
 * - A REFUNDED purchase STAYS. monthlyBudget nets a refund out because it answers "what did this month cost"; the battery
 *   asks about a decision the owner made, and a refund later does not unmake it: the purchase happened, with a mood and
 *   a reason attached, and dropping it would delete the very evidence these relationships exist to read. habits.ts
 *   (payday) does net refunds, because its question is the cost of the days; that difference is chosen, not an oversight.
 */
export async function spendsOf(bank: TransactionRow[]): Promise<Spend[]> {
  const byId = new Map(bank.map(t => [t.id, t]))
  const resolved = await resolveMany(bank)
  const [moods, categories] = await Promise.all([db.moods.toArray(), db.categories.toArray()])
  const valence = new Map(moods.map(m => [m.id, m.valence]))
  const kindOf = new Map(categories.map(c => [c.id, c.kind as string]))
  // Both legs of every transfer that is not a refund link: a refund's purchase leg is deliberately kept (see above).
  const transferLegs = new Set((await db.transfers.toArray()).filter(l => l.linkKind !== 'refund').flatMap(l => [l.outTransactionId, l.inTransactionId]))
  const out: Spend[] = []
  for (const r of resolved) {
    const t = byId.get(r.id)
    if (transferLegs.has(r.id)) continue
    const categoryKind = r.categoryId === null ? null : kindOf.get(r.categoryId) ?? null
    if (!t || t.amountCents >= 0 || treatmentOf(r.kind, categoryKind) !== 'spending') continue
    out.push({
      id: t.id,
      merchantId: r.merchantId,
      centsOut: -t.amountCents,
      date: t.valueDate,
      moodId: r.moodId,
      valence: r.moodId === null ? null : valence.get(r.moodId) ?? null,
      discretionary: r.categoryId !== null && kindOf.get(r.categoryId) === 'discretionary',
      categoryKind,
      reasonId: r.purchaseReasonId,
      worthwhile: r.worthwhile,
    })
  }
  return out
}

/**
 * Mood and stress read ANNOTATIONS: a mood exists only as an annotation, so a purchase with no mood cannot enter a mood
 * correlation. That limit is intrinsic and belongs in the finding's limitation line.
 */
const loadAnnotatedSpends = async (keep: Parameters<typeof annotatedTransactions>[0]): Promise<Spend[]> =>
  spendsOf(await annotatedTransactions(keep))

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
    const all = await loadAnnotatedSpends(a => a.moodId !== null)
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
    // Only essential and discretionary spends are evidence about the SHARE of spending that is discretionary:
    // an uncategorised spend (or a savings or internal one) says nothing either way and is left out of both groups
    // and of the gate counts.
    const spends = (await loadAnnotatedSpends(a => a.moodId !== null))
      .filter(s => s.moodId !== null && (s.categoryKind === 'discretionary' || s.categoryKind === 'essential'))
    const stressed = spends.filter(s => s.moodId === STRESSED_MOOD)
    const calm = spends.filter(s => s.moodId !== STRESSED_MOOD)
    const short = unmet('stress-discretionary', { stressedSpends: stressed.length, unstressedSpends: calm.length })
    if (short.length > 0) return short
    // Each spend is 1 if discretionary, 0 if essential. With two values, Kerby's r is exactly P(a discretionary | a
    // stressed spend) minus P(discretionary | a non-stressed spend), in basis points: the share difference itself.
    // a = the STRESSED spends: a POSITIVE r means stress shifted spending toward discretionary.
    // Ties are heavy (two distinct values). doubledRanks-style tie handling is exact in uDoubled, and the variance's tie
    // correction is deliberately omitted throughout this module, which makes the bracket slightly conservative, not
    // wrong. Do not add one.
    const mw = mannWhitneyU(stressed.map(s => (s.discretionary ? 1 : 0)), calm.map(s => (s.discretionary ? 1 : 0)))
    if (mw === null) return unusable(0, 1, 'There are no purchases to compare yet.')
    return {
      effectBp: mw.rBp,
      bracket: mannWhitneyBracket(mw.uDoubled, stressed.length, calm.length),
      n: spends.length,
      period: periodOf(spends),
    }
  }, computedAt)
}

/**
 * `firstMonth` and `lastMonth` ('YYYY-MM') bound the read ONLY. The period reported is the first and last BANK date of the
 * spends actually used, never the caller's window: echoing the window would claim months the owner may have no records in. Unlike mood and stress, the weekend effect reads LIVE transactions, not annotations: nothing in it is
 * classified by the owner (the weekday is the bank's date, the figure the bank's amount), so restricting it to rows the
 * owner happened to annotate would bias it for no reason. A month range is the sanctioned bounded read (§39.4).
 */
export function weekend(firstMonth: string, lastMonth: string, computedAt: number): Promise<RankResult> {
  return cached(`battery.rank.weekend.${firstMonth}.${lastMonth}`, async (): Promise<RankResult> => {
    const spends = await spendsOf(await liveTransactionsBetween(firstMonth, lastMonth))
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
