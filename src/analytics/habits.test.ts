import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db/db'
import { seedDatabase } from '../db/seed'
import type { AnnotationRow, TransactionRow } from '../db/schema'
import { smallPurchases, afterPayday } from './habits'

const tx = (id: string, over: Partial<TransactionRow> = {}): TransactionRow => ({
  id, accountId: 'acc', valueDate: '2026-11-10', amountCents: -1000,
  balanceCents: 50000, description: 'SHOP', comment: null,
  ingCategory: null, ingSubcategory: null,
  kind: 'spend', dedupKey: `K${id}`, importId: 'imp', fileSeq: 1, roundupParentId: null,
  createdAt: 1, deletedAt: null, ...over,
})
const ann = (transactionId: string, over: Partial<AnnotationRow> = {}): AnnotationRow => ({
  transactionId, categoryId: null, subcategoryId: null, merchantId: null, typeOverride: null, paymentMethod: null,
  note: null, moodId: null, purchaseReasonId: null, worthwhile: null, reviewed: false, dateOverride: null,
  amountCentsOverride: null, descriptionOverride: null, updatedAt: 1, ...over,
})
const pay = (id: string, valueDate: string, over: Partial<TransactionRow> = {}) =>
  tx(id, { kind: 'income', amountCents: 200000, valueDate, ...over })

beforeEach(async () => {
  await db.delete(); await db.open(); await seedDatabase()
})

describe('smallPurchases', () => {
  it('adds up the purchases under the ceiling and reports what they came to', async () => {
    await db.transactions.bulkAdd([
      tx('a', { amountCents: -300 }), tx('b', { amountCents: -500 }),
      tx('big', { amountCents: -1500 }),                       // over the ceiling
      tx('at', { amountCents: -1000 }),                        // exactly at it: under means strictly under
      tx('in', { amountCents: 400, kind: 'income' }),          // money in
      tx('arr', { amountCents: 400, kind: 'spend' }),          // a bank arrival the kind calls spending: still not a purchase
      tx('int', { amountCents: -200, kind: 'internal' }),      // not spending
      tx('gone', { amountCents: -250, deletedAt: 5 }),         // soft-deleted
      tx('other', { amountCents: -250, valueDate: '2026-12-01' }), // another month
    ])
    expect(await smallPurchases('2026-11', 1000, 1)).toEqual({ count: 2, totalCents: 800, medianCents: 400 })
  })

  it('reads the amount from the bank row, whatever the owner typed over it', async () => {
    await db.transactions.bulkAdd([tx('a', { amountCents: -300 }), tx('b', { amountCents: -1500 })])
    await db.annotations.bulkAdd([
      ann('a', { amountCentsOverride: -9000 }),  // looks big, is small
      ann('b', { amountCentsOverride: -100 }),   // looks small, is big
    ])
    expect(await smallPurchases('2026-11', 1000, 1)).toEqual({ count: 1, totalCents: 300, medianCents: 300 })
  })

  it('reports the median as well as the total, so one large row cannot masquerade as many small ones', async () => {
    await db.transactions.bulkAdd([
      ...[1, 2, 3, 4].map((i) => tx(`s${i}`, { amountCents: -100 })), tx('l', { amountCents: -9000 }),
    ])
    // The total says 94.00 EUR, which reads like a habit; the median says the typical row is 1.00 EUR.
    expect(await smallPurchases('2026-11', 10000, 1)).toEqual({ count: 5, totalCents: 9400, medianCents: 100 })
  })

  it('rounds a half cent away from zero, as unusual.ts does', async () => {
    await db.transactions.bulkAdd([tx('a', { amountCents: -300 }), tx('b', { amountCents: -501 })])
    expect((await smallPurchases('2026-11', 1000, 1)).medianCents).toBe(401) // 400.5
  })

  it('does not serve one ceiling the cached answer of another', async () => {
    await db.transactions.bulkAdd([tx('a', { amountCents: -300 }), tx('b', { amountCents: -800 })])
    expect((await smallPurchases('2026-11', 500, 1)).count).toBe(1)
    expect((await smallPurchases('2026-11', 1000, 2)).count).toBe(2)
  })

  it('says count 0 for a month with nothing small, not a median of anything', async () => {
    expect(await smallPurchases('2026-11', 1000, 1)).toEqual({ count: 0, totalCents: 0, medianCents: 0 })
  })
})

describe('afterPayday', () => {
  // November 2026 has 30 days; income on the 3rd makes offsets 0..27.
  it('groups spending by days since the income arrived, using the bank dates', async () => {
    await db.transactions.bulkAdd([
      pay('p', '2026-11-03'),
      tx('d0', { valueDate: '2026-11-03', amountCents: -100 }),
      tx('d2a', { valueDate: '2026-11-05', amountCents: -250 }),
      tx('d2b', { valueDate: '2026-11-05', amountCents: -350 }),
      tx('early', { valueDate: '2026-11-01', amountCents: -777 }), // before the income landed
    ])
    await db.annotations.bulkAdd([
      ann('p', { dateOverride: '2026-11-20' }),    // must not move the payday
      ann('d2a', { dateOverride: '2026-11-25', amountCentsOverride: -1 }), // must not move or resize the purchase
    ])
    const days = (await afterPayday('2026-11', 1))!
    expect(days.filter((d) => d.transactions > 0)).toEqual([
      { dayOffset: 0, spentCents: 100, transactions: 1 },
      { dayOffset: 2, spentCents: 600, transactions: 2 },
    ])
  })

  it('returns null when no income arrived that month, rather than an empty pattern', async () => {
    await db.transactions.bulkAdd([
      tx('s', { amountCents: -500 }),
      pay('next', '2026-12-02'),                                // income, but in another month
      tx('out', { kind: 'income', amountCents: -900 }),         // labelled income, but money left
      pay('notpay', '2026-11-04'),
    ])
    await db.annotations.bulkAdd([ann('notpay', { typeOverride: 'spend' })]) // the owner says it is not income
    expect(await afterPayday('2026-11', 1)).toBeNull()
  })

  it('counts a day with no spending as zero rather than omitting it', async () => {
    await db.transactions.bulkAdd([
      pay('p', '2026-11-03'),
      tx('a', { valueDate: '2026-11-03', amountCents: -100 }),
      tx('b', { valueDate: '2026-11-06', amountCents: -200 }),
    ])
    const days = (await afterPayday('2026-11', 1))!
    expect(days.map((d) => d.dayOffset)).toEqual(Array.from({ length: 28 }, (_, i) => i))
    // Days 1 and 2 sit between two spending days: present, and zero.
    expect(days[1]).toEqual({ dayOffset: 1, spentCents: 0, transactions: 0 })
    expect(days[2]).toEqual({ dayOffset: 2, spentCents: 0, transactions: 0 })
    expect(days[3]).toEqual({ dayOffset: 3, spentCents: 200, transactions: 1 })
    // ...and the tail to the end of the month is zeros too.
    expect(days[27]).toEqual({ dayOffset: 27, spentCents: 0, transactions: 0 })
  })
})
