import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../db/db'
import { seedDatabase } from '../db/seed'
import type { TransactionRow } from '../db/schema'
import type { MonthSummary } from './monthly'
import { changeFrom, monthSeries, oldestFirst } from './series'

let uid = 0
const GROCERIES: [string, string] = ['Alimentación', 'Supermercados y alimentación']
const TODAY = '2027-03-05'

const tx = async (id: string, valueDate: string, amountCents: number, ing: [string, string] | null = null): Promise<void> => {
  await db.transactions.add({
    id, accountId: 'acc.1', valueDate, amountCents, balanceCents: 0, description: 'Movimiento inventado', comment: null,
    ingCategory: ing?.[0] ?? null, ingSubcategory: ing?.[1] ?? null, kind: amountCents > 0 ? 'income' : 'spend',
    dedupKey: `k.${++uid}`, importId: 'imp.1', fileSeq: uid, roundupParentId: null, createdAt: 1, deletedAt: null,
  })
}

const series = (from: string, to: string) => monthSeries(from, to, TODAY, 1000)

const summaryOf = (over: Partial<MonthSummary>): MonthSummary => ({
  month: '2026-11', incomeCents: 0, spentCents: 0, savedCents: 0, essentialCents: 0, discretionaryCents: 0, uncategorisedCents: 0,
  netCents: 0, provisional: false, incomeBasis: 'actual', transactions: 1, ...over,
})

beforeEach(async () => {
  uid = 0
  await db.delete(); await db.open(); await seedDatabase()
})

describe('monthSeries', () => {
  it('returns every month in the range, including one with no data, marked hasData false', async () => {
    await tx('a', '2026-10-03', -1000, GROCERIES)
    await tx('c', '2026-12-03', -3000, GROCERIES)
    const s = await series('2026-10', '2026-12')
    expect(s.map((p) => p.month)).toEqual(['2026-10', '2026-11', '2026-12'])
    expect(s.map((p) => p.hasData)).toEqual([true, false, true])
    expect(s.map((p) => p.transactions)).toEqual([1, 0, 1])
  })

  it('never interpolates a missing month: a gap is distinguishable from a month that really spent zero', async () => {
    // Oct 1000 spent, Nov NO rows at all, Dec 3000 spent, Jan: income only, spent genuinely zero.
    await tx('a', '2026-10-03', -1000, GROCERIES)
    await tx('c', '2026-12-03', -3000, GROCERIES)
    await tx('pay', '2027-01-02', 100000)
    const [oct, nov, dec, jan] = await series('2026-10', '2027-01')
    expect(nov).toMatchObject({ hasData: false, spentCents: 0, incomeCents: 0, incomeBasis: 'none' })
    expect(nov?.spentCents).not.toBe(2000) // the average of its neighbours
    // The real zero is a measured month, and says so.
    expect(jan).toMatchObject({ hasData: true, spentCents: 0, incomeCents: 100000, incomeBasis: 'actual' })
    expect(oct?.hasData).toBe(true)
    expect(dec?.spentCents).toBe(3000)
  })

  it('does not invent an income estimate for a month with no data', async () => {
    await tx('pay', '2026-10-01', 100000)
    await tx('food', '2026-10-03', -1000, GROCERIES)
    const [, nov] = await series('2026-10', '2026-11')
    expect(nov).toMatchObject({ hasData: false, incomeCents: 0, netCents: 0, incomeBasis: 'none', provisional: true })
  })

  it('orders oldest first across a year boundary, however the data was written', async () => {
    await tx('late', '2027-02-03', -1000, GROCERIES)
    await tx('early', '2026-11-03', -1000, GROCERIES)
    await tx('mid', '2026-12-03', -1000, GROCERIES)
    const s = await series('2026-11', '2027-02')
    expect(s.map((p) => p.month)).toEqual(['2026-11', '2026-12', '2027-01', '2027-02'])
    expect(s.map((p) => p.month)).toEqual([...s.map((p) => p.month)].sort())
  })

  it('oldestFirst orders by month whatever order the points arrive in', () => {
    const arrived = [{ month: '2027-01' }, { month: '2026-11' }, { month: '2027-02' }, { month: '2026-12' }]
    const ordered = oldestFirst(arrived).map((p) => p.month)
    expect(ordered).toEqual(['2026-11', '2026-12', '2027-01', '2027-02'])
    expect(oldestFirst([...arrived].reverse()).map((p) => p.month)).toEqual(ordered)
    expect(arrived[0]?.month).toBe('2027-01') // the input is not reordered in place
  })

  it('is a single point when from equals to, and empty when the range is inverted', async () => {
    await tx('a', '2026-10-03', -1000, GROCERIES)
    expect((await series('2026-10', '2026-10')).map((p) => p.month)).toEqual(['2026-10'])
    expect(await series('2026-12', '2026-10')).toEqual([])
  })

  it('refuses a malformed month rather than guessing', async () => {
    await expect(series('2026-13', '2026-14')).rejects.toThrow()
    await expect(series('2026-1', '2026-12')).rejects.toThrow()
  })
})

describe('changeFrom', () => {
  it('reports a change in cents always, and in basis points only when there is a basis', () => {
    const prev = summaryOf({ month: '2026-10', spentCents: 20000 })
    const cur = summaryOf({ spentCents: 25000 })
    expect(changeFrom(prev, cur, 'spentCents')).toEqual({ cents: 5000, bp: 2500, basis: 'month' })
    expect(changeFrom(summaryOf({ spentCents: 25000 }), summaryOf({ spentCents: 20000 }), 'spentCents')).toEqual({ cents: -5000, bp: -2000, basis: 'month' })
    // Previous month had data but spent zero: the cents are real, a percentage of nothing is not.
    expect(changeFrom(summaryOf({ spentCents: 0 }), cur, 'spentCents')).toEqual({ cents: 25000, bp: null, basis: 'month' })
  })

  it('rounds basis points half away from zero, and measures against the previous magnitude', () => {
    expect(changeFrom(summaryOf({ spentCents: 3 }), summaryOf({ spentCents: 4 }), 'spentCents').bp).toBe(3333)
    expect(changeFrom(summaryOf({ spentCents: 8 }), summaryOf({ spentCents: 9 }), 'spentCents').bp).toBe(1250)
    expect(changeFrom(summaryOf({ spentCents: 8 }), summaryOf({ spentCents: 7 }), 'spentCents').bp).toBe(-1250)
    expect(changeFrom(summaryOf({ spentCents: 32 }), summaryOf({ spentCents: 33 }), 'spentCents').bp).toBe(313) // 312.5
    expect(changeFrom(summaryOf({ spentCents: 32 }), summaryOf({ spentCents: 31 }), 'spentCents').bp).toBe(-313)
    // A loss shrinking from -200 to -100 is an improvement, not a fall.
    expect(changeFrom(summaryOf({ netCents: -200 }), summaryOf({ netCents: -100 }), 'netCents')).toEqual({ cents: 100, bp: 5000, basis: 'month' })
  })

  it('reports no basis for the first month rather than a 100% rise', () => {
    const first = changeFrom(null, summaryOf({ spentCents: 25000 }), 'spentCents')
    expect(first.basis).toBe('none')
    expect(first.bp).toBeNull()
    expect(first.cents).toBeNull() // no change to report, not "the whole figure"
    // Nor does a previous month that is a gap count as a month of zero to compare against.
    const afterGap = changeFrom(summaryOf({ transactions: 0, spentCents: 0 }), summaryOf({ spentCents: 25000 }), 'spentCents')
    expect(afterGap).toEqual({ basis: 'none', bp: null, cents: null })
  })
})
