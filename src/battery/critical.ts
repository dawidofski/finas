import { CHI_SCALE } from './stats'

/**
 * How certain a battery result is, as one of three brackets — and nothing more precise.
 *
 * A p-value needs a continuous distribution function, which needs floats, and this application contains no
 * floating-point arithmetic anywhere (src/sourceRules.test.ts enforces that over every file in src/). Both rank tests
 * §12 asks for have a normal approximation whose significance test becomes an exact INTEGER inequality once both
 * sides are squared, which removes the square root. What is left is a handful of constants a reviewer can check from
 * memory: the two-tailed normal criticals 1.96 and 2.5758, and the chi-square criticals at small degrees of freedom.
 *
 * The squaring is an algebraic rearrangement, so it is worth only as much as its agreement with the thing it
 * replaces. critical.test.ts computes z the ordinary way — a real square root, a real division, a float comparison —
 * and asserts this module reaches the same verdict on both sides of every threshold, over every value of the
 * statistic at several sample sizes. A test may use floating point; this module may not.
 *
 * There is no division anywhere in this file: removing the square root removed the denominator with it. So the float
 * guard in critical.test.ts can insist on something stronger than the usual rule: not a single slash in the code.
 */
export type Bracket = 'p<0.01' | 'p<0.05' | 'none'

/**
 * Each bracket's UPPER BOUND, in basis points, standing in for the p this module deliberately never computes.
 * Benjamini–Hochberg reads these: taking the bound rather than the true p can only withhold a finding, never invent
 * one, which is the direction this application errs in everywhere else too.
 */
export const ALPHA_BP = { 'p<0.01': 100, 'p<0.05': 500 } as const

/**
 * The two-tailed normal criticals, in basis points — ten-thousandths — because a decimal literal is banned in src/:
 * 1.96 is float arithmetic waiting to happen, 19600 is a count.
 *
 * Both are rounded UP from the true critical value, so both ask for a hair more than they strictly must and both can
 * only withhold a finding, never invent one:
 * - 19600 is 1.96, just above the true 1.9599640.
 * - 25759 is 2.5759, just above the true 2.5758293. It was 25758 at first, which was BELOW the true value and so
 *   leant toward claiming — the only constant in the module that did. The cost of the change is one part in 100 000,
 *   far inside the error of the normal approximation these are critical values for, and what it buys is a property
 *   a reader can verify by inspection: every constant here errs toward silence. "All but one do" is a footnote
 *   nobody reads.
 */
export const Z_BP = { 'p<0.05': 19600, 'p<0.01': 25759 } as const

/**
 * Below this many paired observations spearmanBracket returns 'none' rather than a bracket.
 *
 * Spearman's z = ρ·√(n−1) is the standard large-sample approximation, and n = 10 is where it stops over-claiming.
 * At n = 10 it asks for |ρ| ≥ 1.96/√9 = 0.6533, where the tabulated exact two-tailed 5 % critical is ≈ 0.648: the
 * approximation demands slightly MORE than the exact test, so it errs toward silence. At n = 20 the two have
 * converged (1.96/√19 = 0.4496 against ≈ 0.447). Below n = 10 the comparison reverses — the approximation starts
 * calling things significant that the exact test does not — and ρ itself takes only a handful of distinct values, so
 * a bracket there would be a made-up finding rather than a weak one.
 *
 * §12's minimum-data gates do not cover this: category → savings performance runs on ≥ 4 months and
 * days-after-payday on ≥ 3 income events, so it is this floor, not the gate, that stops a four-point correlation
 * reporting a confidence it has not earned.
 */
const SPEARMAN_MIN_N = 10

/**
 * Both groups must reach this size or mannWhitneyBracket returns 'none'.
 *
 * At n₁ = n₂ = 8 the approximation asks for |U − 32| ≥ 1.96·√(64·17/12) = 1.96·9.5219 = 18.66, i.e. U ≤ 13 or
 * U ≥ 51 — and 13 is exactly the exact test's own two-tailed 5 % critical U for 8 against 8, so at this size the
 * approximation and the exact test agree on the verdict. Below it they come apart, and §12's weekend gate (≥ 8
 * weekends observed) sits precisely here, so the floor and the gate are the same line.
 *
 * The variance carries NO tie correction, deliberately. Ties make the true variance SMALLER, so using the untied
 * variance makes |z| smaller and the bracket weaker than it could be — the omission errs toward silence, which is
 * the direction this application errs in everywhere, so it stays.
 */
const MW_MIN_GROUP = 8

/**
 * Chi-square criticals in CHI_SCALE units — ten-thousandths of a chi-square value, which is the scale
 * chiSquareScaled already produces, so the comparison is a bare >= with nothing to convert and nothing to round.
 * CHI_SCALE is imported rather than restated, because a scale declared twice is this repository's most repeated
 * defect; the assertion in chiSquareBracket is a check ON that imported scale, not a second source for it.
 *
 * Each entry is the critical value rounded UP at the fourth decimal, so a statistic that reaches a stored entry has
 * genuinely reached the critical value: the rounding can withhold a finding, never invent one.
 *
 * Unlike a table of rank criticals per sample size, which is why those were rejected, these are standard textbook
 * rows and a reviewer can check any ONE of them against any statistics table without reading the others. Each row
 * names the unrounded value it was rounded up from, and the three-decimal figure in a printed table is that value
 * to three decimals.
 *
 * The first two rows check against the rest of this file rather than against a table. At df 1 the critical is z²,
 * the square of the true two-tailed normal criticals that Z_BP above rounds (1.9599640² = 3.8414588 and
 * 2.5758293² = 6.6348966); at df 2 it is −2·ln α exactly (−2·ln 0.05 = 5.9914645, −2·ln 0.01 = 9.2103404). Every
 * row was computed twice before it was written down: once from the regularized incomplete gamma function by
 * bisection, and once — for the even rows — from the closed-form even-df survival function in exact decimal
 * arithmetic. The two agreed to ten decimals on every entry they share, which is what caught df 18 at 0.05 sitting
 * at 28.8692994 rather than just over 28.8693, where the fourth-decimal ceiling differs.
 *
 * The table stops at df 20 and chiSquareBracket throws beyond it, rather than growing without limit: §12's widest
 * contingency relationship is reason × worthwhile, and the owner would need twenty-one purchase reasons against
 * three hindsight answers to pass this.
 */
const CHI_CRIT: readonly { readonly p05: number; readonly p01: number }[] = [
  { p05: 38415, p01: 66349 }, //   df 1:  3.8414588,  6.6348966
  { p05: 59915, p01: 92104 }, //   df 2:  5.9914645,  9.2103404
  { p05: 78148, p01: 113449 }, //  df 3:  7.8147279, 11.3448667
  { p05: 94878, p01: 132768 }, //  df 4:  9.4877290, 13.2767041
  { p05: 110705, p01: 150863 }, // df 5: 11.0704977, 15.0862725
  { p05: 125916, p01: 168119 }, // df 6: 12.5915872, 16.8118938
  { p05: 140672, p01: 184754 }, // df 7: 14.0671404, 18.4753069
  { p05: 155074, p01: 200903 }, // df 8: 15.5073131, 20.0902350
  { p05: 169190, p01: 216660 }, // df 9: 16.9189776, 21.6659943
  { p05: 183071, p01: 232093 }, // df 10: 18.3070381, 23.2092512
  { p05: 196752, p01: 247250 }, // df 11: 19.6751376, 24.7249703
  { p05: 210261, p01: 262170 }, // df 12: 21.0260698, 26.2169673
  { p05: 223621, p01: 276883 }, // df 13: 22.3620325, 27.6882496
  { p05: 236848, p01: 291413 }, // df 14: 23.6847913, 29.1412377
  { p05: 249958, p01: 305780 }, // df 15: 24.9957901, 30.5779142
  { p05: 262963, p01: 320000 }, // df 16: 26.2962276, 31.9999269
  { p05: 275872, p01: 334087 }, // df 17: 27.5871116, 33.4086636
  { p05: 288693, p01: 348054 }, // df 18: 28.8692994, 34.8053057
  { p05: 301436, p01: 361909 }, // df 19: 30.1435272, 36.1908691
  { p05: 314105, p01: 375663 }, // df 20: 31.4104328, 37.5662348
]

/**
 * BigInt, not Number, for the Mann–Whitney comparison only. Its left side is 3·10⁸·(2U − n₁n₂)², which passes
 * Number.MAX_SAFE_INTEGER at about n₁n₂ = 11 000 — two groups of a hundred annotated spends each, well inside what a
 * year of real data gives. Throwing there would make the module useless on the owner's own history, and rounding
 * there would make it dishonest, so the comparison is done in exact arbitrary-precision integers. Still no float,
 * still no division, and now no overflow either.
 */
const VARIANCE_DIVISOR_AFTER_DOUBLING = 3n // the 12 in n₁n₂(n₁+n₂+1)/12, after the 4 that doubling U contributes
const BASIS_POINTS_SQUARED = 100000000n // (10⁴)²: z_α is Z_BP/10⁴, so z_α² carries 10⁸

function assertInt(value: number, name: string): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new TypeError(`${name} must be a safe integer, got ${String(value)}`)
  }
}

/**
 * Spearman's ρ, in basis points, over n paired observations.
 *
 *   z = ρ·√(n−1), significant at α when |ρ|·√(n−1) ≥ z_α.
 *   Both sides are non-negative, so squaring preserves the inequality:  ρ²·(n−1) ≥ z_α².
 *   In basis points ρ² = rhoBp²/10⁸ and z_α² = Z_BP²/10⁸, and the 10⁸ cancels on both sides, leaving
 *
 *       rhoBp² · (n − 1)  ≥  Z_BP²
 *
 * which is the whole test, in integers, with no square root and no division. The left side is at most 10⁸·(n−1), so
 * it stays an exact Number out past n = 90 000 000; the assertion below is there for the day that stops being true.
 */
export function spearmanBracket(rhoBp: number, n: number): Bracket {
  assertInt(rhoBp, 'rhoBp')
  assertInt(n, 'n')
  if (rhoBp < -10000 || rhoBp > 10000) throw new RangeError(`rhoBp is a correlation in basis points, got ${rhoBp}`)
  if (n < 0) throw new RangeError(`n cannot be negative, got ${n}`)
  if (n < SPEARMAN_MIN_N) return 'none'
  const left = rhoBp * rhoBp * (n - 1)
  assertInt(left, 'rhoBp squared times n minus one')
  if (left >= Z_BP['p<0.01'] * Z_BP['p<0.01']) return 'p<0.01'
  if (left >= Z_BP['p<0.05'] * Z_BP['p<0.05']) return 'p<0.05'
  return 'none'
}

/**
 * Mann–Whitney U for two groups of n₁ and n₂ observations.
 *
 * The parameter is U DOUBLED, in 0..2n₁n₂, exactly as mannWhitneyU returns it — NOT U. U counts a tied pair as half
 * a win, so U itself is a half-integer whenever the two groups share a value, and the only producer of this
 * statistic in the repository therefore hands out 2U. Taking 2U here means the figure crosses the boundary without a
 * division and without a non-integer ever existing: the caller passes what it was given. The plan's interface for
 * this function named the parameter `u`, which would have made a plain U and a doubled U interchangeable to the type
 * checker and wrong in silence for about half the inputs; the name is the whole guard, so it says uDoubled.
 *
 * Derivation, from the z this is required to agree with. Write V = n₁n₂(n₁+n₂+1), so σ = √(V/12), and let
 * D = 2U − n₁n₂ = uDoubled − n₁n₂, an integer, and twice the deviation of U from its null mean n₁n₂/2. The test is
 * the continuity-corrected one, which shortens the deviation by half a unit of U before dividing by σ, because U is
 * discrete and the normal curve it is read against is not. The correction can only weaken a bracket.
 *
 *   z = (|U − n₁n₂/2| − 1/2) / √(V/12)                           the statistic, corrected, as a magnitude
 *   significant at α   ⟺   |U − n₁n₂/2| − 1/2 ≥ z_α·√(V/12)      σ > 0 for n₁, n₂ ≥ 1, so this is safe
 *                      ⟺   |D|/2 − 1/2 ≥ z_α·√(V/12)             U − n₁n₂/2 = D/2
 *                      ⟺   (|D| − 1)/2 ≥ z_α·√(V/12)             and |D| − 1 is an integer, so C = max(0, |D| − 1)
 *                      ⟺   C ≥ z_α·√(4V/12) = z_α·√(V/3)         the 2 goes under the root as a 4
 *                      ⟺   C² ≥ z_α²·V/3                         both sides non-negative, so squaring is faithful
 *                      ⟺   3·C² ≥ z_α²·V
 *                      ⟺   3·C² ≥ Z_BP²·V/10⁸                    z_α = Z_BP/10⁴, so z_α² = Z_BP²/10⁸
 *                      ⟺   3·10⁸·C² ≥ Z_BP²·V                    and now every term is an integer
 *
 * The last step is what makes it exact. The dividing-by-10⁸ form one line above is algebraically the same test but
 * is not an integer one, so the 10⁸ moves to the left-hand side rather than staying as a divisor.
 *
 * The max(0, …) in C keeps the expression faithful to the derivation: squaring is what makes this two-tailed, and
 * squaring is also what would turn a |D| of 0 — a result sitting exactly on the null midpoint — into a positive C²
 * of 1 if the clamp were missing. It is defence in depth and NOT currently observable, which is worth saying plainly
 * rather than claiming a test for: without it the left side at |D| = 0 would be 3·10⁸, and the smallest right side
 * MW_MIN_GROUP admits is Z_BP²·V at n₁ = n₂ = 8, which is 384 160 000 · 1088 = 417 966 080 000. The verdict cannot
 * change, so no test can kill the clamp, and critical.test.ts asserts that inequality instead — if the group floor
 * is ever lowered far enough for the clamp to matter, that assertion is what fails and sends the reader here.
 *
 * C² is why this is two-tailed with nothing extra: C depends on |D|, so uDoubled and 2n₁n₂ − uDoubled — a result as
 * far above the null midpoint as the other is below it — can only ever bracket the same.
 */
export function mannWhitneyBracket(uDoubled: number, n1: number, n2: number): Bracket {
  assertInt(uDoubled, 'uDoubled')
  assertInt(n1, 'n1')
  assertInt(n2, 'n2')
  if (n1 < 0 || n2 < 0) throw new RangeError(`group sizes cannot be negative, got ${n1} and ${n2}`)
  const pairs = n1 * n2
  if (uDoubled < 0 || uDoubled > 2 * pairs) {
    throw new RangeError(`uDoubled must lie in 0..${2 * pairs} for ${n1} against ${n2}, got ${uDoubled}`)
  }
  if (n1 < MW_MIN_GROUP || n2 < MW_MIN_GROUP) return 'none'
  const dBig = BigInt(uDoubled - pairs)
  const dAbs = dBig < 0n ? -dBig : dBig
  const c = dAbs > 0n ? dAbs - 1n : 0n // C = max(0, |D| − 1): the continuity correction, clamped
  const left = VARIANCE_DIVISOR_AFTER_DOUBLING * BASIS_POINTS_SQUARED * c * c
  const v = BigInt(n1) * BigInt(n2) * BigInt(n1 + n2 + 1)
  const z01 = BigInt(Z_BP['p<0.01'])
  if (left >= z01 * z01 * v) return 'p<0.01'
  const z05 = BigInt(Z_BP['p<0.05'])
  if (left >= z05 * z05 * v) return 'p<0.05'
  return 'none'
}

/**
 * A chi-square statistic, already scaled by CHI_SCALE, against the critical constant for its degrees of freedom.
 *
 * Unlike the two rank tests this one cannot judge whether its sample is big enough, because it is handed a statistic
 * and a df and never sees the table behind them. The chi-square approximation needs every expected count to reach
 * about 5, and that is the caller's gate to enforce (§12 asks for ≥ 20 impulse-tagged spends and ≥ 30 spends with
 * both fields); nothing here can stand in for it.
 *
 * A df the table does not carry THROWS rather than returning 'none'. 'none' means "the evidence is too weak to
 * call", and a df of 21 is not weak evidence — it is a missing constant, and returning 'none' would bury a whole
 * relationship of §12's battery as permanently unremarkable, which is the same silent corruption a per-sample-size
 * table of rank criticals was rejected for.
 */
export function chiSquareBracket(chiScaled: number, df: number): Bracket {
  assertInt(chiScaled, 'chiScaled')
  assertInt(df, 'df')
  if (chiScaled < 0) throw new RangeError(`a chi-square statistic cannot be negative, got ${chiScaled}`)
  if (CHI_SCALE !== 10000) {
    throw new RangeError(`CHI_CRIT is written in CHI_SCALE units of 10000 and CHI_SCALE is now ${CHI_SCALE}: every entry must be rewritten`)
  }
  const row = CHI_CRIT[df - 1]
  if (row === undefined) {
    throw new RangeError(`no chi-square critical for df ${df}: the table carries df 1 to ${CHI_CRIT.length}`)
  }
  if (chiScaled >= row.p01) return 'p<0.01'
  if (chiScaled >= row.p05) return 'p<0.05'
  return 'none'
}
