import { describe, it, expect, beforeEach, vi } from 'vitest'
import Dexie from 'dexie'
import { db } from '../db/db'
import { seedDatabase } from '../db/seed'
import type { AnnotationRow, TransactionRow } from '../db/schema'
import { addDays } from '../lib/dates'
import { confirmRecurring, descriptionKey, dismissRecurring, hiddenRecurring, markCancelled, monthlyCostOf, payeeName, recurringPayments, recurringPreview, recurringWindow, restoreRecurring } from './store'

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
/** Payments to a merchant on the given dates, each for the same amount (cents out). */
async function pay(merchantId: string, dates: string[], amount: number): Promise<void> {
  const rows = dates.map(d => tx(d, -amount))
  await db.transactions.bulkAdd(rows)
  await db.annotations.bulkAdd(rows.map(r => ann(r.id, merchantId)))
}
const every = (start: string, gap: number, count: number): string[] => Array.from({ length: count }, (_, i) => addDays(start, i * gap))
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

  it('works out the window as the last 14 completed months plus the running month', () => {
    expect(recurringWindow('2026-11-18')).toEqual({ first: '2025-09', last: '2026-11' })
    expect(recurringWindow('2026-01-01')).toEqual({ first: '2024-11', last: '2026-01' })
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

  it('groups spends with no merchant by the bank description, with the changing numbers left out', async () => {
    await monthly('m.x', M6.slice(0, 4), 1000)
    const refs = ['A1001', 'B2002', 'C3003', 'D4004']
    const rows = M6.slice(0, 4).map((m, i) => tx(`${m}-09`, -700, { description: `Pago en Televisión Ejemplo* ${refs[i]}` }))
    const other = M6.slice(0, 4).map((m, i) => tx(`${m}-12`, -700, { description: `Pago en OTRA TIENDA ${refs[i]}` }))
    await db.transactions.bulkAdd([...rows, ...other])   // no annotation, so no merchant
    const found = await recurringPayments(TODAY, 1)
    expect(found.map(v => v.merchantId).sort()).toEqual(['desc:PAGO EN OTRA TIENDA', 'desc:PAGO EN TELEVISION EJEMPLO*', 'm.x'])
    expect(found.every(v => v.occurrences === 4)).toBe(true)
    expect(payeeName('desc:PAGO EN OTRA TIENDA')).toBe('PAGO EN OTRA TIENDA')
    expect(payeeName('m.x')).toBe('m.x')
  })

  it('has nothing to group a purchase by when its description is only numbers, and leaves it out', async () => {
    expect(descriptionKey('  12345 678-9 ')).toBeNull()
    expect(descriptionKey('Recibo  GIMNASIO   ejemplo 2026/11')).toBe('desc:RECIBO GIMNASIO EJEMPLO')
    await db.transactions.bulkAdd(M6.slice(0, 4).map(m => tx(`${m}-09`, -700, { description: '000111 222' })))
    expect(await recurringPayments(TODAY, 1)).toEqual([])
  })

  it('keeps a correction on a payment grouped by description', async () => {
    await db.transactions.bulkAdd(M6.slice(0, 4).map((m, i) => tx(`${m}-09`, -1299, { description: `Pago en TELEVISION EJEMPLO ${i}9` })))
    const [first] = await recurringPayments(TODAY, 1)
    await dismissRecurring(first!.id)
    expect(await recurringPayments(TODAY, 2)).toEqual([])
    expect((await hiddenRecurring()).map(r => r.merchantId)).toEqual(['desc:PAGO EN TELEVISION EJEMPLO'])
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
  it('reads the running month, so a live weekly payment is not stopped mid-month, and is once it really has', async () => {
    await pay('m.week', every('2026-09-28', 7, 8), 800)   // ends 2026-11-16
    const [live] = await recurringPayments('2026-11-18', 1)
    expect(live).toMatchObject({ lastSeenDate: '2026-11-16', lapsed: false, expectedNextDate: '2026-11-23', overdue: false })
    const [stopped] = await recurringPayments('2026-12-31', 2)
    expect(stopped).toMatchObject({ lapsed: true, expectedNextDate: null, monthlyCostCents: null })
  })

  it('says a payment is overdue, not lapsed, between its expected date and a whole cycle later', async () => {
    await pay('m.gym', ['2026-08-05', '2026-09-04', '2026-10-04'], 3000)   // expected 2026-11-03
    const [v] = await recurringPayments('2026-11-10', 1)
    expect(v).toMatchObject({ lapsed: false, overdue: true, expectedNextDate: '2026-11-03' })
    expect(v?.monthlyCostCents).toBe(3000)
    const [early] = await recurringPayments('2026-11-03', 2)
    expect(early).toMatchObject({ overdue: false })
  })

  it('shows a price rise as one payment at the new price, with the monthly cost from the new price', async () => {
    await pay('m.stream', every('2026-05-01', 30, 4), 999)
    await pay('m.stream', every('2026-08-29', 30, 2), 1299)
    const shown = await recurringPayments('2026-10-20', 1)
    expect(shown).toHaveLength(1)
    expect(shown[0]).toMatchObject({ amountCents: 1299, monthlyCostCents: 1299, occurrences: 6, amountChanged: { fromCents: 999, toCents: 1299 }, lapsed: false })
  })

  it('keeps two subscriptions at one merchant running at once as two payments', async () => {
    await pay('m.apple', every('2026-05-01', 30, 5), 999)
    await pay('m.apple', every('2026-05-12', 30, 5), 5499)
    expect(await recurringPayments('2026-10-20', 1)).toHaveLength(2)
  })

  describe("the owner's corrections stay with their payment", () => {
    it('a cheaper subscription that appears does not inherit a cancellation', async () => {
      await pay('m.apple', every('2026-05-01', 30, 5), 5499)
      const [old] = await recurringPayments('2026-10-20', 1)
      await markCancelled(old!.id)
      await pay('m.apple', every('2026-07-10', 30, 3), 999)   // sorts BEFORE the old one by amount
      const shown = await recurringPayments('2026-10-20', 2)
      const byAmount = new Map(shown.map(v => [v.amountCents, v]))
      expect(byAmount.get(5499)).toMatchObject({ id: old!.id, cancelled: true })
      expect(byAmount.get(999)).toMatchObject({ cancelled: false })
      expect(byAmount.get(999)?.id).not.toBe(old!.id)
    })

    it('an older payment ageing out of the window does not hand its corrections to another', async () => {
      await pay('m.a', every('2025-09-20', 30, 14), 999)          // runs to 2026-10-14
      await pay('m.a', every('2026-06-01', 30, 5), 5499)
      const first = await recurringPayments('2026-10-20', 1)
      const cheap = first.find(v => v.amountCents === 999)!
      const dear = first.find(v => v.amountCents === 5499)!
      await dismissRecurring(cheap.id)
      await markCancelled(dear.id)
      // A month on, the early payments of the cheap one have left the window.
      const later = await recurringPayments('2026-11-25', 2)
      expect(later.map(v => v.id)).toEqual([dear.id])
      expect(later[0]).toMatchObject({ cancelled: true })
      expect((await db.recurring.get(cheap.id))?.dismissed).toBe(true)
    })

    it("a price change keeps the id, and the owner's confirmation with it", async () => {
      await pay('m.stream', every('2026-05-01', 30, 4), 999)
      const [before] = await recurringPayments('2026-09-10', 1)
      await confirmRecurring(before!.id)
      await pay('m.stream', every('2026-08-29', 30, 3), 1299)
      const shown = await recurringPayments('2026-11-20', 2)
      expect(shown).toHaveLength(1)
      expect(shown[0]).toMatchObject({ id: before!.id, confirmedByUser: true, amountCents: 1299 })
    })

    it('a confirmed payment whose cadence drifts keeps its confirmation', async () => {
      await pay('m.drift', every('2026-05-01', 30, 4), 2000)
      const [before] = await recurringPayments('2026-09-10', 1)
      await confirmRecurring(before!.id)
      await pay('m.drift', every('2026-08-29', 7, 6), 2000)   // now far more often
      const after = await recurringPayments('2026-10-20', 2)
      expect(after.map(v => v.id)).toContain(before!.id)
      expect(await db.recurring.count()).toBe(1)
    })

    it('matches each stored row to at most one payment', async () => {
      await pay('m.apple', every('2026-05-01', 30, 5), 999)
      await pay('m.apple', every('2026-05-01', 30, 5), 5499)   // the same dates, so both series continue from the same stored date
      const first = await recurringPayments('2026-10-20', 1)
      const again = await recurringPayments('2026-10-20', 2)
      expect(new Set(again.map(v => v.id)).size).toBe(again.length)
      expect(again.map(v => v.id).sort()).toEqual(first.map(v => v.id).sort())
    })
  })

  describe('corrections under the cases a tie or a fallback could move them', () => {
    it('two payments last paid on the same day keep their own corrections when their order by amount flips', async () => {
      const dates = every('2026-05-01', 30, 4)                 // both run to 2026-07-30
      await pay('m.apple', dates, 999)
      await pay('m.apple', dates, 2000)
      const first = await recurringPayments('2026-08-10', 1)
      const cheap = first.find(v => v.amountCents === 999)!
      const dear = first.find(v => v.amountCents === 2000)!
      await markCancelled(dear.id)
      // The cheaper one rises above the dearer one: detection now lists the 20,00 payment first.
      await pay('m.apple', ['2026-08-29'], 2000)
      await pay('m.apple', ['2026-08-29', '2026-09-28'], 2500)
      const later = await recurringPayments('2026-10-05', 2)
      expect(later.find(v => v.amountCents === 2000)).toMatchObject({ id: dear.id, cancelled: true })
      expect(later.find(v => v.amountCents === 2500)).toMatchObject({ id: cheap.id, cancelled: false })
    })

    it('a new subscription at a similar price does not inherit what was decided about an old one that ended', async () => {
      await pay('m.gym', every('2025-09-05', 30, 4), 3000)     // ends 2025-12-04
      const [old] = await recurringPayments('2026-01-10', 1)
      await dismissRecurring(old!.id)
      // Much later the old payments have left the window, and a new membership starts at nearly the same price.
      await pay('m.gym', every('2027-03-05', 30, 3), 3050)
      const shown = await recurringPayments('2027-05-20', 2)
      expect(shown).toHaveLength(1)
      expect(shown[0]!.id).not.toBe(old!.id)
      expect(shown[0]).toMatchObject({ amountCents: 3050, cancelled: false })
      expect((await db.recurring.get(old!.id))?.dismissed).toBe(true)
    })

    it('keeps a correction when a one-off read as a price change stops being one', async () => {
      await pay('m.stream', every('2026-05-01', 30, 4), 1000)  // to 2026-07-30
      await pay('m.stream', ['2026-08-29'], 1300)              // on the cadence and plausible: read as a rise
      const [before] = await recurringPayments('2026-09-05', 1)
      expect(before).toMatchObject({ amountCents: 1300 })
      await confirmRecurring(before!.id)
      // The usual 10,00 carries on: the 13,00 was a one-off after all.
      await pay('m.stream', ['2026-08-30', '2026-09-28'], 1000)
      const after = await recurringPayments('2026-10-05', 2)
      expect(after).toHaveLength(1)
      expect(after[0]).toMatchObject({ id: before!.id, confirmedByUser: true, amountCents: 1000 })
      expect(await db.recurring.count()).toBe(1)
    })
  })

  it('ignores a row dated after today', async () => {
    await pay('m.gym', [...every('2026-06-20', 30, 4), '2026-10-28'], 3000)
    const [v] = await recurringPayments('2026-10-20', 1)
    expect(v).toMatchObject({ occurrences: 4, lastSeenDate: '2026-09-18' })
  })

  it('lists the payments the owner hid and shows one again', async () => {
    await pay('m.gym', every('2026-05-01', 30, 5), 3000)
    const [v] = await recurringPayments('2026-10-20', 1)
    await dismissRecurring(v!.id)
    expect(await recurringPayments('2026-10-20', 2)).toEqual([])
    expect((await hiddenRecurring()).map(r => r.id)).toEqual([v!.id])
    await restoreRecurring(v!.id)
    expect(await hiddenRecurring()).toEqual([])
    expect((await recurringPayments('2026-10-20', 3)).map(x => x.id)).toEqual([v!.id])
  })

  it('previews without writing anything, so a read-only screen cannot change what the Recurring screen shows', async () => {
    await pay('m.gym', every('2026-05-01', 30, 5), 3000)
    expect(await recurringPreview('2026-10-20')).toHaveLength(1)
    expect(await db.recurring.count()).toBe(0)
  })

  it('does not lose a correction made between the read of the stored rows and the write', async () => {
    await pay('m.gym', every('2026-05-01', 30, 5), 3000)
    const [v] = await recurringPayments('2026-10-20', 1)
    const read = db.recurring.toArray.bind(db.recurring)
    const spy = vi.spyOn(db.recurring, 'toArray').mockImplementationOnce((async () => {
      const rows = await read()
      // The owner presses "not recurring" now: after the rows were read, before the detection writes them back.
      void Dexie.ignoreTransaction(() => db.recurring.update(v!.id, { dismissed: true, confirmedByUser: false }))
      return rows
    }) as never)
    await recurringPayments('2026-10-20', 2)
    spy.mockRestore()
    await new Promise((r) => setTimeout(r, 50))
    expect((await db.recurring.get(v!.id))?.dismissed).toBe(true)
  })
})
