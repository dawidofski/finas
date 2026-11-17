import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db/db'
import { seedDatabase } from '../db/seed'
import type { AnnotationRow, TransactionRow } from '../db/schema'
import { resolveMany, type ResolvedTransaction } from '../db/annotations'
import { loadCategoryKinds, worthAnnotating } from '../analysis/queues'
import { regretClusters } from './regret'

// 2026-11-16 is a Monday; 2026-11-17 a Tuesday; 2026-11-21 a Saturday; 2026-12-05 a Saturday.
const tx = (id: string, over: Partial<TransactionRow> = {}): TransactionRow => ({
  id, accountId: 'acc', valueDate: '2026-11-16', amountCents: -1000,
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
type Clusters = Awaited<ReturnType<typeof regretClusters>>
const find = (cs: Clusters, by: string, key: string) => cs.find((c) => c.by === by && c.key === key)

beforeEach(async () => {
  await db.delete(); await db.open(); await seedDatabase()
  await db.merchants.add({
    id: 'm1', canonicalName: 'Bar Pepe', kind: 'merchant', matchPatterns: [], defaultCategoryId: null, isSubscription: false, createdAt: 1,
  } as never)
})

describe('regretClusters', () => {
  it('aggregates regretted spends by each of the five dimensions', async () => {
    const cat = (await db.categories.toArray())[0]!
    await db.transactions.bulkAdd([tx('a', { amountCents: -1000 }), tx('b', { amountCents: -2500 })])
    const all = { worthwhile: false, purchaseReasonId: 'reason.impulse', merchantId: 'm1', categoryId: cat.id, moodId: 'mood.bored' }
    await db.annotations.bulkAdd([ann('a', all), ann('b', all)])
    const cs = await regretClusters('2026-11')
    const expected = (by: string, key: string, label: string) =>
      expect(find(cs, by, key)).toEqual({ by, key, label, regretted: 2, total: 2, cents: 3500 })
    expected('reason', 'reason.impulse', 'Impulse')
    expected('merchant', 'm1', 'Bar Pepe')
    expected('category', cat.id, cat.name)
    expected('mood', 'mood.bored', 'Bored')
    expected('weekday', '1', 'lunes')
    expect(cs).toHaveLength(5)
  })

  it('reports the denominator, and leaves unanswered spends out of it', async () => {
    await db.transactions.bulkAdd([tx('a'), tx('b'), tx('c'), tx('d')])
    await db.annotations.bulkAdd([
      ann('a', { worthwhile: false, moodId: 'mood.sad' }),
      ann('b', { worthwhile: true, moodId: 'mood.sad' }),
      ann('c', { worthwhile: null, moodId: 'mood.sad' }),
      // d has no annotation at all
    ])
    expect(find(await regretClusters('2026-11'), 'mood', 'mood.sad')).toMatchObject({ regretted: 1, total: 2 })
    // One regret out of one is reported as 1 of 1, so the consumer can see it is not a pattern.
    await db.annotations.put(ann('b', { worthwhile: null, moodId: 'mood.sad' }))
    expect(find(await regretClusters('2026-11'), 'mood', 'mood.sad')).toMatchObject({ regretted: 1, total: 1 })
  })

  it('buckets by the bank value date and amount, so a correction cannot move or resize a cluster', async () => {
    // Bank: Monday 16 Nov, 10.00. The owner "corrected" it to Saturday 5 Dec and 99.00.
    await db.transactions.add(tx('a', { amountCents: -1000 }))
    await db.annotations.add(ann('a', { worthwhile: false, dateOverride: '2026-12-05', amountCentsOverride: -9900 }))
    const nov = await regretClusters('2026-11')
    expect(find(nov, 'weekday', '1')).toMatchObject({ regretted: 1, cents: 1000 })
    expect(find(nov, 'weekday', '6')).toBeUndefined()
    expect(await regretClusters('2026-12')).toEqual([])
  })

  // CHANGED in the §43 ruling. This test used to be "uses the bank kind: a spend the owner retyped is still a spend,
  // and a bank income never counts" and asserted 1000 for row 'a' — a bank spend the owner re-kinded to income —
  // because the kind was the bank's here. `kind` is now the owner's classification in every figure (§43), and
  // `worthAnnotating` already asked the resolved kind, so the queue has stopped asking about 'a' and the same data
  // gives no cluster at all. The second half is unchanged and is a §43.1 money invariant rather than the old ruling:
  // the bank's SIGN decides which side of the ledger a row can be on, so a bank arrival re-kinded to `spend` is never
  // money out — counting it would put a negative into a cluster's `cents`, which is defined as money out.
  it('uses the resolved kind, and never counts a bank arrival as money out (§43, §43.1)', async () => {
    await db.transactions.bulkAdd([tx('a'), tx('b', { kind: 'income', amountCents: 5000, valueDate: '2026-11-17' })])
    await db.annotations.bulkAdd([ann('a', { worthwhile: false, typeOverride: 'income' }), ann('b', { worthwhile: false, typeOverride: 'spend' })])
    const cs = await regretClusters('2026-11')
    expect(find(cs, 'weekday', '1')).toBeUndefined() // the owner says 'a' is not spending, so it is in no cluster
    expect(find(cs, 'weekday', '2')).toBeUndefined() // and money that arrived cannot be money out
    expect(cs).toEqual([])
  })

  it('counts the answer the queue asked for: a bank internal re-kinded to spend (§43)', async () => {
    // The worth-it queue offers this row, because worthAnnotating asks the RESOLVED kind. The owner answered it, so
    // the answer has to land in a cluster: asking a question and counting the answer nowhere is the defect here.
    await db.transactions.add(tx('a', { kind: 'internal', amountCents: -1234, valueDate: '2026-11-21' }))
    await db.annotations.add(ann('a', {
      typeOverride: 'spend', worthwhile: false, moodId: 'mood.bored',
      // §41 is untouched: the weekday and the amount below are the bank's Saturday and 12.34, not these.
      dateOverride: '2026-11-17', amountCentsOverride: -9900,
    }))
    const resolved = (await resolveMany([(await db.transactions.get('a')) as TransactionRow]))[0] as ResolvedTransaction
    expect(worthAnnotating(resolved, await loadCategoryKinds())).toBe(true) // the queue does ask about it...
    const cs = await regretClusters('2026-11')
    // ...so the cluster holds it, with the BANK's amount and the BANK's weekday.
    expect(find(cs, 'weekday', '6')).toEqual({ by: 'weekday', key: '6', label: 'sábado', regretted: 1, total: 1, cents: 1234 })
    expect(find(cs, 'mood', 'mood.bored')).toMatchObject({ regretted: 1, total: 1, cents: 1234 })
    expect(find(cs, 'weekday', '2')).toBeUndefined() // not the owner's corrected date
  })

  it('drops a bank spend the owner re-kinded out of spending, numerator and denominator alike (§43)', async () => {
    // The other half of the same rule: the queue stops offering 'b' once it is internal, so no figure may hold it.
    await db.transactions.bulkAdd([tx('a', { amountCents: -1000 }), tx('b', { amountCents: -4000 })])
    await db.annotations.bulkAdd([
      ann('a', { worthwhile: false, moodId: 'mood.bored' }),
      ann('b', { worthwhile: false, moodId: 'mood.bored', typeOverride: 'internal' }),
    ])
    const resolvedB = (await resolveMany([(await db.transactions.get('b')) as TransactionRow]))[0] as ResolvedTransaction
    expect(worthAnnotating(resolvedB, await loadCategoryKinds())).toBe(false) // the queue no longer asks...
    const cs = await regretClusters('2026-11')
    // ...and 'b' is out of the regret count, out of the denominator and out of the money.
    expect(find(cs, 'mood', 'mood.bored')).toMatchObject({ regretted: 1, total: 1, cents: 1000 })
  })

  it('ignores soft-deleted transactions', async () => {
    await db.transactions.bulkAdd([tx('a'), tx('b', { deletedAt: 5 })])
    await db.annotations.bulkAdd([ann('a', { worthwhile: false }), ann('b', { worthwhile: false })])
    expect(find(await regretClusters('2026-11'), 'weekday', '1')).toMatchObject({ regretted: 1, total: 1 })
    expect(find(await regretClusters(null), 'weekday', '1')).toMatchObject({ regretted: 1, total: 1 })
  })

  it('names a weekday in Spanish, derived from the ISO string', async () => {
    await db.transactions.bulkAdd([
      tx('a', { valueDate: '2026-11-17' }), tx('b', { valueDate: '2026-11-21' }), tx('c', { valueDate: '2026-11-22' }),
    ])
    await db.annotations.bulkAdd(['a', 'b', 'c'].map((id) => ann(id, { worthwhile: false })))
    const labels = Object.fromEntries((await regretClusters('2026-11')).map((c) => [c.key, c.label]))
    expect(labels).toEqual({ '2': 'martes', '6': 'sábado', '7': 'domingo' })
  })

  it('takes the month from the bank date, and null means all history', async () => {
    await db.transactions.bulkAdd([tx('a', { valueDate: '2026-10-31' }), tx('b', { valueDate: '2026-11-01' })])
    await db.annotations.bulkAdd([ann('a', { worthwhile: false }), ann('b', { worthwhile: false })])
    const n = (cs: Clusters) => cs.filter((c) => c.by === 'weekday').reduce((sum, c) => sum + c.regretted, 0)
    expect(n(await regretClusters('2026-10'))).toBe(1)
    expect(n(await regretClusters('2026-11'))).toBe(1)
    expect(n(await regretClusters(null))).toBe(2)
  })

  it('orders by regretted, then cents, then key, whatever the read order', async () => {
    // Mon x2 (300 cents), Tue x1 (900), Wed x1 (900), Thu x1 (100): Mon, then Tue before Wed on key, Thu last.
    const rows: [string, string, number][] = [
      ['a', '2026-11-16', -100], ['b', '2026-11-16', -200], ['c', '2026-11-17', -900],
      ['d', '2026-11-18', -900], ['e', '2026-11-19', -100],
    ]
    const make = async (order: typeof rows) => {
      await db.transactions.clear(); await db.annotations.clear()
      await db.transactions.bulkAdd(order.map(([id, valueDate, amountCents]) => tx(id, { valueDate, amountCents })))
      await db.annotations.bulkAdd(order.map(([id]) => ann(id, { worthwhile: false })))
      return (await regretClusters('2026-11')).map((c) => c.key)
    }
    const forward = await make(rows)
    expect(forward).toEqual(['1', '2', '3', '4'])
    expect(await make([...rows].reverse())).toEqual(forward)
  })

  it('breaks ties on cents and then key even when the read order says otherwise', async () => {
    // The read order is by value date, so the EARLIER spend is inserted first. Each expectation below contradicts that.
    const reasons = (cs: Clusters) => cs.filter((c) => c.by === 'reason').map((c) => c.key)
    await db.transactions.bulkAdd([tx('a', { valueDate: '2026-11-16', amountCents: -100 }), tx('b', { valueDate: '2026-11-17', amountCents: -900 })])
    await db.annotations.bulkAdd([ann('a', { worthwhile: false, purchaseReasonId: 'reason.impulse' }), ann('b', { worthwhile: false, purchaseReasonId: 'reason.reward' })])
    // Same regret count: more cents first, although reason.impulse was read first.
    expect(reasons(await regretClusters('2026-11'))).toEqual(['reason.reward', 'reason.impulse'])
    // Same regret count and cents: the lower key first, although reason.reward was read first.
    await db.annotations.bulkPut([ann('a', { worthwhile: false, purchaseReasonId: 'reason.reward' }), ann('b', { worthwhile: false, purchaseReasonId: 'reason.impulse' })])
    await db.transactions.clear()
    await db.transactions.bulkAdd([tx('a', { valueDate: '2026-11-16', amountCents: -100 }), tx('b', { valueDate: '2026-11-17', amountCents: -100 })])
    expect(reasons(await regretClusters('2026-11'))).toEqual(['reason.impulse', 'reason.reward'])
  })

  it('returns an empty list when nothing was regretted, rather than clusters of zero', async () => {
    await db.transactions.bulkAdd([tx('a'), tx('b')])
    await db.annotations.bulkAdd([ann('a', { worthwhile: true, moodId: 'mood.happy' }), ann('b', { worthwhile: null })])
    expect(await regretClusters('2026-11')).toEqual([])
    expect(await regretClusters(null)).toEqual([])
  })
})
