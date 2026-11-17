/**
 * Unusual spending: a purchase far above what is normal for THIS owner in THAT category (spec 13.1). Never an absolute
 * threshold: 300 EUR is routine for rent and wildly unusual for coffee.
 *
 * Non-parametric on purpose (spec 12): amounts are heavily right-skewed, so a mean and a standard deviation are dragged
 * by the very outliers we are hunting. The median and the median absolute deviation (MAD) are not. The score is the
 * modified z-score of Iglewicz and Hoaglin, 0.6745 * (x - median) / MAD, held in basis points (1% = 100 bp, so 1.0 is
 * 10000 bp) and computed in integers: 6745 * (x - median) / MAD, rounded once at the end.
 *
 * Amounts are spending magnitudes in integer cents (the caller passes expenses as positive numbers). Rows with no
 * category are skipped: "uncategorised" is a heap of unrelated things, so there is no history of its own to compare to.
 */

export interface UnusualRow {
  id: string
  categoryId: string | null
  cents: number
  month: string
}

export interface Unusual {
  transactionId: string
  categoryId: string | null
  cents: number
  month: string
  medianCents: number
  madCents: number
  scoreBp: number // robust z-score in basis points
}

/** 0.6745 in ten-thousandths: makes the MAD comparable to a standard deviation for roughly normal data. */
const MAD_SCALE_BP = 6745

/** A modified z-score of 3.5 or more is the conventional "outlier" line. Only the high side is reported. */
export const UNUSUAL_SCORE_BP = 35000

function divFloor(n: number, d: number): number {
  return Math.floor(n / d)
}

/** round(n / d), halves away from zero, integer-only. d > 0. The house rounding (see money.ts and income.ts). */
function divRound(n: number, d: number): number {
  const q = divFloor(Math.abs(n), d)
  const r = Math.abs(n) - q * d
  const rounded = r * 2 >= d ? q + 1 : q
  return n < 0 ? -rounded : rounded
}

/**
 * Median of an ascending-sorted integer sample, or null when it is empty. For an even count the two middle values are
 * averaged and, since there is no half-cent, a .5 rounds away from zero (up, for the non-negative amounts we hold):
 * the same rule as every other rounding in the app, and it keeps the median an integer without a float anywhere.
 */
function medianOfSorted(sorted: number[]): number | null {
  const n = sorted.length
  const upper = sorted[divFloor(n, 2)]
  if (upper === undefined) return null
  if (n % 2 === 1) return upper
  const lower = sorted[divFloor(n, 2) - 1]
  if (lower === undefined) return null
  return divRound(lower + upper, 2)
}

function medianOf(values: number[]): number | null {
  return medianOfSorted([...values].sort((a, b) => a - b))
}

/** Every purchase in a category with at least `minSample` rows that is unusually high against that category's own history. */
export function unusualIn(rows: UnusualRow[], minSample: number): Unusual[] {
  const byCategory = new Map<string, UnusualRow[]>()
  for (const row of rows) {
    if (row.categoryId === null) continue
    const group = byCategory.get(row.categoryId)
    if (group) group.push(row)
    else byCategory.set(row.categoryId, [row])
  }

  const found: Unusual[] = []
  for (const [categoryId, group] of byCategory) {
    if (group.length < minSample) continue
    const median = medianOf(group.map((r) => r.cents))
    if (median === null) continue
    const mad = medianOf(group.map((r) => Math.abs(r.cents - median)))
    // A MAD of zero (most amounts identical, e.g. a fixed subscription) leaves nothing to measure against: dividing by
    // it would give an infinite score. Say nothing rather than report "infinitely unusual".
    if (mad === null || mad <= 0) continue
    for (const r of group) {
      const scoreBp = divRound(MAD_SCALE_BP * (r.cents - median), mad)
      if (scoreBp < UNUSUAL_SCORE_BP) continue
      found.push({ transactionId: r.id, categoryId, cents: r.cents, month: r.month, medianCents: median, madCents: mad, scoreBp })
    }
  }

  // Total order, so the answer never depends on input order: most unusual first, then by id (unique per transaction).
  return found.sort((a, b) => b.scoreBp - a.scoreBp || (a.transactionId < b.transactionId ? -1 : a.transactionId > b.transactionId ? 1 : 0))
}
