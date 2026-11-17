import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MIN_SCALE_CENTS, UNUSUAL_SCORE_BP, unusualIn } from './unusual'

const row = (id: string, categoryId: string | null, cents: number, month = '2026-05') => ({ id, categoryId, cents, month })
const rows = (category: string, prefix: string, ...cents: number[]) => cents.map((c, i) => row(`${prefix}${i}`, category, c))

// Seven ordinary grocery shops. Joined by any one more row they have median 4050 and MAD 150.
const groceries = rows('groceries', 'g', 4000, 4200, 3800, 4100, 3900, 4000, 4300)

describe('unusualIn', () => {
  it('finds a purchase far above the owner usual spend in that category', () => {
    const found = unusualIn([...groceries, row('big', 'groceries', 20000, '2026-06')], 5)
    expect(found).toEqual([
      { transactionId: 'big', categoryId: 'groceries', cents: 20000, month: '2026-06', medianCents: 4050, madCents: 150, scoreBp: 717218 },
    ])
    // 6745 * (20000 - 4050) / 150 = 717218.3: a robust z of about 71.7, held as an integer number of basis points.
    for (const v of Object.values(found[0] ?? {})) if (typeof v === 'number') expect(Number.isInteger(v)).toBe(true)
  })

  it('reports only what is above the line, to the basis point, and never an unusually small purchase', () => {
    // 4828 scores 34984 bp, 4829 scores 35029 bp: the line is exactly UNUSUAL_SCORE_BP.
    expect(UNUSUAL_SCORE_BP).toBe(35000)
    expect(unusualIn([...groceries, row('under', 'groceries', 4828)], 5)).toEqual([])
    expect(unusualIn([...groceries, row('over', 'groceries', 4829)], 5).map((u) => [u.transactionId, u.scoreBp])).toEqual([['over', 35029]])
    // A middling purchase well short of the line, and a purchase far BELOW the median.
    expect(unusualIn([...groceries, row('mid', 'groceries', 4600)], 5)).toEqual([])
    expect(unusualIn([...groceries, row('tiny', 'groceries', 1)], 5)).toEqual([])
  })

  it('says nothing for a category with fewer rows than the minimum sample', () => {
    const blatant = [...rows('travel', 't', 5000, 5100, 4900), row('huge', 'travel', 900000)]
    expect(blatant).toHaveLength(4)
    expect(unusualIn(blatant, 5)).toEqual([])
    // At exactly minSample rows the same history is enough: the floor is minSample, not minSample + 1.
    expect(unusualIn(blatant, 4).map((u) => u.transactionId)).toEqual(['huge'])
    expect(unusualIn([...blatant, row('t3', 'travel', 5000)], 5).map((u) => u.transactionId)).toEqual(['huge'])
  })

  it('says nothing when nothing deviates, and never divides by a zero spread', () => {
    // Three identical subscription charges, and a longer run of them: nothing deviates, so nothing is unusual.
    expect(unusualIn(rows('subs', 's', 999, 999, 999), 3)).toEqual([])
    expect(unusualIn(rows('subs', 's', 999, 999, 999, 999, 999, 999), 3)).toEqual([])
  })

  it('finds a one-off among otherwise identical charges, which have a spread of zero', () => {
    // MAD is 0 here. The floor (MIN_SCALE_CENTS) stands in for it: 6745 * (5000 - 999) / 100 = 269867 bp.
    expect(MIN_SCALE_CENTS).toBe(100)
    const found = unusualIn([...rows('subs', 's', 999, 999, 999, 999, 999), row('odd', 'subs', 5000)], 3)
    expect(found).toEqual([{ transactionId: 'odd', categoryId: 'subs', cents: 5000, month: '2026-05', medianCents: 999, madCents: 0, scoreBp: 269867 }])
    // Remove the floor and this is a division by zero: an infinite score, not this one.
    expect(Number.isFinite(found[0]?.scoreBp)).toBe(true)
  })

  it('stays quiet about a near-identical one-off, so the floor does not turn the feature into noise', () => {
    const regular = rows('subs', 's', 999, 999, 999, 999, 999)
    expect(unusualIn([...regular, row('near', 'subs', 1150)], 3)).toEqual([]) // 151 away: about 10185 bp
    expect(unusualIn([...regular, row('edge', 'subs', 999 + 518)], 3)).toEqual([]) // 34938 bp
    expect(unusualIn([...regular, row('edge', 'subs', 999 + 519)], 3).map((u) => u.scoreBp)).toEqual([35007]) // the line
  })

  it('is unaffected by one extreme value, which a mean-based score would not be', () => {
    const ordinary = rows('hobby', 'h', 1000, 1010, 990, 1000, 1010, 990, 1000, 1010, 990, 1000)
    const withHuge = (huge: number) => unusualIn([...ordinary, row('mod', 'hobby', 3000), row('huge', 'hobby', huge)], 5)

    // What a mean-based score would see: the mean and standard deviation are dragged up by the huge row.
    // |x - mean| < sd  <=>  (n*x - sum)^2 < n*sumSq - sum^2, which needs no square root.
    const all = [...ordinary.map((r) => r.cents), 3000, 1_000_000]
    const n = all.length
    const sum = all.reduce((a, b) => a + b, 0)
    const sumSq = all.reduce((a, b) => a + b * b, 0)
    expect((n * 3000 - sum) * (n * 3000 - sum)).toBeLessThan(n * sumSq - sum * sum) // within one sd of the mean: a mean would miss it

    // The median and MAD do not care how extreme the extreme row is, so the moderate row is still found...
    const a = withHuge(1_000_000)
    const b = withHuge(100_000_000)
    expect(a.map((u) => u.transactionId)).toEqual(['huge', 'mod'])
    const modA = a.find((u) => u.transactionId === 'mod')
    const modB = b.find((u) => u.transactionId === 'mod')
    expect(modA).toEqual({ transactionId: 'mod', categoryId: 'hobby', cents: 3000, month: '2026-05', medianCents: 1000, madCents: 10, scoreBp: 134900 })
    // ...with the very same score however large the other one grows; only the huge row's own score moved.
    expect(modB).toEqual(modA)
    expect(b[0]?.scoreBp).toBeGreaterThan(a[0]?.scoreBp ?? Infinity)
  })

  it('compares each category only against itself', () => {
    const rent = rows('rent', 'r', 120000, 120000, 120500, 119500, 120000, 120200)
    const found = unusualIn([...groceries, ...rent, row('shop', 'groceries', 120000), row('rentRise', 'rent', 120300)], 5)
    // 120000 is the owner's ordinary rent and an absurd grocery bill: only the grocery row is reported.
    expect(found.map((u) => u.transactionId)).toEqual(['shop'])
    expect(found[0]?.medianCents).toBe(4050) // computed from groceries alone, not from the pooled rows
    // Rows with no category have no history of their own: never reported, never mixed into another category.
    const unfiled = [...groceries, ...rows('x', 'u', 100, 120, 80, 110, 90, 100).map((r) => ({ ...r, categoryId: null })), row('uBig', null, 999999)]
    expect(unusualIn(unfiled, 5)).toEqual([])
    expect(unusualIn([...unfiled, row('big', 'groceries', 20000)], 5).map((u) => [u.transactionId, u.medianCents])).toEqual([['big', 4050]])
  })

  it('rounds the median of an even sample half away from zero, to a whole cent', () => {
    // Ten rows, middle two are 1000 and 1001: the half-cent median 1000.5 becomes 1001.
    const even = [...rows('c', 'c', 1000, 1000, 1000, 1000, 1000, 1001, 1001, 1001, 1001), row('big', 'c', 9000)]
    const [u] = unusualIn(even, 5)
    expect(u?.medianCents).toBe(1001)
    expect(u?.madCents).toBe(1) // |x - 1001| sorted: 0 0 0 0 1 1 1 1 1 7999, middle two are 1 and 1
    expect(u?.scoreBp).toBe(539533) // 6745 * 7999 / 100, the spread of 1 being floored to 100
  })

  it('gives the same answer in the same order however the rows arrive', () => {
    const data = [
      ...groceries,
      ...rows('travel', 't', 5000, 5100, 4900, 5000, 5050),
      row('b1', 'groceries', 20000),
      row('b2', 'groceries', 20000), // same score as b1 and b0: ties must break on id
      row('b3', 'travel', 40000),
      row('b0', 'groceries', 20000),
    ]
    const forward = unusualIn(data, 5)
    expect(forward.map((u) => u.transactionId)).toEqual(['b3', 'b0', 'b1', 'b2'])
    const scores = forward.map((u) => u.scoreBp)
    expect(scores).toEqual([...scores].sort((x, y) => y - x))
    expect(unusualIn([...data].reverse(), 5)).toEqual(forward)
    expect(unusualIn([...data.slice(9), ...data.slice(0, 9)], 5)).toEqual(forward)
    expect(unusualIn([...data.filter((_, i) => i % 2 === 0), ...data.filter((_, i) => i % 2 === 1)], 5)).toEqual(forward)
  })

  it('returns nothing for no rows', () => {
    expect(unusualIn([], 1)).toEqual([])
  })

  it('uses no floating-point arithmetic', () => {
    const raw = readFileSync(resolve(import.meta.dirname, 'unusual.ts'), 'utf8')
    // Code only: drop comments and string literals so prose like "n / d" cannot hide or fake a match.
    const code = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
      .replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, '""')
    expect(code).toMatch(/function divFloor/) // the scan is looking at the real file
    expect(code).toMatch(/function divRound/)
    // The single division in the file is the integer floor in divFloor; no other `/` may appear.
    expect(code.split('\n').filter((l) => l.includes('/')).map((l) => l.trim())).toEqual(['return Math.floor(n / d)'])
    expect(code).not.toMatch(/\b(parseFloat|toFixed|toPrecision)\b/)
    expect(code).not.toMatch(/Math\.(log|log2|log10|exp|pow|sqrt|cbrt|random|fround|hypot|round|ceil|trunc)\b/)
    expect(code).not.toMatch(/\*\*/)
    expect(code).not.toMatch(/\d\.\d|\d\.(?!\w)|(?<![\w.])\.\d/) // no decimal literal
  })
})
