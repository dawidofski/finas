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

function frequencyOfGap(medianGapDays: number): Frequency {
  if (medianGapDays >= 5 && medianGapDays <= 9) return 'weekly'
  if (medianGapDays >= 26 && medianGapDays <= 35) return 'monthly'
  if (medianGapDays >= 80 && medianGapDays <= 100) return 'quarterly'
  if (medianGapDays >= 350 && medianGapDays <= 380) return 'annual'
  return 'irregular'
}

/**
 * matchScoreBp = steadiness * count / 10000, an integer in 0..10000.
 *   steadiness = max(0, 10000 - 4 * relSpread), relSpread = (largest |gap - median gap| * 10000) / median gap, in bp
 *   count      = (n - 1) * 10000 / (n + 1) for n payments (3 -> 5000, 4 -> 6000, 12 -> 8462; never reaches 10000)
 * A wider spread of gaps can only lower steadiness and more payments can only raise count, so the score is monotone in both.
 * It says how well the evidence pins the pattern, nothing more; it is not a probability that the payment will recur.
 */
function matchScoreBp(gaps: readonly number[], medianGap: number, n: number): number {
  const maxDeviation = gaps.reduce((m, g) => Math.max(m, Math.abs(g - medianGap)), 0)
  const relSpreadBp = divRound(maxDeviation * 10000, Math.max(medianGap, 1))
  const steadiness = Math.max(0, 10000 - 4 * relSpreadBp)
  const count = divRound((n - 1) * 10000, n + 1)
  return divRound(steadiness * count, 10000)
}

/**
 * Finds recurring payments from the gaps between payments to one merchant. Pure: no database, no clock.
 *
 * Internally every amount is an absolute value (the bank's amount for a spend is negative, money out); `amountCents` and the
 * other figures in Detected are positive magnitudes.
 *
 * Deterministic: rows are sorted by merchantId, then valueDate, then absolute amount before clustering, so the same rows in any
 * order give the same clusters. Within a merchant, each payment joins the existing cluster whose median it is nearest to
 * (earliest-created on a tie) provided it is within max(100 cents, 5% of that median) of it; otherwise it starts a new cluster.
 * Clusters with fewer than MIN_OCCURRENCES payments are not reported. Frequency comes from the median gap in days between
 * consecutive payments of a cluster. Output is ordered by merchantId, amount, then last seen.
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
    const frequency = frequencyOfGap(medianGap)
    const earlier = medianOf(c.payments.slice(0, n - 1).map((p) => p.amount)) ?? last.amount
    out.push({
      merchantId: c.merchantId,
      amountCents: c.median,
      toleranceCents: toleranceOf(c.median),
      frequency,
      occurrences: n,
      lastSeenDate: last.date,
      expectedNextDate: frequency === 'irregular' ? null : addDays(last.date, medianGap),
      matchScoreBp: matchScoreBp(gaps, medianGap, n),
      amountChanged: earlier === last.amount ? null : { fromCents: earlier, toCents: last.amount },
    })
  }
  return out.sort((a, b) =>
    a.merchantId < b.merchantId ? -1 : a.merchantId > b.merchantId ? 1
      : a.amountCents !== b.amountCents ? a.amountCents - b.amountCents
        : a.lastSeenDate < b.lastSeenDate ? -1 : a.lastSeenDate > b.lastSeenDate ? 1 : 0)
}
