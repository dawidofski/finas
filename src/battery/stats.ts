// The statistics the §12 battery is built on: Spearman's rho, Mann-Whitney U with its rank-biserial effect size,
// chi-square, and Cramer's V. Pure functions over plain numbers; nothing here reads the database or keeps state.
//
// §12 chooses non-parametric tests deliberately, because transaction amounts are heavily right-skewed and a mean or a
// Pearson correlation would be dragged around by the long tail. That choice is what makes integer arithmetic possible:
// every statistic below is a function of ranks or of counts, never of the amounts themselves, so none of them needs a
// float. Ranks are integers once doubled (see doubledRanks), rank-biserial r is a ratio of integers, chi-square is
// rational throughout, and the two statistics that do need a square root - Spearman's rho and Cramer's V - take it
// from isqrtBig, which is Newton's method over BigInt and exact.
//
// BigInt, not float. Two of these statistics outgrow the safe-integer range on data the owner could really have:
// Spearman's rho needs the product of two sums of squared rank deviations, which overflows at about 660 paired
// observations, and chi-square needs CHI_SCALE * O^2 * total, which overflows at around 20000 annotated rows. BigInt
// is exact and unbounded, which is the opposite of a float rather than a relaxation of the rule, and it needs no
// dependency; src/battery/critical.ts reaches for it for the same class of overflow. Every intermediate that could
// overflow is a BigInt and no function here throws on a figure being too large, because a RangeError raised from a
// §12 relationship is an exception on a screen the owner opened, not a refusal they can act on. So every division
// written in this file is either a BigInt division - exact, truncating, and only ever on positive operands here - or
// divRound from src/lib/money.ts, which has no `/` at its call sites.
// src/battery/stats.test.ts asserts there is no third kind and that the file calls no Math function except Math.min,
// in the style of src/learning/bayes.test.ts.
//
// Effect sizes come back in basis points: 1 bp = 1/10000, so 10000 bp is 1.0 and -10000 bp is -1.0. That is the unit
// the budget screens already read percentages in. Chi-square comes back multiplied by CHI_SCALE.
//
// Every function returns null where its statistic is undefined - too few values, a series with no variance, a table
// with an empty row or column - rather than a number that would read as an answer. A rho of 0 and "there is nothing
// to correlate" are different statements, and only one of them is a number.

import { divRound } from '../lib/money'

/** Chi-square is returned multiplied by this, so a rational chi-square survives as an integer. */
export const CHI_SCALE = 10000

/** 1.0 in basis points. */
const BP_ONE = 10000

/**
 * A square root is taken scaled by this before it is floored, so the flooring is this many times finer than the
 * basis point reported. See spearmanRhoBp, where an unscaled floor would cost more than a basis point.
 */
const ROOT_SCALE = 100000000n

/**
 * floor(sqrt(n)) for a non-negative BigInt, exactly. Exported so its answers and its termination can be pinned
 * directly rather than only through the statistics that use it.
 */
export function isqrtBig(n: bigint): bigint {
  if (n < 0n) throw new RangeError(`isqrtBig needs a non-negative integer, got ${String(n)}`)
  if (n < 2n) return n // the loop below needs x >= 1 with n / x >= 1; 0 and 1 are their own roots anyway
  // Newton's method on integers: x <- floor((x + floor(n / x)) / 2), started at x = n. BigInt division truncates
  // toward zero, and every operand here is positive, so it IS the floor.
  //
  // Why it terminates: the loop steps only while the next iterate is strictly smaller than the current one, so the x
  // values form a strictly decreasing sequence. Every x stays a positive integer (x >= 1, and with n >= 2 the term
  // n / x is at least 1, so the average of the two is at least 1). A strictly decreasing sequence of positive
  // integers cannot be infinite - it can take at most x steps from its first value - so the loop ends. It is much
  // faster than that bound in practice, because Newton roughly halves the number of wrong digits each step.
  //
  // Why it ends at the right place: for any integer x >= 1 the arithmetic mean of x and n/x is at least sqrt(n)
  // (AM-GM), so no iterate ever drops below floor(sqrt(n)); and the map can still decrease at any x above
  // floor(sqrt(n)). So the first iterate that fails to decrease is floor(sqrt(n)) itself.
  const step = (x: bigint): bigint => (x + n / x) / 2n
  let x = n
  let next = step(x)
  while (next < x) {
    x = next
    next = step(x)
  }
  return x
}

/**
 * round(numerator / denominator) over BigInt, halves away from zero - the same rule divRound applies to Numbers, for
 * the one place where the numerator is past the safe-integer range. Exported so the test can hold the two rules
 * against each other: if they drifted apart, two parts of the app would round the same figure differently, which is
 * the mistake src/lib/stats.ts exists to prevent for the median.
 */
export function divRoundBig(numerator: bigint, denominator: bigint): bigint {
  const sign = numerator < 0n === denominator < 0n ? 1n : -1n
  const n = numerator < 0n ? -numerator : numerator
  const d = denominator < 0n ? -denominator : denominator
  const q = n / d
  const r = n - q * d
  return sign * (r * 2n >= d ? q + 1n : q)
}

/**
 * floor(sqrt(n)) for a non-negative safe integer n, exactly - no Math.sqrt, so no float can round the answer up to a
 * value whose square exceeds n. Throws on a negative or non-integer argument rather than inventing a root for it.
 * The work is isqrtBig's; the root of a safe integer is itself always a safe integer, so the conversion back is lossless.
 */
export function isqrt(n: number): number {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`isqrt needs a non-negative safe integer, got ${String(n)}`)
  return Number(isqrtBig(BigInt(n)))
}

/**
 * The rank of each value in its own position, ascending, multiplied by two. Tied values share the average of the ranks
 * they occupy, and that average is a half-integer exactly when the tie covers an even number of positions - so the
 * ranks are returned doubled, which clears the halving and keeps every rank an integer.
 *
 * Doubled ranks sum to n(n+1), whatever the ties, because doubling turns the sum 1+..+n into n(n+1).
 */
export function doubledRanks(values: readonly number[]): number[] {
  // Value-and-position pairs are sorted rather than bare indices, so the comparator never indexes the input and never
  // has to cope with the `number | undefined` that noUncheckedIndexedAccess gives every index expression.
  const ordered = values.map((value, index) => ({ value, index })).sort((p, q) => p.value - q.value)
  const doubled = new Array<number>(values.length).fill(0)
  let start = 0
  while (start < ordered.length) {
    const first = ordered[start]
    if (first === undefined) break
    let end = start
    for (;;) {
      const next = ordered[end + 1]
      if (next === undefined || next.value !== first.value) break
      end++
    }
    // Positions start..end are 0-based, so the tie occupies ranks start+1 .. end+1. Their average is
    // ((start+1) + (end+1)) / 2, and doubling cancels the halving: start + end + 2, an integer for any tie size.
    const rank2 = start + end + 2
    for (let k = start; k <= end; k++) {
      const entry = ordered[k]
      if (entry !== undefined) doubled[entry.index] = rank2
    }
    start = end + 1
  }
  return doubled
}

/** Whether a rank vector varies at all. All-equal ranks mean the series was constant, and nothing can be correlated with it. */
function varies(ranks: readonly number[]): boolean {
  const first = ranks[0]
  if (first === undefined) return false
  return ranks.some((r) => r !== first)
}

/**
 * Spearman's rho in basis points for paired series, or null when there is no rho to report: fewer than three pairs,
 * series of different lengths, or a series with no variance at all. Two pairs are excluded because the formula can
 * then only ever return +1 or -1, which is a claim no two points support.
 *
 * Spearman's rho IS Pearson's correlation of the ranks, and that is what is computed here - NOT the familiar
 * shortcut 1 - 6*sum(d^2)/(n(n^2-1)), which equals it only when neither series has ties. §12's primary
 * relationships (mood valence against amount, reason against worthwhile) put a short ordinal scale against amounts,
 * so they are tie-heavy, and the shortcut over-reports on them badly: on the five-pair example in stats.test.ts it
 * reads -0.70 where the honest answer is -0.89, because ties shrink the rank spread and so shrink sum(d^2). Where
 * there are no ties the two forms agree exactly, which the tests also pin - a correction that quietly moved the
 * untied answer would be broken.
 *
 * It stays integer arithmetic because the mean of the DOUBLED ranks is exactly n+1 (the mean rank is (n+1)/2, and
 * doubling clears the half). So every deviation a_i = rank2_i - (n+1) is an integer, and so are sum(a*b), sum(a^2)
 * and sum(b^2); rho = sum(a*b) / sqrt(sum(a^2) * sum(b^2)), whose product is held as a BigInt and rooted exactly.
 */
export function spearmanRhoBp(xs: readonly number[], ys: readonly number[]): number | null {
  const n = xs.length
  if (n !== ys.length) return null
  if (n < 3) return null
  const rx = doubledRanks(xs)
  const ry = doubledRanks(ys)
  if (!varies(rx) || !varies(ry)) return null
  const meanDoubledRank = n + 1
  let sumAB = 0n
  let sumAA = 0n
  let sumBB = 0n
  for (let i = 0; i < n; i++) {
    const rankA = rx[i]
    const rankB = ry[i]
    if (rankA === undefined || rankB === undefined) return null
    const a = BigInt(rankA - meanDoubledRank)
    const b = BigInt(rankB - meanDoubledRank)
    sumAB += a * b
    sumAA += a * a
    sumBB += b * b
  }
  // The root is taken SCALED, because isqrtBig floors and on a short series a bare floor costs more than a basis
  // point: for sum(a^2)*sum(b^2) = 4760 the root is 68.9927..., and flooring that to 68 would report 10000 bp where
  // the answer is 9856. isqrtBig(S * ROOT_SCALE^2) is floor(ROOT_SCALE * sqrt(S)), so the flooring is ROOT_SCALE
  // times finer than the unit reported - under 10^-4 bp - and the basis point is then the correctly rounded one.
  // Both varies() checks passed, so sum(a^2) and sum(b^2) are each at least 2 and the root cannot be zero.
  const root = isqrtBig(sumAA * sumBB * ROOT_SCALE * ROOT_SCALE)
  return Number(divRoundBig(sumAB * BigInt(BP_ONE) * ROOT_SCALE, root))
}

/**
 * Mann-Whitney U for two independent groups, with the rank-biserial effect size in basis points, or null when either
 * group is empty.
 *
 * `uDoubled` is U DOUBLED, for the same reason doubledRanks doubles a rank: U counts a tied pair as half a win, so U
 * itself is a half-integer whenever a value in `a` equals one in `b`. Doubled, it is 2 * wins + ties, always an
 * integer. The field is not called `u`, because a doubled number under a name that says U would be wrong in silence
 * for every tied pair - the same reason critical.ts names its parameter uDoubled, and it takes this value directly.
 *
 * rBp is the rank-biserial r, Kerby's "favourable minus unfavourable": r = (wins - losses) / (n1 * n2), which is
 * 2*U/(n1*n2) - 1 and so uDoubled/(n1*n2) - 1. It is +10000 when every value of `a` exceeds every value of `b`,
 * -10000 the other way round, and 0 when the two groups win equally often. (§12's shorthand `r = 1 - 2U/(n1*n2)` is
 * the same magnitude with the sign flipped, which would make a HIGHER `a` report a NEGATIVE r; it holds for U counted
 * the other way round, as b's wins, which is not the U the rank-sum identity gives. The direction here reads
 * correctly, and it is the one Kerby defines.)
 */
export function mannWhitneyU(a: readonly number[], b: readonly number[]): { uDoubled: number; rBp: number } | null {
  const n1 = a.length
  const n2 = b.length
  if (n1 === 0 || n2 === 0) return null
  let wins = 0
  let losses = 0
  for (const x of a) {
    for (const y of b) {
      if (x > y) wins++
      else if (x < y) losses++
    }
  }
  const pairs = n1 * n2
  const uDoubled = 2 * wins + (pairs - wins - losses)
  // uDoubled - pairs = (2*wins + ties) - (wins + losses + ties) = wins - losses, so r needs no second definition.
  return { uDoubled, rBp: divRound(BP_ONE * (uDoubled - pairs), pairs) }
}

/**
 * Pearson's chi-square for a contingency table of counts, multiplied by CHI_SCALE, with its degrees of freedom. Null
 * when the table cannot carry the statistic: fewer than two rows or two columns (no degree of freedom), a ragged row,
 * a negative or non-integer count, an empty table, or an empty row or column - an empty margin makes some expected
 * count zero, and (O-E)^2/E would be a division by it.
 *
 * chi-square = sum((O-E)^2 / E) with E = row * col / total. Expanding the square and using sum(O) = sum(E) = total
 * gives the identical form used here, which keeps every intermediate small and makes an independent table land on
 * exactly zero:
 *
 *     sum((O-E)^2/E) = sum(O^2/E) - 2*total + total = total * sum(O^2 / (row*col)) - total
 *
 * Each cell's term is correctly rounded to one unit of 1/CHI_SCALE and the final subtraction is exact, so the result
 * is within (cells / 2) units of the true chi-square - under 0.001 for any table §12 builds. An exactly independent
 * table gives exactly 0, with no rounding at all, because then O = row*col/total and each term is the integer O.
 *
 * The cell terms are accumulated as BigInt. CHI_SCALE * O^2 * total leaves the safe-integer range at around 20000
 * annotated rows, and a THROWN RangeError there is not a wrong number, it is an exception on the Intelligence screen
 * reached through a §12 relationship the owner did nothing unusual to trigger. "Unlikely to be reached" is not a
 * reason to leave a crash in place, so the intermediates are exact and unbounded instead. The RESULT is always a
 * safe integer and is returned as a Number: it is CHI_SCALE * chi-square, and chi-square cannot exceed
 * total * min(rows-1, cols-1), so it is bounded by the number of transactions the owner actually has.
 */
export function chiSquareScaled(table: readonly number[][]): { chiScaled: number; df: number } | null {
  const rows = table.length
  const firstRow = table[0]
  if (firstRow === undefined) return null
  const cols = firstRow.length
  if (rows < 2 || cols < 2) return null
  const rowSums: number[] = []
  const colSums = new Array<number>(cols).fill(0)
  let total = 0
  for (const row of table) {
    if (row.length !== cols) return null // ragged: the table is not a contingency table at all
    let rowSum = 0
    for (const [j, observed] of row.entries()) {
      if (!Number.isSafeInteger(observed) || observed < 0) return null
      const colSum = colSums[j]
      if (colSum === undefined) return null
      colSums[j] = colSum + observed
      rowSum += observed
    }
    rowSums.push(rowSum)
    total += rowSum
  }
  if (total === 0) return null
  if (rowSums.some((s) => s === 0)) return null
  if (colSums.some((s) => s === 0)) return null
  const totalBig = BigInt(total)
  const scaleBig = BigInt(CHI_SCALE)
  let sumScaled = 0n
  for (const [i, row] of table.entries()) {
    const rowSum = rowSums[i]
    if (rowSum === undefined) return null
    for (const [j, observed] of row.entries()) {
      const colSum = colSums[j]
      if (colSum === undefined) return null
      const o = BigInt(observed)
      sumScaled += divRoundBig(scaleBig * o * o * totalBig, BigInt(rowSum) * BigInt(colSum))
    }
  }
  return { chiScaled: Number(sumScaled - scaleBig * totalBig), df: (rows - 1) * (cols - 1) }
}

/**
 * Cramer's V in basis points from a CHI_SCALE-scaled chi-square, or null where there is no V: a negative chi-square,
 * a table with no observations, fewer than two rows or two columns, or a chiScaled or total that is not a safe
 * integer and so is not a figure this module will compute on at all.
 *
 * V = sqrt(chi-square / (total * k)) with k = min(rows-1, cols-1) - the SMALLER dimension, which is what keeps V
 * inside [0, 1]. In basis points that is sqrt(CHI_SCALE * chiScaled / (total * k)), since the two scalings of 10000
 * (one from the basis points, one from chiScaled) leave a single factor of CHI_SCALE behind.
 *
 * The product and the root are taken over BigInt, to match chiSquareScaled, whose output this consumes: the guards
 * above bound what comes in, and BigInt then bounds nothing on the way to the root, so no input that reaches here
 * can meet a ceiling. V itself never exceeds 10000 bp, so the answer always returns to a Number.
 *
 * isqrtBig floors, so V is reported at most one basis point low and never high: an effect size is never overstated.
 */
export function cramersVBp(chiScaled: number, total: number, rows: number, cols: number): number | null {
  if (!Number.isSafeInteger(chiScaled) || chiScaled < 0) return null
  if (!Number.isSafeInteger(total) || total <= 0) return null
  if (rows < 2 || cols < 2) return null
  const k = Math.min(rows - 1, cols - 1)
  return Number(isqrtBig(divRoundBig(BigInt(CHI_SCALE) * BigInt(chiScaled), BigInt(total) * BigInt(k))))
}
