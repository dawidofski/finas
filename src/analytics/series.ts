import { cached } from './cache'
import { monthSummary, type MonthSummary } from './monthly'

/**
 * One month of the series. `hasData` false means the month has no live transactions: it is a GAP, not a month of zero spending.
 * For such a month every money figure is empty and says so: monthSummary would otherwise offer a trailing-average income
 * estimate for a month that has nothing in it, and a chart would plot an invented figure. A screen must draw a gap (break the
 * line, show no bar) wherever hasData is false, and never join across it.
 */
export interface MonthPoint extends MonthSummary { hasData: boolean }

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/

/** The month after `month`, by integer arithmetic on the key. No date is constructed, so no timezone can move it. */
function nextMonth(month: string): string {
  const m = MONTH_RE.exec(month)
  if (!m) throw new Error(`Invalid month: ${month}`)
  const year = Number(m[1])
  const mm = Number(m[2])
  return mm === 12 ? `${String(year + 1).padStart(4, '0')}-01` : `${m[1]}-${String(mm + 1).padStart(2, '0')}`
}

function gapOf(s: MonthSummary): MonthPoint {
  return { ...s, incomeCents: 0, netCents: 0, provisional: true, incomeBasis: 'none', hasData: false }
}

/**
 * Every month from `from` to `to` inclusive, oldest first, one point each. A month with no data is present and marked
 * hasData false: it is never dropped (the axis would silently skip it) and never filled in from its neighbours.
 * `computedAt` is passed through to the cache rows (the clock is read only at sanctioned boundaries). An inverted range is empty.
 */
export async function monthSeries(from: string, to: string, today: string, computedAt: number): Promise<MonthPoint[]> {
  if (!MONTH_RE.test(from)) throw new Error(`Invalid month: ${from}`)
  if (!MONTH_RE.test(to)) throw new Error(`Invalid month: ${to}`)
  return cached(`monthSeries:${from}:${to}`, async () => {
    const months: string[] = []
    for (let m = from; m <= to; m = nextMonth(m)) months.push(m)
    const summaries = await Promise.all(months.map((m) => monthSummary(m, today, computedAt)))
    // Sorted explicitly: the order is the months' own, never the order the reads happened to finish in.
    return summaries
      .map((s): MonthPoint => (s.transactions > 0 ? { ...s, hasData: true } : gapOf(s)))
      .sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0))
  }, computedAt)
}

export interface Change {
  /** current − previous. With basis 'none' there is nothing to compare against and this is the current figure itself, not a change. */
  cents: number
  /** Basis points of the previous figure's magnitude; null when there is no basis (never 0 for "no answer"). */
  bp: number | null
  basis: 'month' | 'none'
}

/** The money and count fields of a MonthSummary: the ones that can be subtracted. */
export type NumericField = { [K in keyof MonthSummary]: MonthSummary[K] extends number ? K : never }[keyof MonthSummary]

/** Integer division rounding half away from zero. */
function roundedDiv(n: number, d: number): number {
  const q = Math.abs(n) / Math.abs(d)
  const r = Math.floor(q + 0.5)
  return (n < 0) !== (d < 0) ? -r : r
}

/**
 * How `current` moved from `previous`. Without a previous month, or when the previous month is a gap (no data), there is no
 * basis: bp is null and basis is 'none', so a screen says "no earlier month" instead of a 100% rise. A previous VALUE of zero
 * in a month that has data also gives bp null (a percentage of nothing), but the basis stays 'month' because the cents are real.
 * The percentage is against the previous figure's magnitude, so a loss shrinking from -200 to -100 reads as a rise.
 */
export function changeFrom(previous: MonthSummary | null, current: MonthSummary, field: NumericField): Change {
  if (previous === null || previous.transactions === 0) {
    return { cents: current[field], bp: null, basis: 'none' }
  }
  const cents = current[field] - previous[field]
  const bp = previous[field] === 0 ? null : roundedDiv(cents * 10000, Math.abs(previous[field]))
  return { cents, bp, basis: 'month' }
}
