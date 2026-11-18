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
  /** The date of every payment in the series, oldest first. The store matches a stored row to a series by one of them. */
  paymentDates: string[]
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

interface Cluster { merchantId: string; payments: Payment[]; median: number }

/**
 * Groups clusters into series. Two clusters at one merchant are ONE payment whose price changed when they do not overlap in time
 * (every payment of the earlier is before every payment of the later) and the gap from the earlier series' last payment to the
 * later cluster's first fits the earlier series' own cadence band, so the later one is where the cadence says the next payment
 * would fall. The earlier series needs at least two payments to have a cadence at all; the later part needs no minimum of its
 * own, because the series carries the occurrences. Two subscriptions that run at the same time overlap in time and stay
 * separate. Clusters are taken in order of their first payment, and each joins the open series with the smallest such gap.
 */
function seriesOf(clusters: readonly Cluster[]): Cluster[][] {
  const out: Cluster[][] = []
  const byMerchant = new Map<string, Cluster[]>()
  for (const c of clusters) byMerchant.set(c.merchantId, [...(byMerchant.get(c.merchantId) ?? []), c])
  for (const list of byMerchant.values()) {
    const ordered = [...list].sort((a, b) => ((a.payments[0] as Payment).date < (b.payments[0] as Payment).date ? -1 : (a.payments[0] as Payment).date > (b.payments[0] as Payment).date ? 1 : a.median - b.median))
    const open: Cluster[][] = []
    for (const c of ordered) {
      const first = (c.payments[0] as Payment).date
      let best: Cluster[] | null = null
      let bestGap = 0
      for (const s of open) {
        const pays = s.flatMap((x) => x.payments)
        const lastDate = (pays[pays.length - 1] as Payment).date
        if (pays.length < 2 || lastDate >= first) continue
        const gaps: number[] = []
        for (let i = 1; i < pays.length; i++) gaps.push(daysBetween((pays[i - 1] as Payment).date, (pays[i] as Payment).date))
        const { frequency } = classify(gaps, medianOf(gaps) ?? 0)
        const band = BANDS.find((b) => b.frequency === frequency)
        const gap = daysBetween(lastDate, first)
        if (band && gap >= band.lo && gap <= band.hi && (best === null || gap < bestGap)) { best = s; bestGap = gap }
      }
      if (best) best.push(c)
      else { const s = [c]; open.push(s); out.push(s) }
    }
  }
  return out
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

  const clusters: Cluster[] = []
  const open = new Map<string, Cluster[]>()
  for (const r of sorted) {
    let list = open.get(r.merchantId)
    if (!list) { list = []; open.set(r.merchantId, list) }
    let best: Cluster | null = null
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

  // A price change that leaves the amount tolerance starts a new cluster. Chain such clusters into one series: see seriesOf.
  const out: Detected[] = []
  for (const series of seriesOf(clusters)) {
    const payments = series.flatMap((c) => c.payments)
    const n = payments.length
    const last = payments[n - 1]
    if (n < MIN_OCCURRENCES || !last) continue
    const gaps: number[] = []
    for (let i = 1; i < n; i++) gaps.push(daysBetween((payments[i - 1] as Payment).date, (payments[i] as Payment).date))
    const medianGap = medianOf(gaps) ?? 0
    const { frequency, inBand } = classify(gaps, medianGap)
    const tail = series[series.length - 1] as Cluster
    const before = series[series.length - 2]
    // Chained: the typical amount of the earlier part against the later part. Within one cluster: the sustained-change rule.
    const change = before ? { fromCents: before.median, toCents: tail.median } : sustainedChange(payments.map((p) => p.amount))
    // After a change the current amount is the new one, so a cost per month is never worked out from the old price.
    const amountCents = change ? change.toCents : tail.median
    out.push({
      merchantId: tail.merchantId,
      amountCents,
      toleranceCents: toleranceOf(amountCents),
      frequency,
      occurrences: n,
      lastSeenDate: last.date,
      paymentDates: payments.map((p) => p.date),
      expectedNextDate: frequency === 'irregular' ? null : addDays(last.date, medianGap),
      matchScoreBp: frequency === 'irregular' ? 0 : matchScoreBp(inBand, gaps.length, n),
      amountChanged: change,
    })
  }
  return out.sort((a, b) =>
    a.merchantId < b.merchantId ? -1 : a.merchantId > b.merchantId ? 1
      : a.amountCents !== b.amountCents ? a.amountCents - b.amountCents
        : a.lastSeenDate < b.lastSeenDate ? -1 : a.lastSeenDate > b.lastSeenDate ? 1 : 0)
}
