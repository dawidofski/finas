import { describe, it, expect } from 'vitest'
import { addDays } from '../lib/dates'
import { detectRecurring, MIN_OCCURRENCES, type Detected, type Frequency } from './detect'

// Bank amounts for a spend are negative; the detector reports magnitudes.
const row = (merchantId: string, valueDate: string, amountCents: number) => ({ merchantId, valueDate, amountCents })

/** `count` payments starting on `start`, `gap` days apart. */
function series(merchantId: string, gap: number, count: number, amountCents = -1000, start = '2026-01-01') {
  return Array.from({ length: count }, (_, i) => row(merchantId, addDays(start, i * gap), amountCents))
}

/** Payments whose consecutive gaps are exactly `gaps`, starting 2026-01-01. */
function withGaps(merchantId: string, gaps: readonly number[], amountCents = -1000) {
  let d = '2026-01-01'
  const out = [row(merchantId, d, amountCents)]
  for (const g of gaps) { d = addDays(d, g); out.push(row(merchantId, d, amountCents)) }
  return out
}

const one = (rows: ReturnType<typeof series>): Detected => {
  const r = detectRecurring(rows)
  expect(r).toHaveLength(1)
  return r[0] as Detected
}

describe('detectRecurring', () => {
  it('finds a monthly payment from its gaps and says when the next is expected', () => {
    // 15 Jan -> 14 Feb (30 d: 16 days left in Jan + 14) -> 16 Mar (30 d: Feb has 28) -> 15 Apr (30 d).
    // Median gap 30, so next = 15 Apr + 30 = 15 May.
    const d = one([
      row('netflix', '2026-01-15', -1299), row('netflix', '2026-02-14', -1299),
      row('netflix', '2026-03-16', -1299), row('netflix', '2026-04-15', -1299),
    ])
    expect(d).toMatchObject({
      merchantId: 'netflix', amountCents: 1299, frequency: 'monthly', occurrences: 4,
      lastSeenDate: '2026-04-15', expectedNextDate: '2026-05-15', amountChanged: null,
    })
  })

  it('reports the amount as a positive magnitude whichever sign the bank used', () => {
    expect(one(series('m', 30, 3, -1299)).amountCents).toBe(1299)
    expect(one(series('m', 30, 3, 1299)).amountCents).toBe(1299)
  })

  it('does not report a merchant paid only twice', () => {
    expect(MIN_OCCURRENCES).toBe(3)
    expect(detectRecurring(series('m', 30, 2))).toEqual([])
    expect(detectRecurring(series('m', 30, 0))).toEqual([])
    expect(detectRecurring(series('m', 30, 3))).toHaveLength(1)
  })

  it('keeps two different amounts at one merchant as two payments', () => {
    const rows = [...series('shop', 30, 3, -1000), ...series('shop', 30, 3, -5000)]
    const r = detectRecurring(rows)
    expect(r.map((d) => d.amountCents)).toEqual([1000, 5000])
    expect(r.every((d) => d.occurrences === 3 && d.frequency === 'monthly')).toBe(true)
  })

  it('does not report two different amounts that are only two payments each', () => {
    expect(detectRecurring([...series('shop', 30, 2, -1000), ...series('shop', 30, 2, -5000)])).toEqual([])
  })

  it('never mixes merchants', () => {
    expect(detectRecurring([...series('a', 30, 2), ...series('b', 30, 2)])).toEqual([])
  })

  it('calls irregular gaps irregular and gives no expected date', () => {
    // gaps 12, 50, 12: median 12, in no band.
    const d = one(withGaps('m', [12, 50, 12]))
    expect(d.frequency).toBe('irregular')
    expect(d.expectedNextDate).toBeNull()
    expect(d.occurrences).toBe(4)
  })

  it('treats a small price change as the same payment and reports the change', () => {
    // 3 x 10,00 then two payments at 10,80: one payment, a sustained step up of 80 > max(50, 2%)
    const d = one([...series('m', 30, 3, -1000), row('m', '2026-04-01', -1080), row('m', '2026-05-01', -1080)])
    expect(d.occurrences).toBe(5)
    expect(d.amountChanged).toEqual({ fromCents: 1000, toCents: 1080 })
  })

  it('reports a sustained step down too', () => {
    const d = one([...series('m', 30, 3, -1000), row('m', '2026-04-01', -920), row('m', '2026-05-01', -920)])
    expect(d.amountChanged).toEqual({ fromCents: 1000, toCents: 920 })
  })

  it('reports no change when every payment is the same amount', () => {
    expect(one(series('m', 30, 4, -1000)).amountChanged).toBeNull()
  })

  it('reports no change for a variable bill that wobbles inside the tolerance', () => {
    const amounts = [-1000, -1030, -990, -1020, -1010, -1040]
    const d = one(amounts.map((a, i) => row('electric', addDays('2026-01-01', i * 30), a)))
    expect(d.occurrences).toBe(6)
    expect(d.amountChanged).toBeNull()
  })

  it('does not report a change from a single payment, nor one that goes both ways', () => {
    expect(one([...series('m', 30, 3, -1000), row('m', '2026-04-01', -1080)]).amountChanged).toBeNull()
    expect(one([...series('m', 30, 3, -1000), row('m', '2026-04-01', -1080), row('m', '2026-05-01', -920)]).amountChanged).toBeNull()
  })

  it('needs both latest payments to clear the threshold: more than 50 cents on a 10,00 bill', () => {
    const at = (x: number) => one([...series('m', 30, 3, -1000), row('m', '2026-04-01', -x), row('m', '2026-05-01', -x)]).amountChanged
    expect(at(1050)).toBeNull()
    expect(at(1051)).toEqual({ fromCents: 1000, toCents: 1051 })
    expect(one([...series('m', 30, 3, -1000), row('m', '2026-04-01', -1051), row('m', '2026-05-01', -1050)]).amountChanged).toBeNull()
    expect(one([...series('m', 30, 3, -1000), row('m', '2026-04-01', -1050), row('m', '2026-05-01', -1051)]).amountChanged).toBeNull()
  })

  it('uses 2% of the earlier median once that exceeds 50 cents: 40,00 needs more than 80', () => {
    const at = (x: number) => one([...series('m', 30, 3, -4000), row('m', '2026-04-01', -x), row('m', '2026-05-01', -x)]).amountChanged
    expect(at(4080)).toBeNull()
    expect(at(4081)).toEqual({ fromCents: 4000, toCents: 4081 })
  })

  it('compares the latest two with the median of the payments before them', () => {
    // before the last two: 1000, 1040, 1000 -> median 1000; latest two 1070, 1080
    const d = one([
      row('m', '2026-01-01', -1000), row('m', '2026-01-31', -1040), row('m', '2026-03-02', -1000),
      row('m', '2026-04-01', -1070), row('m', '2026-05-01', -1080),
    ])
    expect(d.amountChanged).toEqual({ fromCents: 1000, toCents: 1080 })
  })

  it('scores a steadier payment above an uneven one with the same count', () => {
    const steady = one(withGaps('m', [30, 30, 30, 30]))
    const uneven = one(withGaps('m', [30, 30, 30, 60])) // one missed month: 3 of 4 gaps in band
    expect(steady.occurrences).toBe(uneven.occurrences)
    expect(uneven.frequency).toBe('monthly')
    expect(steady.matchScoreBp).toBeGreaterThan(uneven.matchScoreBp)
  })

  it('scores one missed month in a year well above zero', () => {
    const gaps = [30, 30, 30, 30, 30, 60, 30, 30, 30, 30, 30]
    const d = one(withGaps('m', gaps))
    expect(d.frequency).toBe('monthly')
    expect(d.matchScoreBp).toBeGreaterThan(5000)
  })

  it('never lowers the score for more occurrences at the same spread', () => {
    let prev = -1
    for (let n = MIN_OCCURRENCES; n <= 24; n++) {
      const s = one(series('m', 30, n)).matchScoreBp
      expect(s).toBeGreaterThanOrEqual(prev)
      prev = s
    }
    expect(one(series('m', 30, 12)).matchScoreBp).toBeGreaterThan(one(series('m', 30, 3)).matchScoreBp)
  })

  it('never lowers the score for more in-band gaps out of the same twelve', () => {
    let prev = -1
    for (let outOfBand = 4; outOfBand >= 0; outOfBand--) {
      const gaps = Array.from({ length: 12 }, (_, i) => (i < outOfBand ? 60 : 30))
      const s = one(withGaps('m', gaps)).matchScoreBp
      expect(s).toBeGreaterThanOrEqual(prev)
      prev = s
    }
    expect(prev).toBeGreaterThan(0)
  })

  it('does not call a pattern monthly when fewer than two thirds of the gaps are monthly', () => {
    // two bills on days 1 and 8: gaps 7,23,7,23,7 -> median 7 but only 3 of 5 gaps in the weekly band
    const d = one(withGaps('m', [7, 23, 7, 23, 7]))
    expect(d.frequency).toBe('irregular')
    expect(d.expectedNextDate).toBeNull()
    expect(d.matchScoreBp).toBe(0)
  })

  it('needs gaps * 2 <= gapsInBand * 3: 2 of 3 passes, 3 of 5 fails, 4 of 6 passes', () => {
    expect(one(withGaps('m', [30, 30, 60])).frequency).toBe('monthly')
    expect(one(withGaps('m', [30, 30, 30, 60, 60])).frequency).toBe('irregular')
    expect(one(withGaps('m', [30, 30, 30, 30, 60, 60])).frequency).toBe('monthly')
  })

  it('calls three payments on one day irregular, with no date and a zero score', () => {
    const d = one(series('m', 0, 3))
    expect(d.frequency).toBe('irregular')
    expect(d.expectedNextDate).toBeNull()
    expect(d.matchScoreBp).toBe(0)
  })

  it('scores an integer from 0 to 10000 basis points', () => {
    for (const rows of [series('m', 30, 3), series('m', 7, 40), withGaps('m', [5, 400, 1, 90])]) {
      const s = one(rows).matchScoreBp
      expect(Number.isInteger(s)).toBe(true)
      expect(s).toBeGreaterThanOrEqual(0)
      expect(s).toBeLessThanOrEqual(10000)
    }
  })

  it('gives the same answer for the same rows in any order', () => {
    const rows = [
      ...series('a', 30, 4, -1000), ...series('a', 30, 3, -5000), ...series('b', 7, 5, -250),
      row('a', '2026-05-01', -1040),
    ]
    const forward = detectRecurring(rows)
    expect(forward.length).toBeGreaterThan(1)
    expect(detectRecurring([...rows].reverse())).toEqual(forward)
    const shuffled = rows.map((r, i) => ({ r, k: (i * 7) % rows.length })).sort((x, y) => x.k - y.k).map((x) => x.r)
    expect(detectRecurring(shuffled)).toEqual(forward)
  })

  it('does not modify its input', () => {
    const rows = series('m', 30, 4).reverse()
    const copy = rows.map((r) => ({ ...r }))
    detectRecurring(rows)
    expect(rows).toEqual(copy)
  })
})

describe('frequency band edges (median gap in days)', () => {
  // 3 payments with both gaps = g have median gap g; expected next is last + g.
  const cases: [number, Frequency][] = [
    [4, 'irregular'], [5, 'weekly'], [9, 'weekly'], [10, 'irregular'],
    [25, 'irregular'], [26, 'monthly'], [35, 'monthly'], [36, 'irregular'],
    [79, 'irregular'], [80, 'quarterly'], [100, 'quarterly'], [101, 'irregular'],
    [349, 'irregular'], [350, 'annual'], [380, 'annual'], [381, 'irregular'],
  ]
  for (const [gap, freq] of cases) {
    it(`a ${gap}-day gap is ${freq}`, () => {
      const d = one(series('m', gap, 3))
      expect(d.frequency).toBe(freq)
      const last = addDays('2026-01-01', gap * 2)
      expect(d.lastSeenDate).toBe(last)
      expect(d.expectedNextDate).toBe(freq === 'irregular' ? null : addDays(last, gap))
    })
  }

  it('takes the median gap, not the mean: one long outlier does not make a monthly payment irregular', () => {
    // gaps 30, 30, 30, 200: mean 72, median 30
    expect(one(withGaps('m', [30, 30, 30, 200])).frequency).toBe('monthly')
  })

  it('expects the next payment at the last seen date plus the median gap', () => {
    // 5 Jan + 3 weeks = 26 Jan; next = 26 Jan + 7 = 2 Feb
    const d = one(series('m', 7, 4, -1000, '2026-01-05'))
    expect(d.lastSeenDate).toBe('2026-01-26')
    expect(d.expectedNextDate).toBe('2026-02-02')
  })
})

describe('amount clustering edges', () => {
  // an amount joins a cluster when within max(100 cents, 5% of the cluster median), integer arithmetic
  const joined = (base: number, other: number) => {
    // The fourth payment falls 45 days after the third, outside every cadence band, so it can only be counted by JOINING the
    // cluster: chaining as a price change is ruled out, and 4 occurrences means the amount was inside the tolerance.
    const r = detectRecurring([...series('m', 30, 3, -base), row('m', addDays('2026-01-01', 105), -other)])
    return r.length === 1 && r[0]?.occurrences === 4 && r[0]?.amountChanged === null
  }

  it('joins an amount exactly 100 cents from a 10,00 payment, not 101', () => {
    expect(joined(1000, 1100)).toBe(true)
    expect(joined(1000, 1101)).toBe(false)
    expect(joined(1000, 900)).toBe(true)
    expect(joined(1000, 899)).toBe(false)
  })

  it('uses 5% of the median once that exceeds 100 cents: 40,00 allows 200', () => {
    expect(joined(4000, 4200)).toBe(true)
    expect(joined(4000, 4201)).toBe(false)
  })

  it('reports the tolerance used for the cluster', () => {
    expect(one(series('m', 30, 3, -1000)).toleranceCents).toBe(100)
    expect(one(series('m', 30, 3, -4000)).toleranceCents).toBe(200)
  })

  it('a clearly different amount is a separate payment, so a 3-series plus one odd payment stays 3', () => {
    const r = detectRecurring([...series('m', 30, 3, -1000), row('m', '2026-04-10', -9000)])
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ occurrences: 3, amountCents: 1000 })
  })

  describe('a price change is one payment, not a stopped one and a new one', () => {
    it('chains a 30% rise into one series: the amount is the new one and the change is reported', () => {
      // Four payments at 9,99, then two at 12,99, all 30 days apart.
      const rows = [...series('m', 30, 4, -999), ...series('m', 30, 2, -1299, '2026-05-01')]
      const r = detectRecurring(rows)
      expect(r).toHaveLength(1)
      expect(r[0]).toMatchObject({
        occurrences: 6, frequency: 'monthly', amountCents: 1299, amountChanged: { fromCents: 999, toCents: 1299 }, lastSeenDate: '2026-05-31',
      })
    })

    it('does not read a one-off purchase that lands on the cadence as a price rise', () => {
      // 9,99 a month, then one 55,00 order exactly where the next payment would fall.
      const r = detectRecurring([...series('m', 30, 4, -999), row('m', '2026-05-01', -5500)])
      expect(r).toHaveLength(1)
      expect(r[0]).toMatchObject({ occurrences: 4, amountCents: 999, amountChanged: null, lastSeenDate: '2026-04-01' })
    })

    it('a single payment chains up to 50% from the old price and not past it, in either direction', () => {
      const at = (x: number) => detectRecurring([...series('m', 30, 3, -1000), row('m', '2026-04-01', -x)])[0]?.occurrences
      expect(at(1500)).toBe(4)
      expect(at(1501)).toBe(3)
      expect(at(500)).toBe(4)
      expect(at(499)).toBe(3)
    })

    it('two payments at a far higher price are a run of their own and do chain', () => {
      const r = detectRecurring([...series('m', 30, 3, -999), ...series('m', 30, 2, -5500, '2026-04-01')])
      expect(r).toHaveLength(1)
      expect(r[0]).toMatchObject({ occurrences: 5, amountCents: 5500, amountChanged: { fromCents: 999, toCents: 5500 } })
    })

    it('one payment at a new price is enough when the new price is a plausible change of the old one', () => {
      const rows = [...series('m', 30, 3, -999), row('m', '2026-04-01', -1299)]
      const r = detectRecurring(rows)
      expect(r).toHaveLength(1)
      expect(r[0]).toMatchObject({ occurrences: 4, amountCents: 1299, amountChanged: { fromCents: 999, toCents: 1299 } })
    })

    it('keeps two subscriptions that run at the same time at one merchant separate', () => {
      const rows = [...series('m', 30, 4, -999), ...series('m', 30, 4, -1299, '2026-01-10')]
      const r = detectRecurring(rows)
      expect(r.map((d) => d.amountCents)).toEqual([999, 1299])
      expect(r.every((d) => d.occurrences === 4 && d.amountChanged === null)).toBe(true)
    })

    it('does not chain when the first payment at the new price is not where the cadence puts it', () => {
      const rows = [...series('m', 30, 3, -999), row('m', '2026-06-01', -1299)]
      const r = detectRecurring(rows)
      expect(r).toHaveLength(1)
      expect(r[0]).toMatchObject({ occurrences: 3, amountCents: 999 })
    })

    it('chains a rise followed by a real stop, and the last payment is the true last one', () => {
      const rows = [...series('m', 30, 3, -999), ...series('m', 30, 2, -1299, '2026-04-01')]
      const r = detectRecurring(rows)
      expect(r).toHaveLength(1)
      expect(r[0]).toMatchObject({ occurrences: 5, lastSeenDate: '2026-05-01', amountCents: 1299, expectedNextDate: '2026-05-31' })
    })

    it('reports the latest amount as the amount after a sustained change within one cluster', () => {
      const r = one([...series('m', 30, 4, -1000), row('m', '2026-05-01', -1090), row('m', '2026-05-31', -1090)])
      expect(r).toMatchObject({ amountCents: 1090, amountChanged: { fromCents: 1000, toCents: 1090 } })
    })
  })
})
