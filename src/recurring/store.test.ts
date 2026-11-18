import { describe, it, expect, beforeEach, vi } from 'vitest'
import { db } from '../db/db'
import { seedDatabase } from '../db/seed'
import type { AnnotationRow, TransactionRow } from '../db/schema'
import { addDays } from '../lib/dates'
import { confirmRecurring, dismissRecurring, markCancelled, monthlyCostOf, recurringPayments, recurringWindow } from './store'

const TODAY = '2026-11-18'
let n = 0
const tx = (valueDate: string, amountCents: number, over: Partial<TransactionRow> = {}): TransactionRow => ({
  id: `t${++n}`, accountId: 'acc', valueDate, amountCents, balanceCents: 50000, description: 'X', comment: null,
  ingCategory: null, ingSubcategory: null, kind: 'spend', dedupKey: `K${n}`, importId: 'imp', fileSeq: n, roundupParentId: null,
  createdAt: 1, deletedAt: null, ...over,
})
const ann = (transactionId: string, merchantId: string | null): AnnotationRow => ({
  transactionId, categoryId: null, subcategoryId: null, merchantId, typeOverride: null, paymentMethod: null,
  note: null, moodId: null, purchaseReasonId: null, worthwhile: null, reviewed: false, dateOverride: null,
  amountCentsOverride: null, descriptionOverride: null, updatedAt: 1,
})
/** Monthly payments to a merchant on the 5th, one per given month, each with its own amount (cents out). */
async function monthly(merchantId: string, months: string[], amounts: number | number[]): Promise<void> {
  const rows = months.map((m, i) => tx(`${m}-05`, -(Array.isArray(amounts) ? (amounts[i] ?? 0) : amounts)))
  await db.transactions.bulkAdd(rows)
  await db.annotations.bulkAdd(rows.map(r => ann(r.id, merchantId)))
}
const M6 = ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08']

beforeEach(async () => { await db.delete(); await db.open(); await seedDatabase(); n = 0 })

describe('recurring store', () => {
  it('keeps a stable id for a payment when its amount changes', async () => {
    await monthly('m.netflix', M6.slice(0, 4), 1299)
    const before = await recurringPayments(TODAY, 1)
    expect(before).toHaveLength(1)
    await monthly('m.netflix', ['2026-07', '2026-08', '2026-09', '2026-10', '2026-06', '2026-05'], 1390)   // a rise within tolerance that moves the median
    const after = await recurringPayments(TODAY, 2)
    expect(after).toHaveLength(1)
    expect(after[0]?.amountCents).not.toBe(before[0]?.amountCents)
    expect(after[0]?.id).toBe(before[0]?.id)
    expect(await db.recurring.count()).toBe(1)
  })

  it('gives two distinct payments at one merchant two ids', async () => {
    await monthly('m.apple', M6, 999)
    await monthly('m.apple', M6, 5499)
    const ids = (await recurringPayments(TODAY, 1)).map(v => v.id)
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
  })

  it('keeps a payment the owner dismissed dismissed after re-detection', async () => {
    await monthly('m.gym', M6, 3000)
    const [v] = await recurringPayments(TODAY, 1)
    await dismissRecurring(v!.id)
    expect(await recurringPayments(TODAY, 2)).toEqual([])
    expect((await db.recurring.get(v!.id))?.dismissed).toBe(true)
    expect((await db.recurring.get(v!.id))?.cancelled).toBe(false)
  })

  it('shows a confirmed payment even when its score has fallen', async () => {
    // Gaps of 30, 30, 8, 52 days: a low score, so an unconfirmed one is not shown.
    const dates = ['2026-01-01', '2026-01-31', '2026-03-02', '2026-03-10', '2026-05-01']
    const rows = dates.map(d => tx(d, -1000))
    await db.transactions.bulkAdd(rows)
    await db.annotations.bulkAdd(rows.map(r => ann(r.id, 'm.odd')))
    expect(await recurringPayments(TODAY, 1)).toEqual([])
    const id = (await db.recurring.toArray())[0]?.id
    expect(id).toBeTruthy()
    await confirmRecurring(id!)
    const shown = await recurringPayments(TODAY, 2)
    expect(shown).toHaveLength(1)
    expect(shown[0]).toMatchObject({ confirmedByUser: true })
    expect(shown[0]!.matchScoreBp).toBeLessThan(3000)
  })

  it('shows a cancelled payment, flagged, and cancelling is not dismissing', async () => {
    await monthly('m.gym', M6, 3000)
    const [v] = await recurringPayments(TODAY, 1)
    await markCancelled(v!.id)
    const [again] = await recurringPayments(TODAY, 2)
    expect(again).toMatchObject({ id: v!.id, cancelled: true })
    expect((await db.recurring.get(v!.id))?.dismissed).toBeUndefined()
  })

  it('refuses a correction for a payment that was never detected', async () => {
    await expect(confirmRecurring('nope')).rejects.toThrow()
  })

  it('normalises every frequency to a monthly cost without a float', () => {
    expect(monthlyCostOf('weekly', 1000)).toBe(4333)     // 52000 / 12 = 4333.33
    expect(monthlyCostOf('weekly', 1001)).toBe(4338)     // 52052 / 12 = 4337.67
    expect(monthlyCostOf('monthly', 1299)).toBe(1299)
    expect(monthlyCostOf('quarterly', 3000)).toBe(1000)
    expect(monthlyCostOf('quarterly', 1000)).toBe(333)
    expect(monthlyCostOf('annual', 5999)).toBe(500)      // 499.92
    expect(monthlyCostOf('irregular', 1000)).toBeNull()
  })

  it('works out the window as the last 14 completed months before the month of today', () => {
    expect(recurringWindow('2026-11-18')).toEqual({ first: '2025-09', last: '2026-10' })
    expect(recurringWindow('2026-01-01')).toEqual({ first: '2024-11', last: '2025-12' })
  })

  it('reads a bounded window by the bank dates, never the whole ledger', async () => {
    // Inside the window: 4 monthly payments. Outside: older than 14 months and in the current month.
    await monthly('m.in', M6.slice(0, 4), 1000)
    const outside = [tx('2025-06-05', -1000), tx('2025-07-05', -1000), tx('2025-08-05', -1000), tx('2026-11-05', -1000)]
    await db.transactions.bulkAdd(outside)
    await db.annotations.bulkAdd(outside.map(r => ann(r.id, 'm.out')))
    const all = vi.spyOn(db.transactions, 'toArray')
    const whole = vi.spyOn(db.transactions, 'toCollection')
    const shown = await recurringPayments(TODAY, 1)
    expect(all).not.toHaveBeenCalled()
    expect(whole).not.toHaveBeenCalled()
    expect(shown.map(v => v.merchantId)).toEqual(['m.in'])
  })

  it('leaves out spends with no merchant, since they cannot be clustered', async () => {
    await monthly('m.x', M6.slice(0, 4), 1000)
    const rows = M6.slice(0, 4).map(m => tx(`${m}-09`, -700))
    await db.transactions.bulkAdd(rows)   // no annotation, so no merchant
    expect((await recurringPayments(TODAY, 1)).map(v => v.merchantId)).toEqual(['m.x'])
  })

  it('marks a payment lapsed only once a whole cycle past its expected date is missed', async () => {
    // Monthly on the 5th, last seen 2026-06-05 (gaps 30/31): expected about 2026-07-05, plus 30 days = about 2026-08-04.
    await monthly('m.gym', M6.slice(0, 4), 3000)
    const [fresh] = await recurringPayments('2026-07-10', 1)
    expect(fresh).toMatchObject({ lapsed: false })
    expect(fresh?.expectedNextDate).not.toBeNull()
    const edge = fresh!.expectedNextDate!
    const boundary = addDays(edge, 30)
    const [onBoundary] = await recurringPayments(boundary, 2)
    expect(onBoundary).toMatchObject({ lapsed: false })
    const [past] = await recurringPayments(addDays(boundary, 1), 3)
    expect(past).toMatchObject({ lapsed: true, expectedNextDate: null, monthlyCostCents: null })
  })

  it('shows an irregular cluster only once the owner has confirmed it', async () => {
    const rows = ['2026-05-01', '2026-05-01', '2026-05-02'].map(d => tx(d, -1000))
    await db.transactions.bulkAdd(rows)
    await db.annotations.bulkAdd(rows.map(r => ann(r.id, 'm.burst')))
    expect(await recurringPayments(TODAY, 1)).toEqual([])
    await confirmRecurring((await db.recurring.toArray())[0]!.id)
    const [v] = await recurringPayments(TODAY, 2)
    expect(v).toMatchObject({ frequency: 'irregular', lapsed: false, monthlyCostCents: null })
  })

  it('does not call a refund or an income a payment', async () => {
    const rows = M6.slice(0, 4).map(m => tx(`${m}-05`, 1000))
    await db.transactions.bulkAdd(rows)
    await db.annotations.bulkAdd(rows.map(r => ann(r.id, 'm.pay')))
    expect(await recurringPayments(TODAY, 1)).toEqual([])
  })
})
