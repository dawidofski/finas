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

import { medianOf } from '../lib/stats'

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

/**
 * The smallest spread a category is judged against, and it is a decision about money rather than about statistics.
 *
 * Its first job is to make a degenerate scale harmless: several identical charges give a MAD of zero, and without a
 * floor the one genuine one-off beside them divides by zero. That shape is not exotic — it is what a subscription
 * looks like, and §13.1 asks for exactly that one-off to be noticed.
 *
 * Its second job is the one worth stating out loud. A floor of one euro means a purchase must sit about 5,19 € away
 * from the usual before it is called unusual, **whatever** the category's own spread. For a category whose real
 * spread is a few cents that is the floor talking rather than the data — deliberately, because "you spent 52 cents
 * more than usual" is not a finding, it is noise wearing a statistic's clothes. The owner reads euros, so the
 * smallest deviation worth a sentence is set in euros.
 *
 * `madCents` in the output still reports the TRUE spread, zero included, so the figure stays honest about the data
 * even where the score is set by this floor.
 */
export const MIN_SCALE_CENTS = 100

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
    if (mad === null) continue
    // Floor the scale. A regular charge (a subscription) has a MAD of 0, and dividing by it would score every one-off as
    // infinitely unusual; a MAD of a cent or two is the same problem, since it turns a 50 cent wobble into an outlier.
    // Flooring at 1.00 means a deviation must be about 5.19 (6745 * 519 / 100 = 35007 bp) to be reported against a
    // perfectly regular category. It also makes a division by zero unreachable. madCents reports the true MAD.
    const scale = Math.max(mad, MIN_SCALE_CENTS)
    for (const r of group) {
      const scoreBp = divRound(MAD_SCALE_BP * (r.cents - median), scale)
      if (scoreBp < UNUSUAL_SCORE_BP) continue
      found.push({ transactionId: r.id, categoryId, cents: r.cents, month: r.month, medianCents: median, madCents: mad, scoreBp })
    }
  }

  // Total order, so the answer never depends on input order: most unusual first, then by id (unique per transaction).
  return found.sort((a, b) => b.scoreBp - a.scoreBp || (a.transactionId < b.transactionId ? -1 : a.transactionId > b.transactionId ? 1 : 0))
}
