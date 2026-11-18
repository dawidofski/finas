import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ALPHA_BP, type Bracket, Z_BP, chiSquareBracket, mannWhitneyBracket, spearmanBracket } from './critical'
import { CHI_SCALE } from './stats'

// How much a bracket claims, so "never weaker than" is something a test can assert.
const RANK: Record<Bracket, number> = { none: 0, 'p<0.05': 1, 'p<0.01': 2 }

/**
 * The thing the integer comparison replaces, written the ordinary way: a real square root, a real division, and a
 * float comparison against 1.96 and 2.5758. A TEST may do this; src/battery/critical.ts may not — and the point of
 * having it here is that the rearrangement must agree with the formula it was rearranged from. A test that only ever
 * exercises the rearranged form cannot tell anyone the rearrangement is right.
 */
// Written out as the floats they are, NOT as Z_BP/10000: an oracle derived from the module's own constant moves with
// it, and would agree with a module whose critical value had drifted.
const zCritical = { 'p<0.05': 1.96, 'p<0.01': 2.5758 }
const longWayBracket = (z: number): Bracket => {
  const abs = Math.abs(z)
  if (abs >= zCritical['p<0.01']) return 'p<0.01'
  if (abs >= zCritical['p<0.05']) return 'p<0.05'
  return 'none'
}
const spearmanZ = (rhoBp: number, n: number): number => (rhoBp / 10000) * Math.sqrt(n - 1)
// uDoubled is 2U, as mannWhitneyU hands it over, so U is uDoubled/2 — a division a test may do and the module may not.
const mannWhitneyZ = (uDoubled: number, n1: number, n2: number): number =>
  (uDoubled / 2 - (n1 * n2) / 2) / Math.sqrt((n1 * n2 * (n1 + n2 + 1)) / 12)

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
    // At n = 20 against 25758² = 663 474 564:
    //   5909² · 19 = 34 916 281 · 19 = 663 409 339  <  663 474 564  → p<0.05 and no further
    //   5910² · 19 = 34 928 100 · 19 = 663 633 900  ≥  663 474 564  → p<0.01
    expect(spearmanBracket(5909, 20)).toBe('p<0.05')
    expect(spearmanBracket(5910, 20)).toBe('p<0.01')
    expect(spearmanBracket(-5910, 20)).toBe('p<0.01')
    // A perfect correlation over the smallest honest sample clears the stricter line: 10000² · 9 = 900 000 000.
    expect(spearmanBracket(10000, 10)).toBe('p<0.01')
  })

  it('brackets Mann-Whitney two-tailed, symmetrically above and below the midpoint', () => {
    // Every u here is 2U, the doubled form mannWhitneyU produces, so the null midpoint is uDoubled = n₁n₂ = 100 and
    // D = uDoubled − 100. With n₁ = n₂ = 10, V = 100 · 21 = 2100 and the test is 3 · 10⁸ · D² ≥ Z_BP² · 2100.
    //   0.05: 19600² · 2100 = 384 160 000 · 2100 = 806 736 000 000
    //     2U = 150 (U = 75) → 50² · 3 · 10⁸ = 2500 · 3 · 10⁸ =   750 000 000 000  <    806 736 000 000  → none
    //     2U = 152 (U = 76) → 52² · 3 · 10⁸ = 2704 · 3 · 10⁸ =   811 200 000 000  ≥    806 736 000 000  → p<0.05
    //   0.01: 25758² · 2100 = 663 474 564 · 2100 = 1 393 296 584 400
    //     2U = 168 (U = 84) → 68² · 3 · 10⁸ = 4624 · 3 · 10⁸ = 1 387 200 000 000  <  1 393 296 584 400  → p<0.05
    //     2U = 170 (U = 85) → 70² · 3 · 10⁸ = 4900 · 3 · 10⁸ = 1 470 000 000 000  ≥  1 393 296 584 400  → p<0.01
    expect(mannWhitneyBracket(150, 10, 10)).toBe('none')
    expect(mannWhitneyBracket(152, 10, 10)).toBe('p<0.05')
    expect(mannWhitneyBracket(168, 10, 10)).toBe('p<0.05')
    expect(mannWhitneyBracket(170, 10, 10)).toBe('p<0.01')
    // The mirror of each about the midpoint: uDoubled and 2n₁n₂ − uDoubled are the same distance out.
    expect(mannWhitneyBracket(50, 10, 10)).toBe('none')
    expect(mannWhitneyBracket(48, 10, 10)).toBe('p<0.05')
    expect(mannWhitneyBracket(32, 10, 10)).toBe('p<0.05')
    expect(mannWhitneyBracket(30, 10, 10)).toBe('p<0.01')
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
    // Chi-square: rising in the statistic.
    for (let df = 1; df <= 6; df += 1) {
      const ranks: number[] = []
      for (let chiScaled = 0; chiScaled <= 200000; chiScaled += 7) ranks.push(RANK[chiSquareBracket(chiScaled, df)])
      rising(`chi-square statistic at df=${df}`, ranks)
    }
    expect(backwards).toEqual([])
    // And falling in the degrees of freedom the same statistic has to pay for.
    const cheaper: string[] = []
    for (const chiScaled of [0, 38415, 66349, 92104, 150863, 400000]) {
      for (let df = 2; df <= 6; df += 1) {
        const before = RANK[chiSquareBracket(chiScaled, df - 1)]
        const after = RANK[chiSquareBracket(chiScaled, df)]
        if (after > before) cheaper.push(`chi-square ${chiScaled} at df ${df}: ${before} then ${after}`)
      }
    }
    expect(cheaper).toEqual([])
    // The sweeps must actually cross the lines they are walking over, or there is nothing monotonic about them.
    expect(RANK[spearmanBracket(10000, 400)]).toBe(2)
    expect(RANK[spearmanBracket(0, 400)]).toBe(0)
    expect(RANK[mannWhitneyBracket(128, 8, 8)]).toBe(2)
    expect(RANK[mannWhitneyBracket(64, 8, 8)]).toBe(0)
    expect(RANK[chiSquareBracket(200000, 6)]).toBe(2)
    expect(RANK[chiSquareBracket(0, 6)]).toBe(0)
  })

  it('agrees with a worked example computed the long way, with a square root', () => {
    // Spearman at n = 20, either side of the 0.05 line, computed here as ρ·√(n−1) and compared to 1.96 as a float.
    //   √19 = 4.3588989, so 0.4496 · 4.3588989 = 1.9598  < 1.96  and  0.4497 · 4.3588989 = 1.9603 ≥ 1.96.
    expect(spearmanZ(4496, 20)).toBeLessThan(zCritical['p<0.05'])
    expect(spearmanZ(4497, 20)).toBeGreaterThanOrEqual(zCritical['p<0.05'])
    expect(spearmanBracket(4496, 20)).toBe(longWayBracket(spearmanZ(4496, 20)))
    expect(spearmanBracket(4497, 20)).toBe(longWayBracket(spearmanZ(4497, 20)))
    // Mann-Whitney at 10 against 10, either side of the same line, computed here as (U − n₁n₂/2)/√(V/12).
    //   σ = √(2100/12) = √175 = 13.2287566, so (75 − 50)/σ = 1.8898 < 1.96 and (76 − 50)/σ = 1.9654 ≥ 1.96.
    expect(mannWhitneyZ(150, 10, 10)).toBeLessThan(zCritical['p<0.05'])
    expect(mannWhitneyZ(152, 10, 10)).toBeGreaterThanOrEqual(zCritical['p<0.05'])
    expect(mannWhitneyBracket(150, 10, 10)).toBe(longWayBracket(mannWhitneyZ(150, 10, 10)))
    expect(mannWhitneyBracket(152, 10, 10)).toBe(longWayBracket(mannWhitneyZ(152, 10, 10)))
    // And the stricter line, where a rearrangement that was right at one threshold could still be wrong.
    expect(mannWhitneyZ(168, 10, 10)).toBeLessThan(zCritical['p<0.01'])
    expect(mannWhitneyZ(170, 10, 10)).toBeGreaterThanOrEqual(zCritical['p<0.01'])
    expect(mannWhitneyBracket(170, 10, 10)).toBe(longWayBracket(mannWhitneyZ(170, 10, 10)))

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
      'mann-whitney p<0.01',
      'mann-whitney p<0.05',
      'spearman none',
      'spearman p<0.01',
      'spearman p<0.05',
    ])
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
    expect(mannWhitneyBracket(128, 8, 8)).toBe('p<0.01')
    expect(mannWhitneyBracket(0, 8, 8)).toBe('p<0.01')
  })

  it('refuses a degrees of freedom its table does not carry, rather than quietly reporting none', () => {
    // 'none' means the evidence is too weak to call. A df of 7 is not weak evidence, it is a missing constant, and
    // returning 'none' for it would bury a whole relationship of the battery as permanently unremarkable.
    expect(() => chiSquareBracket(500000, 7)).toThrow(/df 1 to 6/)
    expect(() => chiSquareBracket(500000, 14)).toThrow(/df 1 to 6/)
    expect(() => chiSquareBracket(500000, 0)).toThrow(/df 1 to 6/)
    expect(() => chiSquareBracket(500000, -1)).toThrow(/df 1 to 6/)
    expect(chiSquareBracket(500000, 6)).toBe('p<0.01') // the last row the table does carry still answers
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
    expect(Z_BP).toEqual({ 'p<0.05': 19600, 'p<0.01': 25758 }) // 1.96 and 2.5758, in basis points
    // Which is what the long-way oracle above compares against, written there as floats so the two are independent.
    expect([Z_BP['p<0.05'] / 10000, Z_BP['p<0.01'] / 10000]).toEqual([zCritical['p<0.05'], zCritical['p<0.01']])
    expect(ALPHA_BP).toEqual({ 'p<0.01': 100, 'p<0.05': 500 }) // 0.01 and 0.05, each bracket's upper bound
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
