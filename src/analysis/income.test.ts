import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../db/db'
import { seedDatabase } from '../db/seed'
import type { AnnotationRow, TransactionRow, TransferRow } from '../db/schema'
import { monthlyBudget } from '../budget/month'
import { excludedTransactionIds, incomeBasisFor, netIncome } from './income'

let uid = 0

const tx = async (
  id: string, accountId: string, valueDate: string, amountCents: number,
  kind: TransactionRow['kind'] = amountCents > 0 ? 'income' : 'spend', deletedAt: number | null = null,
): Promise<void> => {
  await db.transactions.add({
    id, accountId, valueDate, amountCents, balanceCents: 0, description: 'Movimiento inventado', comment: null,
    ingCategory: 'Otros', ingSubcategory: 'Otros', kind, dedupKey: `k.${++uid}`, importId: 'imp.1', fileSeq: uid,
    roundupParentId: null, createdAt: 1, deletedAt,
  })
}

const link = async (id: string, out: string, inn: string, amountCents: number, linkKind?: TransferRow['linkKind']): Promise<void> => {
  await db.transfers.add({
    id, outTransactionId: out, inTransactionId: inn, amountCents, matchScore: 100, confirmedByUser: true, matchedAt: 1,
    ...(linkKind ? { linkKind } : {}),
  })
}

const annotate = async (transactionId: string, over: Partial<AnnotationRow>): Promise<void> => {
  await db.annotations.add({
    transactionId, categoryId: null, subcategoryId: null, merchantId: null, typeOverride: null, paymentMethod: null,
    note: null, moodId: null, purchaseReasonId: null, worthwhile: null, reviewed: false, dateOverride: null,
    amountCentsOverride: null, descriptionOverride: null, updatedAt: 1, ...over,
  })
}

beforeEach(async () => {
  uid = 0
  await db.delete(); await db.open(); await seedDatabase()
})

describe('netIncome', () => {
  it('sums income rows for the month across every account', async () => {
    await tx('a', 'acc.1', '2026-11-03', 150000)
    await tx('b', 'acc.2', '2026-11-20', 25050)
    await tx('c', 'acc.1', '2026-12-01', 99900) // next month
    await tx('d', 'acc.1', '2026-11-05', -4000) // spend
    expect(await netIncome('2026-11')).toEqual({ cents: 175050, provisional: false, basis: 'actual', monthsAveraged: 0 })
    expect(await incomeBasisFor('2026-11')).toBe(175050)
  })

  it('excludes both legs of a matched transfer, however large', async () => {
    await tx('pay', 'acc.1', '2026-11-01', 100000)
    await tx('out', 'acc.1', '2026-11-10', -250000, 'internal') // larger than the month's whole income
    await tx('in', 'acc.2', '2026-11-10', 250000, 'income')
    await link('t1', 'out', 'in', 250000)
    expect((await netIncome('2026-11')).cents).toBe(100000)
    expect(await excludedTransactionIds('2026-11')).toEqual(new Set(['out', 'in']))
  })

  it('excludes a transfer pair whose legs fall in different months', async () => {
    await tx('pay-n', 'acc.1', '2026-11-01', 100000)
    await tx('pay-d', 'acc.1', '2026-12-01', 100000)
    await tx('out', 'acc.1', '2026-11-30', -50000, 'internal')
    await tx('in', 'acc.2', '2026-12-02', 50000, 'income')
    await link('t1', 'out', 'in', 50000)
    expect((await netIncome('2026-12')).cents).toBe(100000) // the in-leg is not phantom December income
    expect((await netIncome('2026-11')).cents).toBe(100000)
    // each month names both legs, so neither can keep the half it holds
    expect(await excludedTransactionIds('2026-12')).toEqual(new Set(['out', 'in']))
    expect(await excludedTransactionIds('2026-11')).toEqual(new Set(['out', 'in']))
  })

  it('excludes a positive linked as a refund', async () => {
    await tx('pay', 'acc.1', '2026-11-01', 100000)
    await tx('buy', 'acc.1', '2026-10-28', -3000)
    await tx('ref', 'acc.1', '2026-11-04', 3000, 'income')
    await link('r1', 'buy', 'ref', 3000, 'refund')
    expect((await netIncome('2026-11')).cents).toBe(100000)
    const ex = await excludedTransactionIds('2026-11')
    expect(ex.has('ref')).toBe(true)
    expect(ex.has('buy')).toBe(false) // the spend stays spending; Task 3 nets it
  })

  it('counts an unconfirmed positive as income', async () => {
    await tx('pay', 'acc.1', '2026-11-01', 100000)
    await tx('maybe', 'acc.1', '2026-11-09', 4200, 'income') // no transfer row at all
    expect((await netIncome('2026-11')).cents).toBe(104200)
    expect((await excludedTransactionIds('2026-11')).size).toBe(0)
  })

  it('ignores soft-deleted rows', async () => {
    await tx('pay', 'acc.1', '2026-11-01', 100000)
    await tx('gone', 'acc.1', '2026-11-02', 77700, 'income', 5)
    expect((await netIncome('2026-11')).cents).toBe(100000)
    // a month holding only a deleted row has no data: it neither averages in nor counts as income
    await tx('ghost', 'acc.1', '2026-10-02', 5000, 'income', 5)
    expect(await netIncome('2026-12')).toEqual({ cents: 100000, provisional: true, basis: 'trailing-average', monthsAveraged: 1 })
  })

  it('falls back to the trailing three-month average when the month has no income', async () => {
    await tx('a', 'acc.1', '2026-08-01', 100000)
    await tx('b', 'acc.1', '2026-09-01', 200000)
    await tx('c', 'acc.1', '2026-10-01', 300000)
    await tx('d', 'acc.1', '2026-07-01', 900000) // outside the window
    await tx('s', 'acc.1', '2026-11-05', -1000)
    expect(await netIncome('2026-11')).toEqual({ cents: 200000, provisional: true, basis: 'trailing-average', monthsAveraged: 3 })
  })

  it('uses actual income as soon as any lands, even mid-month', async () => {
    await tx('a', 'acc.1', '2026-09-01', 500000)
    await tx('s', 'acc.1', '2026-11-05', -1000)
    expect((await netIncome('2026-11')).basis).toBe('trailing-average')
    await tx('small', 'acc.1', '2026-11-06', 1200, 'income')
    expect(await netIncome('2026-11')).toEqual({ cents: 1200, provisional: false, basis: 'actual', monthsAveraged: 0 })
  })

  it('averages only the months it has, and reports how many', async () => {
    await tx('a', 'acc.1', '2026-08-01', 100001)
    await tx('b', 'acc.1', '2026-10-01', 100000) // September has nothing at all
    expect(await netIncome('2026-11')).toEqual({ cents: 100001, provisional: true, basis: 'trailing-average', monthsAveraged: 2 })
  })

  it('counts a month with transactions but no income as a real zero', async () => {
    await tx('a', 'acc.1', '2026-08-01', 100001)
    await tx('s', 'acc.1', '2026-09-03', -500)
    await tx('b', 'acc.1', '2026-10-01', 100000)
    expect(await netIncome('2026-11')).toEqual({ cents: 66667, provisional: true, basis: 'trailing-average', monthsAveraged: 3 })
  })

  it('rounds a half cent away from zero', async () => {
    await tx('a', 'acc.1', '2026-09-01', 1)
    await tx('b', 'acc.1', '2026-10-01', 2)
    expect((await netIncome('2026-11')).cents).toBe(2) // 1.5 rounds up
  })

  it('crosses a year boundary when looking back', async () => {
    await tx('a', 'acc.1', '2025-12-10', 80000)
    await tx('s', 'acc.1', '2026-02-05', -1000)
    expect(await netIncome('2026-02')).toEqual({ cents: 80000, provisional: true, basis: 'trailing-average', monthsAveraged: 1 })
  })

  it('reports basis none when there is no income anywhere', async () => {
    expect(await netIncome('2026-11')).toEqual({ cents: 0, provisional: true, basis: 'none', monthsAveraged: 0 })
    await tx('s', 'acc.1', '2026-10-05', -1000)
    expect(await netIncome('2026-11')).toEqual({ cents: 0, provisional: true, basis: 'none', monthsAveraged: 0 })
    expect(await incomeBasisFor('2026-11')).toBe(0)
  })

  it('keeps provisional === (basis !== actual) for every basis', async () => {
    expect(await netIncome('2026-11')).toMatchObject({ basis: 'none', provisional: true })
    await tx('a', 'acc.1', '2026-10-01', 100000)
    expect(await netIncome('2026-11')).toMatchObject({ basis: 'trailing-average', provisional: true })
    await tx('b', 'acc.1', '2026-11-01', 100000)
    expect(await netIncome('2026-11')).toMatchObject({ basis: 'actual', provisional: false })
    for (const m of ['2026-08', '2026-09', '2026-10', '2026-11', '2026-12']) {
      const r = await netIncome(m)
      expect(r.provisional).toBe(r.basis !== 'actual')
    }
  })

  it('rejects a malformed month', async () => {
    await expect(netIncome('2026-13')).rejects.toThrow()
    await expect(excludedTransactionIds('nov')).rejects.toThrow()
  })
})

/**
 * §43, ruled in Plan 4: `kind` is the owner's classification, so the income sum honours a `typeOverride` — and the
 * budget honours the same value through the same `treatmentOf`, which is the condition that makes it safe. Every test
 * here checks BOTH figures, because a euro leaving one without arriving in the other is the defect this rule risks.
 */
describe("netIncome and the owner's kind correction (§43)", () => {
  const budget = () => monthlyBudget('2026-11', '2026-12-05')

  it('a positive re-kinded to internal leaves income without appearing as spending', async () => {
    await tx('pay', 'acc.1', '2026-11-01', 200000)
    await tx('moved', 'acc.1', '2026-11-09', 4200, 'income')
    expect((await netIncome('2026-11')).cents).toBe(204200)
    await annotate('moved', { typeOverride: 'internal' })
    expect((await netIncome('2026-11')).cents).toBe(200000)
    const b = await budget()
    expect(b.income.cents).toBe(200000) // the budget's income says the same thing as netIncome, as it must
    expect(b.totals).toMatchObject({ spentCents: 0, savingsCents: 0 }) // and it is in no other figure
    expect(b.lines.reduce((n, l) => n + l.spentCents, 0)).toBe(0)
  })

  it("counts an arrival the owner re-kinded to income, in the bank's month", async () => {
    await tx('odd', 'acc.1', '2026-11-09', 4200, 'internal') // the bank called it a movement; the owner says earnings
    expect(await netIncome('2026-11')).toMatchObject({ cents: 0, basis: 'none' })
    await annotate('odd', { typeOverride: 'income', dateOverride: '2026-12-02' })
    expect(await netIncome('2026-11')).toEqual({ cents: 4200, provisional: false, basis: 'actual', monthsAveraged: 0 })
    expect(await netIncome('2026-12')).toMatchObject({ cents: 4200, basis: 'trailing-average' }) // averaged, not moved
    expect((await budget()).income.cents).toBe(4200)
  })

  it('never lets a kind correction put money that left the account into income', async () => {
    await tx('pay', 'acc.1', '2026-11-01', 200000)
    await tx('out', 'acc.1', '2026-11-05', -5000)
    expect((await budget()).totals.spentCents).toBe(5000)
    await annotate('out', { typeOverride: 'income' })
    // The classification is honoured where it can be — the money is no longer spending — but the SIGN is the bank's
    // (§41), so a row that took money out of the account can never be added to income: 200000, never 195000.
    expect((await netIncome('2026-11')).cents).toBe(200000)
    const b = await budget()
    expect(b.income.cents).toBe(200000)
    expect(b.totals).toMatchObject({ spentCents: 0, savingsCents: 0 })
  })

  it('keeps both legs of a matched transfer out of income however they are re-kinded', async () => {
    await tx('pay', 'acc.1', '2026-11-01', 100000)
    await tx('out', 'acc.1', '2026-11-10', -50000, 'internal')
    await tx('in', 'acc.2', '2026-11-10', 50000, 'internal')
    await link('t1', 'out', 'in', 50000)
    await annotate('in', { typeOverride: 'income' }) // §9.2's pairing still speaks: the transfers row is a bank fact
    expect((await netIncome('2026-11')).cents).toBe(100000)
    expect(await excludedTransactionIds('2026-11')).toEqual(new Set(['out', 'in']))
    expect((await budget()).totals).toMatchObject({ spentCents: 0, savingsCents: 0 })
  })
})
