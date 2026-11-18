import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { divRound } from '../lib/money'
import { CHI_SCALE, chiSquareScaled, cramersVBp, divRoundBig, doubledRanks, isqrt, isqrtBig, mannWhitneyU, spearmanRhoBp } from './stats'

/**
 * U from the rank-sum identity U = R1 - n1(n1+1)/2, doubled throughout so it stays an integer: 2U = R1doubled -
 * n1(n1+1). This is the SECOND derivation of U. mannWhitneyU() counts pairwise wins and never ranks anything, so this
 * helper and the implementation share no arithmetic: when they agree, two independent routes agree, which is evidence.
 * One derivation agreeing with itself would not be.
 */
function doubledUFromRankSum(a: readonly number[], b: readonly number[]): number {
  const ranks = doubledRanks([...a, ...b])
  let rankSumDoubled = 0
  for (let i = 0; i < a.length; i++) {
    const r = ranks[i]
    if (r === undefined) throw new Error('rank missing')
    rankSumDoubled += r
  }
  return rankSumDoubled - a.length * (a.length + 1)
}

describe('battery statistics (integer only)', () => {
  it('takes an exact integer square root, including of a perfect square and of zero', () => {
    expect(isqrt(0)).toBe(0)
    expect(isqrt(1)).toBe(1)
    expect(isqrt(4)).toBe(2)
    expect(isqrt(16)).toBe(4)
    expect(isqrt(100000000)).toBe(10000) // 10000^2, the scale a basis-point Cramers V lands on
    // Non-squares floor, and the neighbours of a square are not dragged onto it.
    expect(isqrt(2)).toBe(1)
    expect(isqrt(3)).toBe(1)
    expect(isqrt(15)).toBe(3)
    expect(isqrt(17)).toBe(4)
    expect(isqrt(99999999)).toBe(9999)
    // The definition itself, as an oracle: r*r <= n < (r+1)*(r+1). A float sqrt fails this near the top of the safe
    // range, where rounding to the nearest double can push the root one past the floor.
    for (const n of [0, 1, 2, 5, 24, 25, 26, 1023, 1024, 1025, 999999, 1000000, 123456789, 9007199254740990, Number.MAX_SAFE_INTEGER]) {
      const r = isqrt(n)
      expect(Number.isInteger(r)).toBe(true)
      expect(r * r).toBeLessThanOrEqual(n)
      expect((r + 1) * (r + 1)).toBeGreaterThan(n)
    }
  })

  it('rejects a square root it cannot take exactly, instead of returning a float one', () => {
    // isqrt refuses on its own terms rather than leaning on isqrtBig's check: the message names isqrt, so this also
    // pins that the public entry point validates what it was handed.
    expect(() => isqrt(-1)).toThrow(/^isqrt needs/)
    expect(() => isqrt(-1)).toThrow(RangeError)
    expect(() => isqrt(Number.NaN)).toThrow(RangeError)
    expect(() => isqrt(Number.POSITIVE_INFINITY)).toThrow(RangeError)
    expect(() => isqrt(Number.MAX_SAFE_INTEGER + 2)).toThrow(RangeError) // not a safe integer any more
    expect(() => isqrtBig(-1n)).toThrow(RangeError)
  })

  it('takes an exact integer square root far past the safe-integer range, over BigInt', () => {
    expect(isqrtBig(0n)).toBe(0n)
    expect(isqrtBig(1n)).toBe(1n)
    expect(isqrtBig(4n)).toBe(2n)
    expect(isqrtBig(15n)).toBe(3n)
    // The two scaled roots Spearman actually takes, where S * ROOT_SCALE^2 is far above 2^53:
    // 1600 * 10^16 = (4 * 10^9)^2, and 4624 * 10^16 = (6.8 * 10^9)^2.
    expect(isqrtBig(16000000000000000000n)).toBe(4000000000n)
    expect(isqrtBig(46240000000000000000n)).toBe(6800000000n)
    // The definition itself as the oracle: r*r <= n < (r+1)*(r+1). The last two values are beyond any double, so a
    // float route could not even represent them, let alone floor them correctly.
    for (const n of [0n, 1n, 2n, 3n, 24n, 25n, 1280n, 4760n, 16000000000000000000n, 12800000000000000000n, 123456789012345678901234567890n]) {
      const r = isqrtBig(n)
      expect(r * r <= n).toBe(true)
      expect((r + 1n) * (r + 1n) > n).toBe(true)
    }
    // isqrt is isqrtBig's answer carried back into a Number, so the two must never disagree.
    for (const n of [0, 1, 2, 15, 100000000, 123456789, Number.MAX_SAFE_INTEGER]) {
      expect(isqrt(n)).toBe(Number(isqrtBig(BigInt(n))))
    }
  })

  it('rounds over BigInt by the same rule money.ts rounds a Number', () => {
    // Two rounding rules in one app is how two screens come to disagree about a figure, so divRoundBig is held
    // against divRound itself over the Number range, signs and exact halves included.
    for (const [n, d] of [[0, 4], [7, 2], [-7, 2], [7, -2], [-7, -2], [5, 3], [-5, 3], [1, 2], [-1, 2], [90000, 210], [650000, 68], [2500000000, 112000]]) {
      if (n === undefined || d === undefined) throw new Error('bad case')
      expect(Number(divRoundBig(BigInt(n), BigInt(d)))).toBe(divRound(n, d))
    }
    // Halves go away from zero, in both directions - the rule money.ts states.
    expect(divRoundBig(3n, 2n)).toBe(2n)
    expect(divRoundBig(-3n, 2n)).toBe(-2n)
    expect(divRoundBig(1n, 2n)).toBe(1n)
    // And past the safe-integer range, which is the whole reason it exists: 65 * 10^12 / 6.8 * 10^9 = 9558.82...
    expect(divRoundBig(65000000000000n, 6800000000n)).toBe(9559n)
  })

  it('gives tied values their average rank, doubled so it stays an integer', () => {
    // [50, 10, 30, 30, 20] sorted is 10, 20, 30, 30, 50, holding ranks 1, 2, 3, 4, 5.
    //   10 -> rank 1          -> doubled 2
    //   20 -> rank 2          -> doubled 4
    //   30 -> ranks 3 and 4, average 3.5 (a half, which is why ranks are doubled) -> doubled 7
    //   50 -> rank 5          -> doubled 10
    expect(doubledRanks([50, 10, 30, 30, 20])).toEqual([10, 2, 7, 7, 4])
    // A tie of odd size averages to a whole rank and still comes back doubled: ranks 1, 2, 3 average 2 -> 4.
    expect(doubledRanks([7, 7, 7, 9])).toEqual([4, 4, 4, 8])
    // Everything tied: ranks 1..4 average 2.5 -> 5.
    expect(doubledRanks([5, 5, 5, 5])).toEqual([5, 5, 5, 5])
    expect(doubledRanks([])).toEqual([])
    expect(doubledRanks([42])).toEqual([2])
    // Doubled ranks always sum to n(n+1), however the ties fall: doubling turns 1+..+n into n(n+1). A tie rule that
    // handed out sequential ranks inside a group would still satisfy this, so it is a cross-check, not the test.
    for (const values of [[50, 10, 30, 30, 20], [7, 7, 7, 9], [5, 5, 5, 5], [1, 2, 2, 2, 2, 3, 3]]) {
      const n = values.length
      expect(doubledRanks(values).reduce((s, r) => s + r, 0)).toBe(n * (n + 1))
    }
  })

  it('matches a worked Spearman example by hand, with no ties', () => {
    const xs = [10, 20, 30, 40, 50]
    const ys = [20, 10, 50, 30, 40]
    // Spearman's rho is Pearson's correlation of the ranks. Doubled ranks, and their mean, which is exactly n+1 = 6:
    //   doubled rank of xs =  2,  4,  6,  8, 10   ->  a = -4, -2,  0,  2,  4
    //   doubled rank of ys =  4,  2, 10,  6,  8   ->  b = -2, -4,  4,  0,  2
    //   sum(a*b) = 8 + 8 + 0 + 0 + 8 = 24 ;  sum(a^2) = 16+4+0+4+16 = 40 ;  sum(b^2) = 4+16+16+0+4 = 40
    //   rho = 24 / sqrt(40*40) = 24/40 = 3/5 = 0.6   -> 6000 bp, and the root is the integer 40, so nothing rounds.
    expect(spearmanRhoBp(xs, ys)).toBe(6000)
    //
    // THE CROSS-CHECK ON THE WHOLE IMPLEMENTATION: with no ties the old shortcut 1 - 6*sum(d^2)/(n(n^2-1)) is equal
    // to Pearson-on-ranks, so it must reach the same 6000 by completely different arithmetic.
    //   ranks of xs: 1, 2, 3, 4, 5 ; ranks of ys (sorted 10, 20, 30, 40, 50): 2, 1, 5, 3, 4
    //   d = -1, 1, -2, 1, 1 ; sum(d^2) = 1+1+4+1+1 = 8
    //   1 - 6*8/(5*(25-1)) = 1 - 48/120 = 1 - 2/5 = 3/5
    // Two formulas, one answer. A tie correction that quietly moved an untied answer would break this line.
    //
    // The two ends of the scale, also by hand: identical rank orders give a = b, so sum(a*b) = sum(a^2) = sum(b^2)
    // and rho = 1; reversed orders give b = -a, so sum(a*b) = -sum(a^2) and rho = -1.
    expect(spearmanRhoBp([1, 2, 3], [5, 6, 7])).toBe(10000)
    expect(spearmanRhoBp([1, 2, 3], [3, 2, 1])).toBe(-10000)
  })

  it('matches a worked Spearman example with ties', () => {
    const xs = [10, 20, 20, 30, 40, 50]
    const ys = [15, 25, 35, 35, 45, 55]
    // xs ties at 20 (ranks 2 and 3, average 2.5) and ys ties at 35 (ranks 3 and 4, average 3.5). In doubled ranks:
    //   doubled rank of xs = 2, 5, 5, 8, 10, 12
    //   doubled rank of ys = 2, 4, 7, 7, 10, 12
    // Pinning those here on purpose: a wrong tie rule changes them, and the rho below with it.
    expect(doubledRanks(xs)).toEqual([2, 5, 5, 8, 10, 12])
    expect(doubledRanks(ys)).toEqual([2, 4, 7, 7, 10, 12])
    // Pearson on those ranks, with mean doubled rank n+1 = 7:
    //   a = -5, -2, -2,  1,  3,  5   ;  sum(a^2) = 25+4+4+1+9+25 = 68
    //   b = -5, -3,  0,  0,  3,  5   ;  sum(b^2) = 25+9+0+0+9+25 = 68
    //   sum(a*b) = 25 + 6 + 0 + 0 + 9 + 25 = 65
    //   rho = 65 / sqrt(68*68) = 65/68 = 0.95588235...   -> 9559 bp
    // (10^4 * 65 / 68 = 650000/68 = 9558.82..., which rounds up to 9559.)
    expect(spearmanRhoBp(xs, ys)).toBe(9559)
    // For the record, because this number CHANGED: the old shortcut 1 - 6*sum(d^2)/(n(n^2-1)) read 9571 here. Its
    // doubled d are 0, 1, -2, 1, 0, 0, so sum(d^2) = 6/4 = 1.5 and 1 - 9/210 = 1 - 3/70 = 0.9571428..., 12 bp high.
    // The shortcut is not Spearman's rho when there are ties, and 12 bp is the small end of how wrong it gets.
    //
    // Break the xs tie and the answer moves, so the number above is about the tie rule and not about these six pairs.
    // With xs = 10, 20, 21, 30, 40, 50 the doubled ranks of xs become 2, 4, 6, 8, 10, 12, so a = -5, -3, -1, 1, 3, 5
    // and sum(a^2) = 25+9+1+1+9+25 = 70; b is unchanged, so sum(a*b) = 25 + 9 + 0 + 0 + 9 + 25 = 68 and
    //   rho = 68 / sqrt(70*68) = 68 / sqrt(4760) = 68 / 68.9927532... = 0.98561076...   -> 9856 bp
    // This one is also why the root is taken scaled: sqrt(4760) floored to 68 would read 68/68 = 10000 bp.
    expect(spearmanRhoBp([10, 20, 21, 30, 40, 50], ys)).toBe(9856)
    //
    // A heavy tie, which is the shape §12's mood and worthwhile fields actually have:
    const tied = [1, 1, 1, 2, 3]
    const down = [5, 4, 3, 2, 1]
    //   doubled rank of tied =  4,  4,  4,  8, 10  (three values share ranks 1, 2, 3, average 2 -> doubled 4)
    //   doubled rank of down = 10,  8,  6,  4,  2
    // Mean doubled rank n+1 = 6:
    //   a = -2, -2, -2,  2,  4   ;  sum(a^2) = 4+4+4+4+16 = 32
    //   b =  4,  2,  0, -2, -4   ;  sum(b^2) = 16+4+0+4+16 = 40
    //   sum(a*b) = -8 - 4 + 0 - 4 - 16 = -32
    //   rho = -32 / sqrt(32*40) = -32 / sqrt(1280)
    // and 1280 = 256*5, so sqrt(1280) = 16*sqrt(5) and rho = -32/(16*sqrt(5)) = -2/sqrt(5) = -2*sqrt(5)/5,
    //   = -0.8944271909...   -> -8944 bp
    expect(doubledRanks(tied)).toEqual([4, 4, 4, 8, 10])
    expect(spearmanRhoBp(tied, down)).toBe(-8944)
    // WHY THIS NUMBER CHANGED, kept legible on purpose: the shortcut read -7000 here. Its doubled d are
    // -6, -4, -2, 4, 8, so sum((2d)^2) = 36+16+4+16+64 = 136, sum(d^2) = 34, and 1 - 6*34/(5*24) = 1 - 1.7 = -0.7.
    // That is a 1944 bp over-report produced by three tied values out of five - on exactly the data shape §12's
    // first two relationships have. The correction is not a tweak: it is the difference between reporting a moderate
    // association and a near-perfect one.
  })

  it('returns null for Spearman when one series has no variance', () => {
    expect(spearmanRhoBp([5, 5, 5, 5], [1, 2, 3, 4])).toBeNull()
    expect(spearmanRhoBp([1, 2, 3, 4], [5, 5, 5, 5])).toBeNull()
    expect(spearmanRhoBp([0, 0, 0], [0, 0, 0])).toBeNull()
    // The nulls above are the missing variance and nothing else: one value moved and the same call answers.
    expect(spearmanRhoBp([5, 5, 5, 6], [1, 2, 3, 4])).not.toBeNull()
  })

  it('returns null for Spearman where there is no rho, rather than a +1 or -1 that looks like one', () => {
    // Two pairs can only ever produce +1 or -1 from this formula, whatever the values, so it is refused.
    expect(spearmanRhoBp([1, 2], [1, 2])).toBeNull()
    expect(spearmanRhoBp([1, 2], [2, 1])).toBeNull()
    expect(spearmanRhoBp([1], [1])).toBeNull()
    expect(spearmanRhoBp([], [])).toBeNull()
    // Unpaired series are not a correlation of anything.
    expect(spearmanRhoBp([1, 2, 3], [1, 2, 3, 4])).toBeNull()
    expect(spearmanRhoBp([1, 2, 3, 4], [1, 2, 3])).toBeNull()
  })

  it('counts Mann-Whitney U as pairwise wins, and agrees with the rank-sum identity', () => {
    const a = [3, 5, 9]
    const b = [1, 4, 6, 8]
    // Pairwise, by hand (every a against every b, 3*4 = 12 pairs):
    //   3 beats 1                  -> 1 win,  loses to 4, 6, 8 -> 3 losses
    //   5 beats 1, 4               -> 2 wins, loses to 6, 8    -> 2 losses
    //   9 beats 1, 4, 6, 8         -> 4 wins, loses to nothing -> 0 losses
    //   wins = 7, losses = 5, ties = 0  (7 + 5 = 12, so every pair is accounted for)
    // U = 7, and `uDoubled` is U doubled = 14 (doubled because a tie is half a win; see the module comment).
    // r = (wins - losses) / (n1*n2) = (7-5)/12 = 1/6; in basis points 10000/6 = 1666.67 -> 1667.
    expect(mannWhitneyU(a, b)).toEqual({ uDoubled: 14, rBp: 1667 })
    // The second derivation: combined sorted 1, 3, 4, 5, 6, 8, 9 gives a's values ranks 2, 4, 7, so R1 = 13 and
    // U = R1 - n1(n1+1)/2 = 13 - 6 = 7, i.e. doubled 14. Computed from the ranks, not from the pair count.
    expect(doubledUFromRankSum(a, b)).toBe(14)
    expect(mannWhitneyU(a, b)?.uDoubled).toBe(doubledUFromRankSum(a, b))

    // With a tie across the groups, where U is a half-integer and the doubling earns its keep:
    const c = [2, 4, 6]
    const d = [4, 5]
    //   2 beats nothing      -> 0 wins, 2 losses
    //   4 ties with 4, loses to 5 -> 0 wins, 1 loss, 1 tie
    //   6 beats 4, 5         -> 2 wins, 0 losses
    //   wins = 2, losses = 3, ties = 1 (2 + 3 + 1 = 6 pairs). U = 2 + 1/2 = 2.5, doubled uDoubled = 5.
    // r = (2-3)/6 = -1/6; -10000/6 = -1666.67, rounded away from zero -> -1667.
    expect(mannWhitneyU(c, d)).toEqual({ uDoubled: 5, rBp: -1667 })
    // Rank-sum again: combined sorted 2, 4, 4, 5, 6; the two 4s share ranks 2 and 3 (average 2.5, doubled 5), so c's
    // doubled ranks are 2, 5, 10, R1 doubled = 17, and 2U = 17 - 3*4 = 5. A broken tie rule would give 4 or 6 here.
    expect(doubledUFromRankSum(c, d)).toBe(5)
    expect(mannWhitneyU(c, d)?.uDoubled).toBe(doubledUFromRankSum(c, d))

    // The ends of the scale. Every a above every b is r = +1; the same pair the other way round is r = -1.
    expect(mannWhitneyU([5, 6], [1, 2])).toEqual({ uDoubled: 8, rBp: 10000 })
    expect(mannWhitneyU([1, 2], [5, 6])).toEqual({ uDoubled: 0, rBp: -10000 })
  })

  it('gives rank-biserial r of zero when the two groups interleave evenly', () => {
    const a = [1, 4, 5, 8]
    const b = [2, 3, 6, 7]
    // 1 loses 4; 4 beats 2, 3 and loses to 6, 7; 5 beats 2, 3 and loses to 6, 7; 8 beats 4.
    //   wins = 0 + 2 + 2 + 4 = 8, losses = 4 + 2 + 2 + 0 = 8, ties = 0, pairs = 16.
    // r = (8-8)/16 = 0 exactly, and uDoubled = 2*8 = 16 = n1*n2, which is what r = 0 means in doubled units.
    expect(mannWhitneyU(a, b)).toEqual({ uDoubled: 16, rBp: 0 })
    expect(doubledUFromRankSum(a, b)).toBe(16)
    // A zero here is an answer, not an absence: move 5 from b up past 6 in a and it leaves zero. With
    // a = 1, 4, 6, 8 against b = 2, 3, 5, 7: wins = 0 + 2 + 3 + 4 = 9, losses = 4 + 2 + 1 + 0 = 7, so uDoubled = 18 and
    // r = (9-7)/16 = 1/8 = 1250 bp.
    expect(mannWhitneyU([1, 4, 6, 8], [2, 3, 5, 7])).toEqual({ uDoubled: 18, rBp: 1250 })
  })

  it('returns null for Mann-Whitney when a group is empty', () => {
    expect(mannWhitneyU([], [1, 2, 3])).toBeNull()
    expect(mannWhitneyU([1, 2, 3], [])).toBeNull()
    expect(mannWhitneyU([], [])).toBeNull()
    // One value each is still a comparison, so it is answered rather than refused.
    expect(mannWhitneyU([2], [1])).toEqual({ uDoubled: 2, rBp: 10000 })
  })

  it('matches a worked chi-square by hand on a 2x2 table', () => {
    // Reason (A or B) against whether the spend was judged worthwhile - §12's "Reason -> worthwhile" shape.
    //            worthwhile   not      row
    //   A            30        10       40
    //   B            10        20       30
    //   col          40        30       70 = total
    //
    // Each cell's term is total * O^2 / (row*col), summed, then total subtracted (the module comment derives that
    // from sum((O-E)^2/E)); in CHI_SCALE = 10000 units:
    //   A/worthwhile: 10000 * 30*30 * 70 / (40*40) = 630000000 / 1600 = 393750       exactly
    //   A/not:        10000 * 10*10 * 70 / (40*30) =  70000000 / 1200 =  58333.33... -> 58333
    //   B/worthwhile: 10000 * 10*10 * 70 / (30*40) =  70000000 / 1200 =  58333.33... -> 58333
    //   B/not:        10000 * 20*20 * 70 / (30*30) = 280000000 /  900 = 311111.11... -> 311111
    //   sum = 821527 ; minus 10000*70 = 700000 -> 121527
    //
    // Independently, the closed form for a 2x2: chi-square = N(ad-bc)^2 / (r1*r2*c1*c2)
    //   = 70 * (30*20 - 10*10)^2 / (40*30*40*30) = 70 * 250000 / 1440000 = 17500000/1440000 = 875/72 = 12.1527777...
    // which is 121527.78 in CHI_SCALE units. The two routes agree; the implementation lands one unit (1e-4 of a
    // chi-square) low because each of the four cells is rounded on its own, which is the documented bound of
    // cells/2 units.
    expect(chiSquareScaled([[30, 10], [10, 20]])).toEqual({ chiScaled: 121527, df: 1 })
    expect(CHI_SCALE).toBe(10000)

    // A 2x3 and a 3x3 with their degrees of freedom and an exact chi-square each.
    //   [[3,0,0],[0,3,3]]: rows 3, 6; cols 3, 3, 3; total 9.
    //     10000*9*9/(3*3) = 90000 ; 10000*9*9/(6*3) = 45000 twice ; sum 180000 - 90000 = 90000, i.e. chi-square 9.
    expect(chiSquareScaled([[3, 0, 0], [0, 3, 3]])).toEqual({ chiScaled: 90000, df: 2 })
    //   [[2,0,0],[0,2,0],[0,0,2]]: every margin 2, total 6. Each diagonal cell 10000*4*6/(2*2) = 60000, so
    //     3*60000 - 10000*6 = 120000, i.e. chi-square 12. df = 2*2 = 4.
    expect(chiSquareScaled([[2, 0, 0], [0, 2, 0], [0, 0, 2]])).toEqual({ chiScaled: 120000, df: 4 })
    // An exactly independent table is exactly zero, with no rounding anywhere: O = row*col/total makes each term the
    // integer O. 3x4 of all ones: margins 4, 4, 4 and 3, 3, 3, 3; total 12; every E = 4*3/12 = 1 = O.
    expect(chiSquareScaled([[1, 1, 1, 1], [1, 1, 1, 1], [1, 1, 1, 1]])).toEqual({ chiScaled: 0, df: 6 })
  })

  it('returns null for chi-square when a row or column is empty', () => {
    expect(chiSquareScaled([[0, 0], [3, 4]])).toBeNull() // empty row: the expected counts in it would be 0
    expect(chiSquareScaled([[3, 4], [0, 0]])).toBeNull()
    expect(chiSquareScaled([[0, 3], [0, 4]])).toBeNull() // empty column
    expect(chiSquareScaled([[3, 0], [4, 0]])).toBeNull()
    expect(chiSquareScaled([[0, 0], [0, 0]])).toBeNull() // no observations at all
    // The zeros are not themselves the problem: one count in the empty row and the same table answers.
    expect(chiSquareScaled([[1, 0], [3, 4]])).not.toBeNull()
  })

  it('returns null for a chi-square the table cannot carry', () => {
    expect(chiSquareScaled([])).toBeNull()
    expect(chiSquareScaled([[1, 2, 3]])).toBeNull() // one row: no degree of freedom
    expect(chiSquareScaled([[1], [2]])).toBeNull() // one column
    expect(chiSquareScaled([[], []])).toBeNull()
    expect(chiSquareScaled([[1, 2], [3]])).toBeNull() // ragged
    expect(chiSquareScaled([[1, 2], [3, 4, 5]])).toBeNull()
    expect(chiSquareScaled([[-1, 2], [3, 4]])).toBeNull() // not counts
  })

  it('matches a worked Cramers V, and is zero for an independent table', () => {
    // The 2x2 above: chi-square 875/72 on 70 observations, k = min(rows-1, cols-1) = 1.
    //   V = sqrt(chi-square / (total*k)) = sqrt((875/72) / 70) = sqrt(875/5040) = sqrt(25/144) = 5/12 = 0.4166666...
    // Independently, for a 2x2 that is phi = |ad-bc| / sqrt(r1*r2*c1*c2) = 500 / sqrt(1440000) = 500/1200 = 5/12.
    // In basis points 4166.666..., and isqrt floors, so V is reported as 4166 - one basis point low, never high.
    expect(cramersVBp(121527, 70, 2, 2)).toBe(4166)
    // Perfect association reaches exactly 1.0, which is the check that k is the SMALLER dimension: the 3x3 above has
    // chi-square 12 on 6 observations, so V = sqrt(12/(6*2)) = sqrt(1) = 1. With k = 1 it would read 14142 (above
    // 1.0, which V cannot be) and with k = (rows-1)*(cols-1) = 4 it would read 7071.
    expect(cramersVBp(120000, 6, 3, 3)).toBe(10000)
    // And from the other side, where rows-1 < cols-1: the 2x3 above, chi-square 9 on 9 observations, k = 1, V = 1.
    // Taking the larger dimension (k = 2) would read 7071 here.
    expect(cramersVBp(90000, 9, 2, 3)).toBe(10000)
    // An independent table has a chi-square of 0, and V is then 0 - a real zero association, not a missing one.
    const independent = chiSquareScaled([[2, 4], [3, 6]])
    expect(independent).toEqual({ chiScaled: 0, df: 1 })
    expect(cramersVBp(independent?.chiScaled ?? -1, 15, 2, 2)).toBe(0)
  })

  it('returns null for Cramers V where there is no V to report', () => {
    expect(cramersVBp(121527, 0, 2, 2)).toBeNull() // nothing was observed
    expect(cramersVBp(121527, -1, 2, 2)).toBeNull()
    expect(cramersVBp(121527, 70, 1, 2)).toBeNull() // one row: k would be 0
    expect(cramersVBp(121527, 70, 2, 1)).toBeNull()
    expect(cramersVBp(-1, 70, 2, 2)).toBeNull() // not a chi-square
    expect(cramersVBp(121527, 70, 2, 2)).not.toBeNull()
  })

  it('uses no floating-point arithmetic', () => {
    const raw = readFileSync(resolve(import.meta.dirname, 'stats.ts'), 'utf8')
    // Code only: comments go first (they are full of prose like "6*sum(d^2)/(n(n^2-1))" that would otherwise read as
    // division, and full of apostrophes that would wreck a string pass run before them), then string literals.
    const code = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
      .replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, '""')
    expect(code).toMatch(/function isqrtBig/) // the scan is looking at the real file, stripped but not gutted
    expect(code).toMatch(/divRound\(/) // and the rounding divisions do go through money.ts
    // Every division written in the file, and there are only these two: both are BigInt divisions, which are exact
    // and truncating rather than floating, and both operate on positive operands only. Every other division in the
    // module goes through divRound or divRoundBig, whose call sites carry no `/` at all.
    expect(code.split('\n').filter((l) => l.includes('/')).map((l) => l.trim())).toEqual([
      'const step = (x: bigint): bigint => (x + n / x) / 2n',
      'const q = n / d',
    ])
    // Stronger than a list of banned functions: the module calls NO Math function at all except Math.min - so no
    // floor, no round, no ceil, no sqrt, no pow, and nothing added later can slip in under a name nobody listed.
    expect(code.match(/Math\.\w+/g)).toEqual(['Math.min'])
    expect(code).not.toMatch(/\b(parseFloat|parseInt|Number\.parseFloat|toFixed|toPrecision)\b/)
    expect(code).not.toMatch(/\*\*/)
    expect(code).not.toMatch(/\d\.\d|\d\.(?!\w)|(?<![\w.])\.\d/) // no decimal literal
    expect(code).not.toMatch(/\be[+-]?\d/) // no exponent literal either, which the tree-wide guard does not catch
  })
})
