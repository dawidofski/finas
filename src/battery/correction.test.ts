import { describe, expect, it } from 'vitest'
import { benjaminiHochberg } from './correction'
import type { Bracket } from './critical'

// Every expected value below is worked by hand from the Benjamini-Hochberg step-up rule at FDR 5 %, NOT read back from
// ALPHA_BP or from the module: sort the m p-values ascending, find the largest rank k with p(k) <= k * 0.05 / m, and
// everything at or below p(k) survives. A bracket stands in for p by its upper bound: 'p<0.01' = 0.01, 'p<0.05' = 0.05,
// and 'none' = 1 (it still counts in m).

const mk = (brackets: Bracket[]) => brackets.map((bracket, i) => ({ item: `r${i}`, bracket }))
const survivors = (r: { results: { item: string; survives: boolean }[] }) =>
  r.results.filter((x) => x.survives).map((x) => x.item).sort()
const nones = (n: number): Bracket[] => Array<Bracket>(n).fill('none')

describe('benjaminiHochberg', () => {
  it('withholds a result that would pass uncorrected but not after correction', () => {
    // Ten relationships tested; one reaches p<0.05, nine show nothing. Alone, 0.05 <= 0.05 passes.
    // Corrected, m = 10: rank 1 needs p <= 1 * 0.05 / 10 = 0.005. 0.05 > 0.005, so it is withheld.
    // (Ten independent tests at 5 % each: 1 - 0.95^10 = 40 % chance of at least one false positive. That is the harm.)
    const out = benjaminiHochberg(mk(['p<0.05', ...nones(9)]))
    expect(out.results[0]?.bracket).toBe('p<0.05')
    expect(out.results[0]?.survives).toBe(false)
    expect(survivors(out)).toEqual([])
    expect(out.thresholdBp).toBeNull()
    expect(out.tested).toBe(10)
    // The same single result tested on its own (m = 1): rank 1 needs p <= 0.05, 0.05 <= 0.05, so it passes.
    expect(survivors(benjaminiHochberg(mk(['p<0.05'])))).toEqual(['r0'])
  })

  it('keeps the strongest result when several are tested', () => {
    // m = 10: two at p<0.01 (0.01), eight none (1). Rank 2 needs 0.01 <= 2*0.05/10 = 0.01: yes (equality admits).
    // Rank 3 is 1 > 0.015, no. Largest passing k = 2, so both p<0.01 survive and no none does.
    const two = benjaminiHochberg(mk(['p<0.01', 'p<0.01', ...nones(8)]))
    expect(survivors(two)).toEqual(['r0', 'r1'])
    // One p<0.01 alone among ten: rank 1 needs 0.01 <= 0.005: no. Nothing survives.
    expect(survivors(benjaminiHochberg(mk(['p<0.01', ...nones(9)])))).toEqual([])
    // A p<0.05 beside two p<0.01 in m = 10: ranks 1,2 = 0.01 (k=2 passes), rank 3 = 0.05 needs <= 0.015: no.
    // The strong two are kept and the weaker one is not.
    const mixed = benjaminiHochberg(mk(['p<0.05', 'p<0.01', 'p<0.01', ...nones(7)]))
    expect(survivors(mixed)).toEqual(['r1', 'r2'])
  })

  it('reports the corrected threshold it applied, so the screen can show it', () => {
    // Two p<0.01 in m = 10: cutoff rank k = 2, threshold k * 5 % / m = 2 * 500 bp / 10 = 100 bp.
    expect(benjaminiHochberg(mk(['p<0.01', 'p<0.01', ...nones(8)])).thresholdBp).toBe(100)
    // Three p<0.01 in m = 10: rank 3 needs 0.01 <= 0.015 yes, so k = 3 and the threshold is 3 * 500 / 10 = 150 bp.
    expect(benjaminiHochberg(mk(['p<0.01', 'p<0.01', 'p<0.01', ...nones(7)])).thresholdBp).toBe(150)
    // Two p<0.01 in m = 3: k = 2, 2 * 500 / 3 = 333.33 bp. Shown rounded DOWN to 333, never up to a looser 334.
    expect(benjaminiHochberg(mk(['p<0.01', 'p<0.01', 'none'])).thresholdBp).toBe(333)
    // Nobody survives: there is no threshold that was applied.
    expect(benjaminiHochberg(mk(['p<0.05', 'none'])).thresholdBp).toBeNull()
  })

  it('is conservative: using each brackets upper bound can only withhold, never admit', () => {
    // Independent oracle in real arithmetic, with p set to the bracket's upper bound, over every assignment of m = 1..6.
    const P: Record<Bracket, number> = { 'p<0.001': 0.001, 'p<0.01': 0.01, 'p<0.05': 0.05, none: 1 }
    const all: Bracket[] = ['p<0.001', 'p<0.01', 'p<0.05', 'none']
    const oracle = (bs: Bracket[]): boolean[] => {
      const m = bs.length
      const sorted = bs.map((b) => P[b]).sort((a, b) => a - b)
      let cut = -1
      sorted.forEach((p, i) => {
        if (p <= ((i + 1) * 0.05) / m + 1e-12) cut = p
      })
      return bs.map((b) => cut >= 0 && P[b] <= cut)
    }
    const assignments = (m: number): Bracket[][] =>
      m === 0 ? [[]] : assignments(m - 1).flatMap((rest) => all.map((b) => [b, ...rest]))
    for (let m = 1; m <= 6; m++) {
      for (const bs of assignments(m)) {
        const got = benjaminiHochberg(mk(bs)).results.map((r) => r.survives)
        expect(got, bs.join(',')).toEqual(oracle(bs))
        // Weakening any one bracket never makes ANOTHER item newly survive.
        bs.forEach((b, i) => {
          const weaker: Bracket | null =
            b === 'p<0.001' ? 'p<0.01' : b === 'p<0.01' ? 'p<0.05' : b === 'p<0.05' ? 'none' : null
          if (weaker === null) return
          const w = [...bs]
          w[i] = weaker
          const after = benjaminiHochberg(mk(w)).results.map((r) => r.survives)
          after.forEach((s, j) => {
            if (j !== i && s) expect(got[j], `${bs} -> ${w}`).toBe(true)
          })
        })
      }
    }
  })

  it('needs a rung stronger than p<0.01: a lone p<0.01 among ten can never survive, a lone p<0.001 can', () => {
    // All ten relationships tested, one finding, nine none. Rank 1 needs p <= 1 * 0.05 / 10 = 0.005 (50 bp).
    // p<0.001 stands in as 0.001 (10 bp): 10 <= 50, so k = 1 and the strong one survives.
    // p<0.01 stands in as 0.01 (100 bp): 100 > 50, and no larger k helps because every other item sits at p = 1
    // (10000 > k * 50 for all k <= 10). So it is withheld at ANY effect size. Without the finer rung the battery
    // would go permanently silent exactly when all ten gates open.
    const strong = benjaminiHochberg(mk(['p<0.001', ...nones(9)]))
    expect(survivors(strong)).toEqual(['r0'])
    expect(strong.thresholdBp).toBe(50)
    const weak = benjaminiHochberg(mk(['p<0.01', ...nones(9)]))
    expect(survivors(weak)).toEqual([])
    expect(weak.thresholdBp).toBeNull()
  })

  it('counts an unbracketed item in the number tested, so adding a hopeless relationship cannot buy significance', () => {
    // Two p<0.01 among m = 10 survive (0.01 <= 2*0.05/10). Add an eleventh, none: m = 11, rank 2 needs
    // 0.01 <= 2 * 0.05 / 11 = 0.00909: no. Nothing survives. The extra none made things STRICTER, as it must.
    const ten = benjaminiHochberg(mk(['p<0.01', 'p<0.01', ...nones(8)]))
    const eleven = benjaminiHochberg(mk(['p<0.01', 'p<0.01', ...nones(9)]))
    expect(ten.tested).toBe(10)
    expect(eleven.tested).toBe(11)
    expect(survivors(ten)).toEqual(['r0', 'r1'])
    expect(survivors(eleven)).toEqual([])
  })

  it('handles every result unbracketed, and every result significant', () => {
    const none = benjaminiHochberg(mk(nones(3)))
    expect(survivors(none)).toEqual([])
    expect(none.thresholdBp).toBeNull()
    expect(none.tested).toBe(3)
    // Ten p<0.01: rank 10 needs 0.01 <= 10*0.05/10 = 0.05: yes. All survive, threshold 10 * 500 / 10 = 500 bp.
    const strong = benjaminiHochberg(mk(Array<Bracket>(10).fill('p<0.01')))
    expect(survivors(strong)).toHaveLength(10)
    expect(strong.thresholdBp).toBe(500)
    // Ten p<0.05: rank 10 needs 0.05 <= 0.05: yes (equality). All survive. Nine of ten does not: rank 9 needs 0.05 <= 0.045.
    expect(survivors(benjaminiHochberg(mk(Array<Bracket>(10).fill('p<0.05'))))).toHaveLength(10)
    expect(survivors(benjaminiHochberg(mk([...Array<Bracket>(9).fill('p<0.05'), 'none'])))).toEqual([])
    // Nothing tested: nothing to report.
    expect(benjaminiHochberg<string>([])).toEqual({ results: [], thresholdBp: null, tested: 0 })
  })

  it('orders ties deterministically, so the outcome never depends on input order', () => {
    // Items sharing a bracket share a p, so they share a verdict: the tie group is judged at its LAST rank, never at
    // an arbitrary one. 2 p<0.01, 1 p<0.05, 1 none, m = 4: rank 2 needs 0.01 <= 0.025 yes, rank 3 needs
    // 0.05 <= 0.0375 no. Survivors are exactly the two p<0.01, whichever way round they arrive. Threshold 2*500/4 = 250.
    type Row = { item: string; bracket: Bracket }
    const base: Row[] = [
      { item: 'a', bracket: 'p<0.01' },
      { item: 'b', bracket: 'p<0.05' },
      { item: 'c', bracket: 'p<0.01' },
      { item: 'd', bracket: 'none' },
    ]
    const perms = (xs: Row[]): Row[][] =>
      xs.length <= 1 ? [xs] : xs.flatMap((x, i) => perms([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]))
    const verdict = (xs: Row[]) => {
      const r = benjaminiHochberg(xs)
      return { s: Object.fromEntries(r.results.map((x) => [x.item, x.survives])), t: r.thresholdBp, n: r.tested }
    }
    const expected = { s: { a: true, b: false, c: true, d: false }, t: 250, n: 4 }
    const all = perms(base)
    expect(all).toHaveLength(24)
    for (const p of all) expect(verdict(p)).toEqual(expected)
  })
})
