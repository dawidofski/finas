import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  ALPHA_BP,
  type Bracket,
  CHI_TABLE_MAX_DF,
  MW_MIN_GROUP,
  Z_BP,
  chiSquareBracket,
  mannWhitneyBracket,
  spearmanBracket,
} from './critical'
import { CHI_SCALE } from './stats'

// How much a bracket claims, so "never weaker than" is something a test can assert.
const RANK: Record<Bracket, number> = { none: 0, 'p<0.05': 1, 'p<0.01': 2, 'p<0.001': 3 }

/**
 * The thing the integer comparison replaces, written the ordinary way: a real square root, a real division, and a
 * float comparison against 1.96, 2.5759 and 3.2906. A TEST may do this; src/battery/critical.ts may not — and the point of
 * having it here is that the rearrangement must agree with the formula it was rearranged from. A test that only ever
 * exercises the rearranged form cannot tell anyone the rearrangement is right.
 */
// Written out as the floats they are, NOT as Z_BP/10000: an oracle derived from the module's own constant moves with
// it, and would agree with a module whose critical value had drifted.
const zCritical = { 'p<0.001': 3.2906, 'p<0.01': 2.5759, 'p<0.05': 1.96 }
const longWayBracket = (z: number): Bracket => {
  const abs = Math.abs(z)
  if (abs >= zCritical['p<0.001']) return 'p<0.001'
  if (abs >= zCritical['p<0.01']) return 'p<0.01'
  if (abs >= zCritical['p<0.05']) return 'p<0.05'
  return 'none'
}
const spearmanZ = (rhoBp: number, n: number): number => (rhoBp / 10000) * Math.sqrt(n - 1)
/**
 * uDoubled is 2U, as mannWhitneyU hands it over, so U is uDoubled/2 — a division a test may do and the module may not.
 *
 * This is the CONTINUITY-CORRECTED z the module implements, written the ordinary way: the deviation of U from its
 * null mean, shortened by half a unit of U, clamped at zero so a U sitting on the mean cannot come out negative, and
 * divided by a σ from a real square root. Returned as a magnitude, since the correction makes it one.
 *
 * The tie correction to the variance is deliberately absent here as well as in the module: ties shrink the true
 * variance, so the untied σ is the larger one and the bracket it yields is the weaker one.
 */
const mannWhitneyZ = (uDoubled: number, n1: number, n2: number): number => {
  const deviation = Math.abs(uDoubled / 2 - (n1 * n2) / 2) - 0.5
  return Math.max(0, deviation) / Math.sqrt((n1 * n2 * (n1 + n2 + 1)) / 12)
}

describe('critical: significance as a squared integer comparison', () => {
  it('brackets Spearman by the squared comparison, either side of the 0.05 line', () => {
    // The test is rhoBp² · (n − 1) ≥ Z_BP², and at n = 20 that is a comparison against 19600² = 384 160 000:
    //   4496² · 19 = 20 214 016 · 19 = 384 066 304  <  384 160 000  → none
    //   4497² · 19 = 20 223 009 · 19 = 384 237 171  ≥  384 160 000  → p<0.05
    // which is the line 1.96/√19 = 0.4496466 sits on, read in basis points.
    expect(spearmanBracket(4496, 20)).toBe('none')
    expect(spearmanBracket(4497, 20)).toBe('p<0.05')
    // Two-tailed: the sign of ρ cannot change how certain the result is.
    expect(spearmanBracket(-4496, 20)).toBe('none')
    expect(spearmanBracket(-4497, 20)).toBe('p<0.05')
  })

  it('brackets Spearman at the stricter line only when the statistic clears it', () => {
    // At n = 20 against 25759² = 663 526 081:
    //   5909² · 19 = 34 916 281 · 19 = 663 409 339  <  663 526 081  → p<0.05 and no further
    //   5910² · 19 = 34 928 100 · 19 = 663 633 900  ≥  663 526 081  → p<0.01
    expect(spearmanBracket(5909, 20)).toBe('p<0.05')
    expect(spearmanBracket(5910, 20)).toBe('p<0.01')
    expect(spearmanBracket(-5910, 20)).toBe('p<0.01')
    // And the third rung, at n = 20 against 32906² = 1 082 804 836:
    //   7549² · 19 = 56 987 401 · 19 = 1 082 760 619  <  1 082 804 836  →  p<0.01 and no further
    //   7550² · 19 = 57 002 500 · 19 = 1 083 047 500  ≥  1 082 804 836  →  p<0.001
    // which is the line 3.2906/√19 = 0.7549828 sits on.
    expect(spearmanBracket(7549, 20)).toBe('p<0.01')
    expect(spearmanBracket(7550, 20)).toBe('p<0.001')
    expect(spearmanBracket(-7550, 20)).toBe('p<0.001')
    // A perfect correlation over the smallest honest sample clears the stricter line: 10000² · 9 = 900 000 000.
    expect(spearmanBracket(10000, 10)).toBe('p<0.01')
    // It does NOT clear the strictest one, and cannot until n = 12: that needs rhoBp²(n−1) ≥ 1 082 804 836, and
    // with rhoBp capped at 10000 the smallest n that can is 12. An unreachable bracket at n = 10 and n = 11 is
    // arithmetic, not a bug.
    expect(spearmanBracket(10000, 11)).toBe('p<0.01')
    expect(spearmanBracket(10000, 12)).toBe('p<0.001')
  })

  it('brackets Mann-Whitney two-tailed, symmetrically above and below the midpoint', () => {
    // Every u here is 2U, the doubled form mannWhitneyU produces, so the null midpoint is uDoubled = n₁n₂ = 100 and
    // D = uDoubled − 100. With n₁ = n₂ = 10, V = 100 · 21 = 2100, and with the continuity correction shortening the
    // deviation by one in doubled units, the test is 3 · 10⁸ · C² ≥ Z_BP² · 2100 for C = max(0, |D| − 1).
    //   0.05: 19600² · 2100 = 384 160 000 · 2100 = 806 736 000 000
    //     2U = 152 (U = 76)   → C = 51 → 2601 · 3 · 10⁸ =   780 300 000 000  <    806 736 000 000  → none
    //     2U = 153 (U = 76.5) → C = 52 → 2704 · 3 · 10⁸ =   811 200 000 000  ≥    806 736 000 000  → p<0.05
    //     2U = 154 (U = 77)   → C = 53 → 2809 · 3 · 10⁸ =   842 700 000 000  ≥    806 736 000 000  → p<0.05
    //   0.01: 25759² · 2100 = 663 526 081 · 2100 = 1 393 404 770 100
    //     2U = 168 (U = 84)   → C = 67 → 4489 · 3 · 10⁸ = 1 346 700 000 000  <  1 393 404 770 100  → p<0.05
    //     2U = 170 (U = 85)   → C = 69 → 4761 · 3 · 10⁸ = 1 428 300 000 000  ≥  1 393 404 770 100  → p<0.01
    expect(mannWhitneyBracket(150, 10, 10)).toBe('none')
    expect(mannWhitneyBracket(152, 10, 10)).toBe('none')
    // Reachable only with a tie, and here the first value that CROSSES rather than one sitting on the line:
    // 811 200 000 000 exceeds 806 736 000 000. Exact equality IS reachable at other sizes, and the test below
    // pins it — this comment used to claim no input ever lands on a threshold, which was false.
    expect(mannWhitneyBracket(153, 10, 10)).toBe('p<0.05')
    expect(mannWhitneyBracket(154, 10, 10)).toBe('p<0.05')
    expect(mannWhitneyBracket(168, 10, 10)).toBe('p<0.05')
    expect(mannWhitneyBracket(170, 10, 10)).toBe('p<0.01')
    //   0.001: 32906² · 2100 = 1 082 804 836 · 2100 = 2 273 890 155 600
    //     2U = 188 (U = 94)   → C = 87 → 7569 · 3 · 10⁸ = 2 270 700 000 000  <  2 273 890 155 600  → p<0.01
    //     2U = 189 (U = 94.5) → C = 88 → 7744 · 3 · 10⁸ = 2 323 200 000 000  ≥  2 273 890 155 600  → p<0.001
    expect(mannWhitneyBracket(188, 10, 10)).toBe('p<0.01')
    expect(mannWhitneyBracket(189, 10, 10)).toBe('p<0.001')
    expect(mannWhitneyBracket(190, 10, 10)).toBe('p<0.001')
    // The mirror of each about the midpoint: uDoubled and 2n₁n₂ − uDoubled are the same distance out.
    expect(mannWhitneyBracket(50, 10, 10)).toBe('none')
    expect(mannWhitneyBracket(48, 10, 10)).toBe('none')
    expect(mannWhitneyBracket(47, 10, 10)).toBe('p<0.05')
    expect(mannWhitneyBracket(46, 10, 10)).toBe('p<0.05')
    expect(mannWhitneyBracket(32, 10, 10)).toBe('p<0.05')
    expect(mannWhitneyBracket(30, 10, 10)).toBe('p<0.01')
    expect(mannWhitneyBracket(12, 10, 10)).toBe('p<0.01')
    expect(mannWhitneyBracket(11, 10, 10)).toBe('p<0.001')
    expect(mannWhitneyBracket(10, 10, 10)).toBe('p<0.001')
    // Symmetry over the whole range, not only at the four boundaries, and for unequal groups too.
    for (const [n1, n2] of [
      [10, 10],
      [12, 9],
      [8, 14],
    ] as const) {
      const span = 2 * n1 * n2
      for (let uDoubled = 0; uDoubled <= span; uDoubled += 1) {
        expect([uDoubled, mannWhitneyBracket(uDoubled, n1, n2)]).toEqual([uDoubled, mannWhitneyBracket(span - uDoubled, n1, n2)])
      }
    }
  })

  it('brackets chi-square against the constants for one and two degrees of freedom', () => {
    // df 1: 3.8414588 and 6.6348966, rounded UP at the fourth decimal into CHI_SCALE units, so a statistic that
    // reaches a stored entry has genuinely reached the critical value.
    expect(chiSquareBracket(38414, 1)).toBe('none')
    expect(chiSquareBracket(38415, 1)).toBe('p<0.05')
    expect(chiSquareBracket(66348, 1)).toBe('p<0.05')
    expect(chiSquareBracket(66349, 1)).toBe('p<0.01')
    // df 2: 5.9914645 and 9.2103404, which are −2·ln 0.05 and −2·ln 0.01 exactly. The second rounds up to 92104, so
    // 92103 — a statistic a ten-thousandth short of the critical value — must still read as the weaker bracket.
    expect(chiSquareBracket(59914, 2)).toBe('none')
    expect(chiSquareBracket(59915, 2)).toBe('p<0.05')
    expect(chiSquareBracket(92103, 2)).toBe('p<0.05')
    expect(chiSquareBracket(92104, 2)).toBe('p<0.01')
    // The two rows are not the same row: more degrees of freedom demands a larger statistic for the same certainty.
    expect(chiSquareBracket(38415, 2)).toBe('none')
    expect(chiSquareBracket(66349, 2)).toBe('p<0.05')
    // And the rows past the first six, which reason × worthwhile reaches as soon as the owner has several purchase
    // reasons. df 14: 23.6847913 and 29.1412377. df 20, the last row: 31.4104328 and 37.5662348.
    expect(chiSquareBracket(236847, 14)).toBe('none')
    expect(chiSquareBracket(236848, 14)).toBe('p<0.05')
    expect(chiSquareBracket(291412, 14)).toBe('p<0.05')
    expect(chiSquareBracket(291413, 14)).toBe('p<0.01')
    // df 18 at 0.05 gets a boundary pair of its own, alone among rows 3-13 and 15-19 which the monotonic sweeps
    // cover. The true critical is 28.8692994, so the stored entry is 288693 — and the value a reader is likely to
    // remember, 28.8693079, would store 288694 and make this row one count stricter. It is the one row where the
    // remembered figure and the true figure disagree, so it is the row most likely to be "corrected" the wrong way.
    expect(chiSquareBracket(288692, 18)).toBe('none')
    expect(chiSquareBracket(288693, 18)).toBe('p<0.05')
    // The third column, at the first row, the df 18 row and the last: 10.8275662, 42.3123963, 45.3147466.
    expect(chiSquareBracket(108275, 1)).toBe('p<0.01')
    expect(chiSquareBracket(108276, 1)).toBe('p<0.001')
    expect(chiSquareBracket(423123, 18)).toBe('p<0.01')
    expect(chiSquareBracket(423124, 18)).toBe('p<0.001')
    expect(chiSquareBracket(453147, 20)).toBe('p<0.01')
    expect(chiSquareBracket(453148, 20)).toBe('p<0.001')
    expect(chiSquareBracket(314104, 20)).toBe('none')
    expect(chiSquareBracket(314105, 20)).toBe('p<0.05')
    expect(chiSquareBracket(375662, 20)).toBe('p<0.05')
    expect(chiSquareBracket(375663, 20)).toBe('p<0.01')
  })

  it('returns none for a statistic below the weakest line', () => {
    expect(spearmanBracket(0, 500)).toBe('none')
    expect(spearmanBracket(100, 500)).toBe('none') // ρ = 0.01 over 500 pairs: a real sample, no detectable relation
    expect(mannWhitneyBracket(100, 10, 10)).toBe('none') // exactly at the null midpoint, 2U = n₁n₂
    expect(mannWhitneyBracket(101, 10, 10)).toBe('none')
    expect(mannWhitneyBracket(99, 10, 10)).toBe('none')
    expect(chiSquareBracket(0, 1)).toBe('none')
    expect(chiSquareBracket(1, 6)).toBe('none')
  })

  it('is monotonic: a stronger statistic never brackets weaker than a lesser one', () => {
    // The likeliest way to get a rearrangement wrong is to lose a sign or turn an inequality round, and both show up
    // here as a rank that goes down where the evidence went up. Violations are collected rather than asserted one at
    // a time so the whole surface can be walked, and so a failure names the step it went backwards on.
    const backwards: string[] = []
    const rising = (label: string, ranks: readonly number[]): void => {
      for (let i = 1; i < ranks.length; i += 1) {
        const before = ranks[i - 1] ?? 0
        const after = ranks[i] ?? 0
        if (after < before) backwards.push(`${label} step ${i}: ${before} then ${after}`)
      }
    }
    // Spearman, rising in |ρ| at a fixed n, and the mirrored series moving with it.
    for (const n of [10, 11, 20, 31, 400]) {
      const up: number[] = []
      const mirrored: number[] = []
      for (let rhoBp = 0; rhoBp <= 10000; rhoBp += 1) {
        up.push(RANK[spearmanBracket(rhoBp, n)])
        mirrored.push(RANK[spearmanBracket(-rhoBp, n)])
      }
      rising(`spearman rhoBp at n=${n}`, up)
      expect(mirrored).toEqual(up)
    }
    // More data cannot make the same correlation less certain.
    for (const rhoBp of [0, 2000, 4497, 5910, 9000]) {
      const ranks: number[] = []
      for (let n = 0; n <= 200; n += 1) ranks.push(RANK[spearmanBracket(rhoBp, n)])
      rising(`spearman n at rhoBp=${rhoBp}`, ranks)
    }
    // Mann-Whitney, walking outwards from the null midpoint uDoubled = n₁n₂ in both directions.
    for (const [n1, n2] of [
      [8, 8],
      [10, 10],
      [13, 9],
    ] as const) {
      const mid = n1 * n2
      const above: number[] = []
      const below: number[] = []
      for (let u = mid; u <= 2 * mid; u += 1) above.push(RANK[mannWhitneyBracket(u, n1, n2)])
      for (let u = mid; u >= 0; u -= 1) below.push(RANK[mannWhitneyBracket(u, n1, n2)])
      rising(`mann-whitney above the midpoint at ${n1}v${n2}`, above)
      rising(`mann-whitney below the midpoint at ${n1}v${n2}`, below)
    }
    // Chi-square: rising in the statistic, over every row of the table.
    for (let df = 1; df <= 20; df += 1) {
      const ranks: number[] = []
      for (let chiScaled = 0; chiScaled <= 600000; chiScaled += 7) ranks.push(RANK[chiSquareBracket(chiScaled, df)])
      rising(`chi-square statistic at df=${df}`, ranks)
    }
    expect(backwards).toEqual([])
    // And falling in the degrees of freedom the same statistic has to pay for.
    const cheaper: string[] = []
    for (const chiScaled of [0, 38415, 66349, 92104, 150863, 291413, 375663, 453148, 600000]) {
      for (let df = 2; df <= 20; df += 1) {
        const before = RANK[chiSquareBracket(chiScaled, df - 1)]
        const after = RANK[chiSquareBracket(chiScaled, df)]
        if (after > before) cheaper.push(`chi-square ${chiScaled} at df ${df}: ${before} then ${after}`)
      }
    }
    expect(cheaper).toEqual([])
    // The clamp in C = max(0, |D| − 1) is the other half of that guard, and it is UNTESTED. Stated plainly, because
    // an acknowledged gap is worth more than a safety net that is not there: without the clamp a |D| of 0 squares to
    // 1, and 3 · 10⁸ · 1 never reaches Z_BP² · V, so no input this function accepts can show the difference. Not at
    // the floor, and not below it either — V = n₁n₂(n₁+n₂+1) is 3 even at one observation per group. Nothing about
    // lowering MW_MIN_GROUP would redden a test of it, and this assertion does not pretend otherwise; it reads the
    // module's own constants so the arithmetic is at least about the module, and it is the inequality that explains
    // why the clamp cannot be observed, not a check that the clamp is present.
    const smallestVariance = MW_MIN_GROUP * MW_MIN_GROUP * (MW_MIN_GROUP + MW_MIN_GROUP + 1)
    expect(3 * 100000000).toBeLessThan(Z_BP['p<0.05'] * Z_BP['p<0.05'] * smallestVariance)
    expect(3 * 100000000).toBeLessThan(Z_BP['p<0.05'] * Z_BP['p<0.05'] * (1 * 1 * (1 + 1 + 1))) // and at one each
    // The sweeps must actually cross the lines they are walking over, or there is nothing monotonic about them.
    expect(RANK[spearmanBracket(10000, 400)]).toBe(3)
    expect(RANK[spearmanBracket(0, 400)]).toBe(0)
    expect(RANK[mannWhitneyBracket(128, 8, 8)]).toBe(3)
    expect(RANK[mannWhitneyBracket(64, 8, 8)]).toBe(0)
    expect(RANK[chiSquareBracket(600000, 20)]).toBe(3)
    expect(RANK[chiSquareBracket(453147, 20)]).toBe(2)
    expect(RANK[chiSquareBracket(0, 20)]).toBe(0)
  })

  it('agrees with a worked example computed the long way, with a square root', () => {
    // Spearman at n = 20, either side of the 0.05 line, computed here as ρ·√(n−1) and compared to 1.96 as a float.
    //   √19 = 4.3588989, so 0.4496 · 4.3588989 = 1.9598  < 1.96  and  0.4497 · 4.3588989 = 1.9603 ≥ 1.96.
    expect(spearmanZ(4496, 20)).toBeLessThan(zCritical['p<0.05'])
    expect(spearmanZ(4497, 20)).toBeGreaterThanOrEqual(zCritical['p<0.05'])
    expect(spearmanBracket(4496, 20)).toBe(longWayBracket(spearmanZ(4496, 20)))
    expect(spearmanBracket(4497, 20)).toBe(longWayBracket(spearmanZ(4497, 20)))
    // Mann-Whitney at 10 against 10, either side of the same line, computed here as (|U − n₁n₂/2| − 0.5)/√(V/12).
    //   σ = √(2100/12) = √175 = 13.2287566, so (26 − 0.5)/σ = 1.9276 < 1.96 and (26.5 − 0.5)/σ = 1.9654 ≥ 1.96 —
    //   which is the correction doing its work: U = 76 was significant without it and is not with it.
    expect(mannWhitneyZ(152, 10, 10)).toBeLessThan(zCritical['p<0.05'])
    expect(mannWhitneyZ(153, 10, 10)).toBeGreaterThanOrEqual(zCritical['p<0.05'])
    expect(mannWhitneyBracket(152, 10, 10)).toBe(longWayBracket(mannWhitneyZ(152, 10, 10)))
    expect(mannWhitneyBracket(153, 10, 10)).toBe(longWayBracket(mannWhitneyZ(153, 10, 10)))
    // And the stricter line, where a rearrangement that was right at one threshold could still be wrong.
    expect(mannWhitneyZ(168, 10, 10)).toBeLessThan(zCritical['p<0.01'])
    expect(mannWhitneyZ(170, 10, 10)).toBeGreaterThanOrEqual(zCritical['p<0.01'])
    expect(mannWhitneyBracket(170, 10, 10)).toBe(longWayBracket(mannWhitneyZ(170, 10, 10)))
    // The strictest line too, where a rearrangement right at the other two could still be wrong.
    //   (44 − 0.5)/σ = 3.2889 < 3.2906  and  (44.5 − 0.5)/σ = 3.3266 ≥ 3.2906
    expect(mannWhitneyZ(188, 10, 10)).toBeLessThan(zCritical['p<0.001'])
    expect(mannWhitneyZ(189, 10, 10)).toBeGreaterThanOrEqual(zCritical['p<0.001'])
    expect(mannWhitneyBracket(188, 10, 10)).toBe(longWayBracket(mannWhitneyZ(188, 10, 10)))
    expect(mannWhitneyBracket(189, 10, 10)).toBe(longWayBracket(mannWhitneyZ(189, 10, 10)))
    expect(spearmanZ(7549, 20)).toBeLessThan(zCritical['p<0.001'])
    expect(spearmanZ(7550, 20)).toBeGreaterThanOrEqual(zCritical['p<0.001'])
    expect(spearmanBracket(7550, 20)).toBe(longWayBracket(spearmanZ(7550, 20)))
    // THIS ONE CHECKS THE ORACLE, NOT THE MODULE. The sweep below is only as good as mannWhitneyZ, and a correction
    // that shortened a deviation of zero into a negative z would make the oracle agree with the module for the
    // wrong reason, so the oracle's own clamp is worth one line. The module returns 'none' at the midpoint whether
    // or not its clamp is there, so nothing here can catch a regression in it — see the monotonicity test.
    expect(mannWhitneyZ(100, 10, 10)).toBe(0)

    // Four boundaries are four chances to be lucky, so: every value of each statistic at several sample sizes,
    // against the square root, with the crossings counted so a sweep that never reached a threshold cannot pass.
    const disagreements: string[] = []
    const seen = new Set<string>()
    for (const n of [10, 11, 20, 31, 64, 200]) {
      for (let rhoBp = -10000; rhoBp <= 10000; rhoBp += 1) {
        const squared = spearmanBracket(rhoBp, n)
        const longWay = longWayBracket(spearmanZ(rhoBp, n))
        if (squared !== longWay) disagreements.push(`spearman rhoBp=${rhoBp} n=${n}: ${squared} vs ${longWay}`)
        seen.add(`spearman ${longWay}`)
      }
    }
    for (const [n1, n2] of [
      [8, 8],
      [10, 10],
      [12, 9],
      [30, 25],
    ] as const) {
      for (let uDoubled = 0; uDoubled <= 2 * n1 * n2; uDoubled += 1) {
        const squared = mannWhitneyBracket(uDoubled, n1, n2)
        const longWay = longWayBracket(mannWhitneyZ(uDoubled, n1, n2))
        if (squared !== longWay) disagreements.push(`mann-whitney 2u=${uDoubled} n1=${n1} n2=${n2}: ${squared} vs ${longWay}`)
        seen.add(`mann-whitney ${longWay}`)
      }
    }
    expect(disagreements).toEqual([])
    expect([...seen].sort()).toEqual([
      'mann-whitney none',
      'mann-whitney p<0.001',
      'mann-whitney p<0.01',
      'mann-whitney p<0.05',
      'spearman none',
      'spearman p<0.001',
      'spearman p<0.01',
      'spearman p<0.05',
    ])
  })

  it('counts a statistic exactly equal to its critical value as significant', () => {
    // The inclusive boundary is the single decision at the heart of this module, and until now nothing held it: the
    // long-way oracle compares with >= too, so mutating >= to > in either rank bracket passed every test. It is
    // pinned here against INTEGER equality instead, which needs no oracle to be certain about.
    //
    // Chi-square had it already, since chiScaled and the stored criticals are both integers and the boundary tests
    // use the critical itself. For the rank brackets exact equality needs 3*10^8*C^2 == Z_BP^2*V, which has
    // solutions but not obvious ones. These are ALL of them for n1 <= n2 <= 200, found by exhaustive search; every
    // one falls at 0.05, and none exists at 0.01 or 0.001 in that range.
    const exactMW = [
      [9, 125, 441],
      [24, 25, 196],
      [25, 49, 343],
      [60, 64, 784],
      [24, 200, 1176],
      [49, 150, 1372],
      [90, 125, 1764],
      [125, 189, 3087],
    ] as const
    for (const [n1, n2, c] of exactMW) {
      const pairs = n1 * n2
      // C = |D| - 1, so |D| = c + 1 and uDoubled sits c + 1 either side of the null midpoint.
      expect([n1, n2, mannWhitneyBracket(pairs + c + 1, n1, n2)]).toEqual([n1, n2, 'p<0.05'])
      expect([n1, n2, mannWhitneyBracket(pairs - c - 1, n1, n2)]).toEqual([n1, n2, 'p<0.05'])
      // And one step short of equality is below the line, so the pair brackets the decision from both sides.
      expect([n1, n2, mannWhitneyBracket(pairs + c, n1, n2)]).toEqual([n1, n2, 'none'])
      expect([n1, n2, mannWhitneyBracket(pairs - c, n1, n2)]).toEqual([n1, n2, 'none'])
    }
    // Spearman has the same solutions where rhoBp^2*(n-1) == Z_BP^2 exactly. These are all of them for n <= 400,
    // again all at 0.05. n = 5 is below SPEARMAN_MIN_N, so there equality is not enough and never can be.
    const exactSpearman = [
      [4900, 17],
      [3920, 26],
      [2800, 50],
      [2450, 65],
      [1960, 101],
      [1400, 197],
      [1225, 257],
    ] as const
    for (const [rhoBp, n] of exactSpearman) {
      expect([rhoBp, n, spearmanBracket(rhoBp, n)]).toEqual([rhoBp, n, 'p<0.05'])
      expect([rhoBp, n, spearmanBracket(-rhoBp, n)]).toEqual([rhoBp, n, 'p<0.05'])
      expect([rhoBp, n, spearmanBracket(rhoBp - 1, n)]).toEqual([rhoBp, n, 'none'])
    }
    expect(spearmanBracket(9800, 5)).toBe('none') // exact equality, but the sample is below the floor

    // The two stricter rungs need their own cases, and WHY they look nothing like the ones above is arithmetic:
    // equality needs rhoBp to divide Z_BP, and Z_BP['p<0.05'] = 19600 = 2^4*5^2*7^2 is highly composite, while
    // Z_BP['p<0.01'] = 25759 is PRIME and Z_BP['p<0.001'] = 32906 = 2*16453 with 16453 prime. So at 0.01 the only
    // rhoBp at or under 10000 that divides it is 1, and n-1 must be 25759^2. These are boundary probes, not
    // plausible samples -- no owner has six hundred million annotated purchases -- but they are legal integer
    // inputs and they are the only way to hold the >= at these two lines.
    expect(spearmanBracket(1, 663526082)).toBe('p<0.01') // 1 * 25759^2 = 25759^2, exactly
    expect(spearmanBracket(1, 663526081)).toBe('p<0.05') // one short of it
    expect(spearmanBracket(2, 270701210)).toBe('p<0.001') // 4 * 16453^2 = 32906^2, exactly
    expect(spearmanBracket(2, 270701209)).toBe('p<0.01')
    expect(1 * 663526081).toBe(25759 * 25759)
    expect(4 * 270701209).toBe(32906 * 32906)

    // Mann-Whitney has NO exact equality at 0.01 or 0.001, and that is a fact about the constants rather than a gap
    // in the search: equality needs 3*10^8*C^2 == Z_BP^2*V, and since 25759 is prime and does not divide 3*10^8 it
    // must divide C, which forces V = n1*n2*(n1+n2+1) to be exactly 3*10^8*k^2. No pair of groups up to 1500 each
    // satisfies that -- and 1500 annotated purchases on each side is already far past anything this app will hold.
    // So the >= at those two lines is unpinned for mannWhitneyBracket, said plainly rather than left to be found:
    // mutating >= to > there survives. The 0.05 line above is the one real samples can reach.

    // Chi-square needs no special case: chiScaled and the stored criticals are both integers in the same units, so
    // every boundary test in this file sits exactly on a threshold already.
    expect(chiSquareBracket(38415, 1)).toBe('p<0.05')
    // df 4 at 0.001 is pinned too, because its comment digit was wrong for a round (18.4668274 for a true
    // 18.4668269529) and a row whose prose has already been wrong is the row most likely to be mis-edited next.
    expect(chiSquareBracket(184668, 4)).toBe('p<0.01')
    expect(chiSquareBracket(184669, 4)).toBe('p<0.001')
    // The arithmetic of one case, written out, so the list above is checkable without running anything:
    //   rhoBp = 4900, n = 17:  4900^2 * 16 = 24 010 000 * 16 = 384 160 000 = 19600^2, exactly.
    //   n1 = 24, n2 = 25, C = 196:  V = 600 * 50 = 30 000, and
    //   3 * 10^8 * 196^2 = 3 * 10^8 * 38 416 = 11 524 800 000 000 = 384 160 000 * 30 000 = 19600^2 * V, exactly.
    expect(4900 * 4900 * 16).toBe(19600 * 19600)
    expect(3 * 100000000 * 196 * 196).toBe(19600 * 19600 * (24 * 25 * (24 + 25 + 1)))
  })

  it('returns none where the sample is too small for the normal approximation to mean anything', () => {
    // ρ = 1.0 — a perfect correlation, the strongest statistic there is — still gets no bracket at n = 9, because
    // z = ρ·√(n−1) is not honest there and a bracket would be a made-up finding rather than a weak one.
    expect(spearmanBracket(10000, 9)).toBe('none')
    expect(spearmanBracket(10000, 4)).toBe('none')
    expect(spearmanBracket(10000, 0)).toBe('none')
    expect(spearmanBracket(10000, 10)).toBe('p<0.01') // and the floor is exactly 10, not merely somewhere near it
    // Mann-Whitney: the most extreme possible split of the two groups — every value of one above every value of the
    // other — with one group a single observation short of the floor, and then at the floor.
    expect(mannWhitneyBracket(112, 7, 8)).toBe('none')
    expect(mannWhitneyBracket(0, 8, 7)).toBe('none')
    // At the floor the strictest rung is reachable, but ONLY by complete separation — every value of one group
    // above every value of the other. V = 1088, so 0.001 needs C² ≥ 1 082 804 836 · 1088/(3 · 10⁸) = 3926.97,
    // i.e. C ≥ 63, i.e. |D| ≥ 64, and 64 is the largest |D| that 8 against 8 can produce.
    expect(mannWhitneyBracket(128, 8, 8)).toBe('p<0.001')
    expect(mannWhitneyBracket(0, 8, 8)).toBe('p<0.001')
    expect(mannWhitneyBracket(126, 8, 8)).toBe('p<0.01') // one pair short of complete separation
    expect(mannWhitneyBracket(2, 8, 8)).toBe('p<0.01')
  })

  it('refuses a degrees of freedom its table does not carry, rather than quietly reporting none', () => {
    // 'none' means the evidence is too weak to call. A df of 21 is not weak evidence, it is a missing constant, and
    // returning 'none' for it would bury a whole relationship of the battery as permanently unremarkable.
    expect(() => chiSquareBracket(500000, 21)).toThrow(/df 1 to 20/)
    expect(() => chiSquareBracket(500000, 40)).toThrow(/df 1 to 20/)
    expect(() => chiSquareBracket(500000, 0)).toThrow(/df 1 to 20/)
    expect(() => chiSquareBracket(500000, -1)).toThrow(/df 1 to 20/)
    expect(chiSquareBracket(500000, 20)).toBe('p<0.001') // the last row the table does carry still answers
    // CHI_TABLE_MAX_DF is what lets a caller refuse a too-wide table instead of being thrown at, so it has to be a
    // VIEW of the table and not a third place the number lives. Pinned from both sides through the only window this
    // module offers: the ceiling must answer and one past it must throw. A constant that drifted above the rows
    // would make the second line pass where it should throw; one that drifted below would make the first line
    // throw. The row count and the export therefore cannot disagree without reddening this.
    expect(CHI_TABLE_MAX_DF).toBe(20)
    expect(chiSquareBracket(500000, CHI_TABLE_MAX_DF)).toBe('p<0.001')
    expect(() => chiSquareBracket(500000, CHI_TABLE_MAX_DF + 1)).toThrow(RangeError)
    expect(() => chiSquareBracket(500000, CHI_TABLE_MAX_DF + 1)).toThrow(`df 1 to ${CHI_TABLE_MAX_DF}`)
  })

  it('refuses a statistic it cannot compare exactly', () => {
    // Doubling U absorbs the half a split tie contributes, so nothing fractional can legitimately arrive here.
    expect(() => mannWhitneyBracket(75.5, 10, 10)).toThrow(TypeError)
    expect(() => mannWhitneyBracket(Number.NaN, 10, 10)).toThrow(TypeError)
    expect(() => spearmanBracket(4496.5, 20)).toThrow(TypeError)
    expect(() => spearmanBracket(10001, 20)).toThrow(RangeError) // not a correlation in basis points
    expect(() => spearmanBracket(-10001, 20)).toThrow(RangeError)
    expect(() => spearmanBracket(4497, -1)).toThrow(RangeError)
    // A plain U where a doubled one belongs is the mistake the parameter name exists to prevent, and above the
    // midpoint it is also caught outright: 0..2n₁n₂ is the only range a doubled U can occupy.
    expect(() => mannWhitneyBracket(201, 10, 10)).toThrow(/0\.\.200/)
    expect(() => mannWhitneyBracket(-1, 10, 10)).toThrow(RangeError)
    expect(() => chiSquareBracket(-1, 1)).toThrow(RangeError)
    expect(() => chiSquareBracket(38415.5, 1)).toThrow(TypeError)
  })

  it('pins the constants a reviewer is meant to check by hand', () => {
    // 1.96, 2.5759 and 3.2906 in basis points, each rounded UP from the true critical so each can only withhold.
    expect(Z_BP).toEqual({ 'p<0.001': 32906, 'p<0.01': 25759, 'p<0.05': 19600 })
    expect(Z_BP['p<0.05']).toBeGreaterThan(1.959963984540054 * 10000)
    expect(Z_BP['p<0.01']).toBeGreaterThan(2.5758293035489004 * 10000)
    expect(Z_BP['p<0.001']).toBeGreaterThan(3.2905267314918945 * 10000)
    // Which is what the long-way oracle above compares against, written there as floats so the two are independent.
    expect([Z_BP['p<0.001'] / 10000, Z_BP['p<0.01'] / 10000, Z_BP['p<0.05'] / 10000]).toEqual([
      zCritical['p<0.001'],
      zCritical['p<0.01'],
      zCritical['p<0.05'],
    ])
    // Each bracket's upper bound. The 10 is what makes the battery able to speak at all: Benjamini-Hochberg over
    // the ten relationships has a smallest threshold of 500/10 = 50 bp, which no 100 bp bound can ever clear. The
    // 500 and the 10 are WRITTEN here, not read from the correction module or from BATTERY, because critical.ts
    // cannot import either without a cycle. So this pins the relationship the rung exists for and would NOT notice
    // the FDR level or the count of relationships changing; catching that belongs in the correction module's tests.
    expect(ALPHA_BP).toEqual({ 'p<0.001': 10, 'p<0.01': 100, 'p<0.05': 500 })
    expect(ALPHA_BP['p<0.001']).toBeLessThan(500 / 10)
    // The chi-square table is written in CHI_SCALE units and imported CHI_SCALE is the only scale in play. If this
    // ever changes, every entry of CHI_CRIT must be rewritten, and chiSquareBracket refuses rather than mis-compare.
    expect(CHI_SCALE).toBe(10000)
  })

  it('refuses to compare when the imported scale is not the one the table was written in', async () => {
    vi.resetModules()
    vi.doMock('./stats', () => ({ CHI_SCALE: 1000 }))
    const rescaled = await import('./critical')
    expect(() => rescaled.chiSquareBracket(38415, 1)).toThrow(/CHI_SCALE is now 1000/)
    vi.doUnmock('./stats')
    vi.resetModules()
  })

  it('uses no floating-point arithmetic', () => {
    const raw = readFileSync(resolve(import.meta.dirname, 'critical.ts'), 'utf8')
    // Code only. Strings go first, so a // inside one cannot be mistaken for a comment; then comments, so prose
    // explaining why the module does not divide cannot be read as a division.
    const code = (text: string): string =>
      text
        .replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/gs, "''")
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\/\/[^\n]*/g, ' ')
    // The stripper itself, because a guard whose detector has quietly stopped working reads as coverage.
    expect(code('// the 0.05 line')).not.toMatch(/0\.05/)
    expect(code('/* z = r * sqrt(n - 1) over 12 */')).not.toMatch(/sqrt/)
    expect(code("const why = 'we never divide here' // nor here")).not.toMatch(/divide/)
    expect(code('const half = n / 2 // and a trailing comment')).toMatch(/n \/ 2/)
    expect(code('const r = Math.sqrt(2)')).toMatch(/Math\.sqrt/)

    const src = code(raw)
    expect(src).toMatch(/function spearmanBracket/) // the scan is looking at the real file
    expect(src).toMatch(/function mannWhitneyBracket/)
    expect(src).toMatch(/function chiSquareBracket/)
    expect(src).not.toMatch(/\b(parseFloat|parseInt|toFixed|toPrecision|Number\.parseFloat)\b/)
    expect(src).not.toMatch(/Math\.(sqrt|cbrt|pow|exp|log|log2|log10|hypot|random|fround|round|ceil|floor|trunc)\b/)
    expect(src).not.toMatch(/\*\*/)
    expect(src).not.toMatch(/\d\.\d|\d\.(?!\w)|(?<![\w.])\.\d/) // no decimal literal
    expect(src).not.toMatch(/\d[eE][-+]?\d/) // nor an exponent literal, which the tree-wide rule does not catch
    // Squaring removed the square root, and the square root took the denominator with it: there is no division at
    // all in this module, which is a stronger claim than any other file in src/ can make.
    expect(src.split('\n').filter((line) => line.includes('/'))).toEqual([])
  })
})
