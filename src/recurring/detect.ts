import type { RecurringRow } from '../db/schema'
import { addDays, daysBetween } from '../lib/dates'
import { divRound } from '../lib/money'
import { medianOf } from '../lib/stats'

export type Frequency = RecurringRow['frequency']

export interface Detected {
  merchantId: string
  /** Typical amount of the payment (median of the cluster), a positive magnitude. */
  amountCents: number
  /** How far an amount may sit from the cluster median and still be this payment. */
  toleranceCents: number
  frequency: Frequency
  occurrences: number
  lastSeenDate: string
  /** Last seen plus the median gap; null for 'irregular', where there is no honest date to give. */
  expectedNextDate: string | null
  /** 0-10000 basis points: how well the evidence pins the pattern. See detectRecurring. */
  matchScoreBp: number
  /** Earlier typical amount (median before the latest payment) to the latest, when they differ. */
  amountChanged: { fromCents: number; toCents: number } | null
}

/** Two payments are not a pattern. */
export const MIN_OCCURRENCES = 3

const MIN_TOLERANCE_CENTS = 100
const TOLERANCE_PERCENT = 5

interface Payment { date: string; amount: number }

function toleranceOf(median: number): number {
  return Math.max(MIN_TOLERANCE_CENTS, divRound(median * TOLERANCE_PERCENT, 100))
}

const BANDS: readonly { frequency: Exclude<Frequency, 'irregular'>; lo: number; hi: number }[] = [
  { frequency: 'weekly', lo: 5, hi: 9 },
  { frequency: 'monthly', lo: 26, hi: 35 },
  { frequency: 'quarterly', lo: 80, hi: 100 },
  { frequency: 'annual', lo: 350, hi: 380 },
]

/**
 * The band the median gap falls in, if at least two thirds of ALL gaps also fall in it (gapsInBand * 3 >= gaps * 2, integers);
 * otherwise 'irregular'. Two bills on days 1 and 8 give gaps 7,23,7,23,7: median 7 but only 3 of 5 in the weekly band, so
 * not weekly.
 */
function classify(gaps: readonly number[], medianGap: number): { frequency: Frequency; inBand: number } {
  const band = BANDS.find((b) => medianGap >= b.lo && medianGap <= b.hi)
  if (!band) return { frequency: 'irregular', inBand: 0 }
  const inBand = gaps.filter((g) => g >= band.lo && g <= band.hi).length
  if (inBand * 3 < gaps.length * 2) return { frequency: 'irregular', inBand }
  return { frequency: band.frequency, inBand }
}

/**
 * matchScoreBp = steadiness * count / 10000, an integer in 0..10000; an 'irregular' cluster scores 0 (no band to fit).
 *   steadiness = gapsInBand * 10000 / gaps (share of gaps inside the frequency's band, in bp)
 *   count      = (n - 1) * 10000 / (n + 1) for n payments (3 -> 5000, 4 -> 6000, 12 -> 8462; never reaches 10000)
 * More in-band gaps can only raise steadiness and more payments can only raise count, so it is monotone in both.
 * It says how well the evidence pins the pattern, nothing more; it is not a probability that the payment will recur.
 */
function matchScoreBp(inBand: number, gaps: number, n: number): number {
  const steadiness = divRound(inBand * 10000, gaps)
  const count = divRound((n - 1) * 10000, n + 1)
  return divRound(steadiness * count, 10000)
}

const CHANGE_MIN_CENTS = 50
const CHANGE_PERCENT = 2

/**
 * A price change is reported only when sustained: the latest two payments both differ from the median of the payments before
 * them, in the same direction, by more than max(50 cents, 2% of that median). A variable bill that wobbles reports nothing.
 */
function sustainedChange(amounts: readonly number[]): { fromCents: number; toCents: number } | null {
  if (amounts.length < 3) return null
  const m = medianOf(amounts.slice(0, -2))
  const prev = amounts[amounts.length - 2]
  const last = amounts[amounts.length - 1]
  if (m === null || prev === undefined || last === undefined) return null
  const threshold = Math.max(CHANGE_MIN_CENTS, divRound(m * CHANGE_PERCENT, 100))
  const up = prev - m > threshold && last - m > threshold
  const down = m - prev > threshold && m - last > threshold
  return up || down ? { fromCents: m, toCents: last } : null
}

/**
 * Finds recurring payments from the gaps between payments to one merchant. Pure: no database, no clock.
 *
 * Precondition: the caller passes spends only (no refunds or credits); Math.abs would otherwise merge a refund into the
 * payments at the same merchant.
 *
 * Internally every amount is an absolute value (the bank's amount for a spend is negative, money out); `amountCents` and the
 * other figures in Detected are positive magnitudes.
 *
 * Deterministic: rows are sorted by merchantId, then valueDate, then absolute amount before clustering, so the same rows in any
 * order give the same clusters. Within a merchant, each payment joins the existing cluster whose median it is nearest to
 * (earliest-created on a tie) provided it is within max(100 cents, 5% of that median) of it; otherwise it starts a new cluster.
 * Clusters with fewer than MIN_OCCURRENCES payments are not reported. Frequency comes from the median gap in days between
 * consecutive payments of a cluster, and only if two thirds of the gaps fit that frequency's band (see classify). Output is ordered by merchantId, amount, then last seen.
 */
export function detectRecurring(rows: readonly { merchantId: string; valueDate: string; amountCents: number }[]): Detected[] {
  const sorted = rows
    .map((r) => ({ merchantId: r.merchantId, date: r.valueDate, amount: Math.abs(r.amountCents) }))
    .sort((a, b) => (a.merchantId < b.merchantId ? -1 : a.merchantId > b.merchantId ? 1 : a.date < b.date ? -1 : a.date > b.date ? 1 : a.amount - b.amount))

  const clusters: { merchantId: string; payments: Payment[]; median: number }[] = []
  const open = new Map<string, typeof clusters>()
  for (const r of sorted) {
    let list = open.get(r.merchantId)
    if (!list) { list = []; open.set(r.merchantId, list) }
    let best: (typeof clusters)[number] | null = null
    let bestDistance = 0
    for (const c of list) {
      const distance = Math.abs(r.amount - c.median)
      if (distance <= toleranceOf(c.median) && (best === null || distance < bestDistance)) { best = c; bestDistance = distance }
    }
    if (best) {
      best.payments.push({ date: r.date, amount: r.amount })
      best.median = medianOf(best.payments.map((p) => p.amount)) ?? best.median
    } else {
      const c = { merchantId: r.merchantId, payments: [{ date: r.date, amount: r.amount }], median: r.amount }
      list.push(c)
      clusters.push(c)
    }
  }

  const out: Detected[] = []
  for (const c of clusters) {
    const n = c.payments.length
    const last = c.payments[n - 1]
    if (n < MIN_OCCURRENCES || !last) continue
    const gaps: number[] = []
    for (let i = 1; i < n; i++) gaps.push(daysBetween((c.payments[i - 1] as Payment).date, (c.payments[i] as Payment).date))
    const medianGap = medianOf(gaps) ?? 0
    const { frequency, inBand } = classify(gaps, medianGap)
    out.push({
      merchantId: c.merchantId,
      amountCents: c.median,
      toleranceCents: toleranceOf(c.median),
      frequency,
      occurrences: n,
      lastSeenDate: last.date,
      expectedNextDate: frequency === 'irregular' ? null : addDays(last.date, medianGap),
      matchScoreBp: frequency === 'irregular' ? 0 : matchScoreBp(inBand, gaps.length, n),
      amountChanged: sustainedChange(c.payments.map((p) => p.amount)),
    })
  }
  return out.sort((a, b) =>
    a.merchantId < b.merchantId ? -1 : a.merchantId > b.merchantId ? 1
      : a.amountCents !== b.amountCents ? a.amountCents - b.amountCents
        : a.lastSeenDate < b.lastSeenDate ? -1 : a.lastSeenDate > b.lastSeenDate ? 1 : 0)
}
