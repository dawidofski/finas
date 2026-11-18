// The statistics the §12 battery is built on: Spearman's rho, Mann-Whitney U with its rank-biserial effect size,
// chi-square, and Cramer's V. Pure functions over plain numbers; nothing here reads the database or keeps state.
//
// §12 chooses non-parametric tests deliberately, because transaction amounts are heavily right-skewed and a mean or a
// Pearson correlation would be dragged around by the long tail. That choice is what makes integer arithmetic possible:
// every statistic below is a function of ranks or of counts, never of the amounts themselves, so none of them needs a
// float. Ranks are integers once doubled (see doubledRanks), rho and rank-biserial r are ratios of integers,
// chi-square is rational throughout, and Cramer's V needs one square root, which isqrt supplies to the basis point.
//
// Effect sizes come back in basis points: 1 bp = 1/10000, so 10000 bp is 1.0 and -10000 bp is -1.0. That is the unit
// the budget screens already read percentages in. Chi-square comes back multiplied by CHI_SCALE.
//
// Every function returns null where its statistic is undefined - too few values, a series with no variance, a table
// with an empty row or column - rather than a number that would read as an answer. A rho of 0 and "there is nothing
// to correlate" are different statements, and only one of them is a number.
//
// The one division written in this file is the integer floor inside divFloor, which isqrt needs; everything else
// divides through divRound. src/battery/stats.test.ts asserts that, in the style of src/learning/bayes.test.ts.

import { divRound } from '../lib/money'

/** Chi-square is returned multiplied by this, so a rational chi-square survives as an integer. */
export const CHI_SCALE = 10000

/** 1.0 in basis points. */
const BP_ONE = 10000

/** floor(n / d) for integers n >= 0, d > 0. The only division written in this file. */
function divFloor(n: number, d: number): number {
  return Math.floor(n / d)
}

/**
 * floor(sqrt(n)) for a non-negative safe integer n, exactly - no Math.sqrt, so no float can round the answer up to a
 * value whose square exceeds n. Throws on a negative or non-integer argument rather than inventing a root for it.
 */
export function isqrt(n: number): number {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`isqrt needs a non-negative safe integer, got ${String(n)}`)
  if (n < 2) return n // the loop below needs x >= 1 with floor(n / x) >= 1; 0 and 1 are their own roots anyway
  // Newton's method on integers: x <- floor((x + floor(n / x)) / 2), started at x = n.
  //
  // Why it terminates: the loop steps only while the next iterate is strictly smaller than the current one, so the x
  // values form a strictly decreasing sequence. Every x stays a positive integer (x >= 1, and with n >= 2 the term
  // floor(n / x) is at least 1, so the average of the two is at least 1). A strictly decreasing sequence of positive
  // integers cannot be infinite - it can take at most x steps from its first value - so the loop ends. It is much
  // faster than that bound in practice, because Newton roughly halves the number of wrong digits each step.
  //
  // Why it ends at the right place: for any integer x >= 1 the arithmetic mean of x and n/x is at least sqrt(n)
  // (AM-GM), so no iterate ever drops below floor(sqrt(n)); and the map can still decrease at any x above
  // floor(sqrt(n)). So the first iterate that fails to decrease is floor(sqrt(n)) itself.
  let x = n
  let next = divFloor(x + divFloor(n, x), 2)
  while (next < x) {
    x = next
    next = divFloor(x + divFloor(n, x), 2)
  }
  return x
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
 * rho = 1 - 6 * sum(d^2) / (n(n^2-1)), where d is the difference of the two ranks of a pair. The ranks here are
 * doubled, so each difference is 2d and sum(dd^2) is 4 * sum(d^2) - hence the 4 in the denominator below. Numerator
 * and denominator are both integers, so the basis-point answer is the correctly rounded one.
 *
 * KNOWN LIMITATION, worth stating because §12's first relationship walks straight into it: that formula is Spearman's
 * rho exactly only when neither series has ties. With ties the honest definition is Pearson's correlation of the
 * ranks, and this formula over-reports (ties shrink the rank spread, which shrinks sum(d^2)). On a heavily tied series
 * the gap is large: see the worked example in stats.test.ts, where three tied values out of five move rho from -0.8944
 * to -0.7000. Mood valence and a worthwhile flag are exactly that shape. The test pins both numbers so the choice is
 * visible rather than accidental.
 */
export function spearmanRhoBp(xs: readonly number[], ys: readonly number[]): number | null {
  const n = xs.length
  if (n !== ys.length) return null
  if (n < 3) return null
  const rx = doubledRanks(xs)
  const ry = doubledRanks(ys)
  if (!varies(rx) || !varies(ry)) return null
  let sumSquaredDoubledDiffs = 0
  for (let i = 0; i < n; i++) {
    const a = rx[i]
    const b = ry[i]
    if (a === undefined || b === undefined) return null
    const d = a - b
    sumSquaredDoubledDiffs += d * d
  }
  const numerator = 6 * BP_ONE * sumSquaredDoubledDiffs
  if (!Number.isSafeInteger(numerator)) throw new RangeError('Too many pairs for an exact integer Spearman')
  return BP_ONE - divRound(numerator, 4 * n * (n * n - 1))
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
 * gives the identical form used here, which keeps the intermediate products far smaller:
 *
 *     sum((O-E)^2/E) = sum(O^2/E) - 2*total + total = total * sum(O^2 / (row*col)) - total
 *
 * Each cell's term is correctly rounded to one unit of 1/CHI_SCALE and the final subtraction is exact, so the result
 * is within (cells / 2) units of the true chi-square - under 0.001 for any table §12 builds. An exactly independent
 * table gives exactly 0, with no rounding at all, because then O = row*col/total and each term is the integer O.
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
  let sumScaled = 0
  for (const [i, row] of table.entries()) {
    const rowSum = rowSums[i]
    if (rowSum === undefined) return null
    for (const [j, observed] of row.entries()) {
      const colSum = colSums[j]
      if (colSum === undefined) return null
      const numerator = CHI_SCALE * observed * observed * total
      if (!Number.isSafeInteger(numerator)) throw new RangeError('Counts too large for an exact integer chi-square')
      sumScaled += divRound(numerator, rowSum * colSum)
    }
  }
  return { chiScaled: sumScaled - CHI_SCALE * total, df: (rows - 1) * (cols - 1) }
}

/**
 * Cramer's V in basis points from a CHI_SCALE-scaled chi-square, or null where there is no V: a negative chi-square,
 * a table with no observations, or fewer than two rows or two columns.
 *
 * V = sqrt(chi-square / (total * k)) with k = min(rows-1, cols-1) - the SMALLER dimension, which is what keeps V
 * inside [0, 1]. In basis points that is sqrt(CHI_SCALE * chiScaled / (total * k)), since the two scalings of 10000
 * (one from the basis points, one from chiScaled) leave a single factor of CHI_SCALE behind.
 *
 * isqrt floors, so V is reported at most one basis point low and never high: an effect size here is never overstated.
 */
export function cramersVBp(chiScaled: number, total: number, rows: number, cols: number): number | null {
  if (chiScaled < 0 || total <= 0 || rows < 2 || cols < 2) return null
  const k = Math.min(rows - 1, cols - 1)
  return isqrt(divRound(CHI_SCALE * chiScaled, total * k))
}
