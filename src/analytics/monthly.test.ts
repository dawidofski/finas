import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../db/db'
import { seedDatabase } from '../db/seed'
import type { AnnotationRow, TransactionRow } from '../db/schema'
import { rebuildAnalytics } from './cache'
import { monthSummary } from './monthly'

let uid = 0
const GROCERIES: [string, string] = ['Alimentación', 'Supermercados y alimentación'] // essential
const RESTAURANTS: [string, string] = ['Ocio y viajes', 'Cafeterías y restaurantes'] // discretionary
const ROUNDUP: [string, string] = ['Ahorro', 'Redondeo'] // savings
const NOV = '2026-11'
const TODAY = '2026-12-05'

const tx = async (
  id: string, valueDate: string, amountCents: number, ing: [string, string] | null = null,
  kind: TransactionRow['kind'] = amountCents > 0 ? 'income' : 'spend',
): Promise<void> => {
  await db.transactions.add({
    id, accountId: 'acc.1', valueDate, amountCents, balanceCents: 0, description: 'Movimiento inventado', comment: null,
    ingCategory: ing?.[0] ?? null, ingSubcategory: ing?.[1] ?? null, kind, dedupKey: `k.${++uid}`, importId: 'imp.1', fileSeq: uid,
    roundupParentId: null, createdAt: 1, deletedAt: null,
  })
}

const annotate = async (transactionId: string, over: Partial<AnnotationRow>): Promise<void> => {
  await db.annotations.add({
    transactionId, categoryId: null, subcategoryId: null, merchantId: null, typeOverride: null, paymentMethod: null, note: null,
    moodId: null, purchaseReasonId: null, worthwhile: null, reviewed: false, dateOverride: null, amountCentsOverride: null,
    descriptionOverride: null, updatedAt: 1, ...over,
  })
}

const summary = (month = NOV) => monthSummary(month, TODAY, 1000)

beforeEach(async () => {
  uid = 0
  await db.delete(); await db.open(); await seedDatabase()
})

describe('monthSummary', () => {
  it('reports income, spending, savings and the split, all from the bank amounts', async () => {
    await tx('pay', '2026-11-01', 200000)
    await tx('food', '2026-11-03', -3000, GROCERIES)
    await tx('cafe', '2026-11-04', -2000, RESTAURANTS)
    await tx('round', '2026-11-05', -500, ROUNDUP, 'roundup')
    expect(await summary()).toEqual({
      month: NOV, incomeCents: 200000, spentCents: 5000, savedCents: 500, essentialCents: 3000, discretionaryCents: 2000,
      uncategorisedCents: 0, netCents: 200000 - 5000 - 500, provisional: false, incomeBasis: 'actual', transactions: 4,
    })
  })

  it('marks a month provisional when its income is an estimate, and says so on a zero', async () => {
    // Estimate from earlier months: spending in November, income only in October.
    await tx('oct-pay', '2026-10-01', 100000)
    await tx('food', '2026-11-03', -3000, GROCERIES)
    const estimated = await summary()
    expect(estimated).toMatchObject({ incomeCents: 100000, provisional: true, incomeBasis: 'trailing-average', netCents: 100000 - 3000 })

    // Nothing known at all: the zero is "no income known", not "earned nothing", and the summary says so.
    await db.transactions.delete('oct-pay')
    const unknown = await summary()
    expect(unknown).toMatchObject({ incomeCents: 0, provisional: true, incomeBasis: 'none' })

    // A real observation of the month is never provisional.
    await tx('pay', '2026-11-01', 150000)
    expect(await summary()).toMatchObject({ incomeCents: 150000, provisional: false, incomeBasis: 'actual' })
  })

  it('counts uncategorised spending separately rather than folding it into discretionary', async () => {
    await tx('pay', '2026-11-01', 200000)
    await tx('food', '2026-11-03', -3000, GROCERIES)
    await tx('mystery', '2026-11-04', -700) // no ING category, no annotation
    const s = await summary()
    expect(s).toMatchObject({ essentialCents: 3000, discretionaryCents: 0, uncategorisedCents: 700, spentCents: 3700 })
  })

  it('returns a real zero for a month with no transactions, distinguishable from no such month', async () => {
    // A month that has data but no spending or saving: the zeros are measured.
    await tx('pay', '2026-11-01', 200000)
    const measured = await summary()
    expect(measured).toMatchObject({
      spentCents: 0, savedCents: 0, essentialCents: 0, discretionaryCents: 0, uncategorisedCents: 0, netCents: 200000,
      transactions: 1, provisional: false, incomeBasis: 'actual',
    })
    // A month with no data at all: the same zeros, but flagged as nothing known and with no transactions behind them.
    const empty = await summary('2026-09')
    expect(empty).toEqual({
      month: '2026-09', incomeCents: 0, spentCents: 0, savedCents: 0, essentialCents: 0, discretionaryCents: 0,
      uncategorisedCents: 0, netCents: 0, provisional: true, incomeBasis: 'none', transactions: 0,
    })
    expect(empty.transactions).not.toBe(measured.transactions)
    expect(empty.incomeBasis).not.toBe(measured.incomeBasis)
  })

  it('sums to the total: essential + discretionary + uncategorised equals spentCents', async () => {
    await tx('pay', '2026-11-01', 200000)
    await tx('food', '2026-11-03', -3333, GROCERIES)
    await tx('cafe', '2026-11-04', -2222, RESTAURANTS)
    await tx('mystery', '2026-11-05', -1111)
    // A spend filed under a parent category, which groups and classifies nothing: it must still land in the sum.
    await tx('parent', '2026-11-06', -444)
    await annotate('parent', { categoryId: 'cat.group.compras' })
    const s = await summary()
    expect(s.essentialCents).toBe(3333)
    expect(s.discretionaryCents).toBe(2222)
    expect(s.uncategorisedCents).toBe(1111 + 444)
    expect(s.spentCents).toBe(3333 + 2222 + 1111 + 444)
    expect(s.essentialCents + s.discretionaryCents + s.uncategorisedCents).toBe(s.spentCents)
  })

  it('does not change when the owner corrects an amount or a date (§41)', async () => {
    await tx('pay', '2026-11-01', 200000)
    await tx('food', '2026-11-10', -3000, GROCERIES)
    await tx('cafe', '2026-12-03', -4000, RESTAURANTS) // December by the bank
    const before = await summary()
    expect(before).toMatchObject({ spentCents: 3000, essentialCents: 3000, discretionaryCents: 0, transactions: 2 })

    // Both overrides on one row, so neither rule alone can carry the result: the owner says 99.99 and December.
    await annotate('food', { amountCentsOverride: -9999, dateOverride: '2026-12-02' })
    // And the other direction: the owner dates a December purchase in November.
    await annotate('cafe', { dateOverride: '2026-11-05' })
    await rebuildAnalytics() // the next read is a real computation, not a stored figure
    expect(await summary()).toEqual(before)
    // December is where the bank put the cafe, and it gained nothing from the owner's dates either.
    expect(await summary('2026-12')).toMatchObject({ spentCents: 4000, discretionaryCents: 4000, essentialCents: 0 })
  })

  it('stores the figure with the supplied computedAt and recomputes when the data moves', async () => {
    await tx('pay', '2026-11-01', 200000)
    await monthSummary(NOV, TODAY, 4242)
    expect(await db.analyticsCache.toArray()).toMatchObject([{ computedAt: 4242 }])
    await tx('food', '2026-11-03', -3000, GROCERIES)
    expect(await monthSummary(NOV, TODAY, 5000)).toMatchObject({ spentCents: 3000 })
    expect(await db.analyticsCache.toArray()).toMatchObject([{ computedAt: 5000 }])
  })
})
