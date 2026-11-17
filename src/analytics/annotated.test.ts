import { describe, it, expect, beforeEach, vi } from 'vitest'
import { db } from '../db/db'
import { seedDatabase } from '../db/seed'
import type { AnnotationRow, TransactionRow } from '../db/schema'
import { moodBreakdown, reasonBreakdown, worthwhileBreakdown } from './annotated'

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
const NOW = 1_000
const byKey = <T extends { key: string }>(rows: T[], key: string) => rows.find((r) => r.key === key)

beforeEach(async () => {
  await db.delete(); await db.open(); await seedDatabase()
})

describe('moodBreakdown', () => {
  it('reports spending by mood, with how many spends carried a mood at all', async () => {
    // Four spends; only three carry a mood, so the denominator (3) is not the spend count (4).
    await db.transactions.bulkAdd([tx('a', { amountCents: -1000 }), tx('b', { amountCents: -2500 }), tx('c', { amountCents: -400 }), tx('d')])
    await db.annotations.bulkAdd([
      ann('a', { moodId: 'mood.bored' }), ann('b', { moodId: 'mood.bored' }), ann('c', { moodId: 'mood.happy' }),
      ann('d', { moodId: null, worthwhile: true }),
    ])
    expect(await moodBreakdown('2026-11', NOW)).toEqual([
      { key: 'mood.bored', label: 'Bored', transactions: 2, totalCents: 3500, answeredOf: 3, spendsInScope: 4 },
      { key: 'mood.happy', label: 'Happy', transactions: 1, totalCents: 400, answeredOf: 3, spendsInScope: 4 },
    ])
  })

  it('reads all history when no month is given, and a single month when one is', async () => {
    await db.transactions.bulkAdd([tx('a'), tx('b', { valueDate: '2026-10-03' }), tx('c')])
    await db.annotations.bulkAdd([ann('a', { moodId: 'mood.sad' }), ann('b', { moodId: 'mood.sad' })])
    expect(await moodBreakdown(null, NOW)).toEqual([{ key: 'mood.sad', label: 'Sad', transactions: 2, totalCents: 2000, answeredOf: 2, spendsInScope: null }])
    expect(await moodBreakdown('2026-10', NOW)).toEqual([{ key: 'mood.sad', label: 'Sad', transactions: 1, totalCents: 1000, answeredOf: 1, spendsInScope: 1 }])
  })

  it('takes amount and month from the bank, so an override cannot move or resize a row (§41)', async () => {
    await db.transactions.add(tx('a', { amountCents: -1000 }))
    await db.annotations.add(ann('a', { moodId: 'mood.sad', dateOverride: '2026-12-05', amountCentsOverride: -9900 }))
    const row = { key: 'mood.sad', label: 'Sad', transactions: 1, totalCents: 1000, answeredOf: 1 }
    expect(await moodBreakdown('2026-11', NOW)).toEqual([{ ...row, spendsInScope: 1 }])
    expect(await moodBreakdown('2026-12', NOW)).toEqual([])
    expect(await moodBreakdown(null, NOW)).toEqual([{ ...row, spendsInScope: null }])
  })

  it('rejects a malformed month', async () => {
    await expect(moodBreakdown('2026-13', NOW)).rejects.toThrow(/Invalid month/)
  })
})

describe('reasonBreakdown', () => {
  it('reports spending by purchase reason, with its denominator', async () => {
    await db.transactions.bulkAdd([tx('a', { amountCents: -700 }), tx('b', { amountCents: -300 }), tx('c'), tx('d')])
    await db.annotations.bulkAdd([
      ann('a', { purchaseReasonId: 'reason.impulse', moodId: 'mood.bored' }),
      ann('b', { purchaseReasonId: 'reason.planned' }),
      ann('c', { moodId: 'mood.sad' }), // a mood but no reason: not in the reason denominator
    ])
    expect(await reasonBreakdown('2026-11', NOW)).toEqual([
      { key: 'reason.impulse', label: 'Impulse', transactions: 1, totalCents: 700, answeredOf: 2, spendsInScope: 4 },
      { key: 'reason.planned', label: 'Planned', transactions: 1, totalCents: 300, answeredOf: 2, spendsInScope: 4 },
    ])
  })
})

describe('worthwhileBreakdown', () => {
  it('reports worth-it against not-worth-it, counting only answered purchases', async () => {
    await db.transactions.bulkAdd([
      tx('a', { amountCents: -1000 }), tx('b', { amountCents: -500 }), tx('c', { amountCents: -250 }),
      tx('d', { amountCents: -9000 }), tx('e'),
    ])
    await db.annotations.bulkAdd([
      ann('a', { worthwhile: true }), ann('b', { worthwhile: false }), ann('c', { worthwhile: true }),
      ann('d', { worthwhile: null, moodId: 'mood.sad' }), // not answered: in neither row, nor the denominator
      // e: no annotation at all
    ])
    expect(await worthwhileBreakdown('2026-11', NOW)).toEqual([
      { key: 'worth-it', label: 'Worth it', transactions: 2, totalCents: 1250, answeredOf: 3, spendsInScope: 5 },
      { key: 'not-worth-it', label: 'Not worth it', transactions: 1, totalCents: 500, answeredOf: 3, spendsInScope: 5 },
    ])
  })

  it('keeps the base when only one side was chosen, and is empty when nothing was answered', async () => {
    await db.transactions.bulkAdd([tx('a'), tx('b')])
    await db.annotations.bulkAdd([ann('a', { worthwhile: false }), ann('b', { moodId: 'mood.sad' })])
    expect(await worthwhileBreakdown('2026-11', NOW)).toEqual([
      { key: 'not-worth-it', label: 'Not worth it', transactions: 1, totalCents: 1000, answeredOf: 1, spendsInScope: 2 },
    ])
    expect(await worthwhileBreakdown('2026-10', NOW)).toEqual([])
  })
})

describe('shared rules', () => {
  it('labels a removed mood or reason rather than showing an id', async () => {
    await db.transactions.bulkAdd([tx('a'), tx('b')])
    await db.annotations.bulkAdd([
      ann('a', { moodId: 'mood.gone', purchaseReasonId: 'reason.gone' }),
      ann('b', { moodId: 'mood.bored', purchaseReasonId: 'reason.impulse' }),
    ])
    const moods = await moodBreakdown('2026-11', NOW)
    const reasons = await reasonBreakdown('2026-11', NOW)
    expect(byKey(moods, 'mood.gone')?.label).toBe('Removed mood')
    expect(byKey(reasons, 'reason.gone')?.label).toBe('Removed reason')
    // A removed label still counts toward the base.
    expect(moods.every((r) => r.answeredOf === 2 && r.spendsInScope === 2)).toBe(true)
  })

  it('excludes income and transfers, so only choices the owner made are described', async () => {
    const all = { moodId: 'mood.happy', purchaseReasonId: 'reason.planned', worthwhile: true }
    await db.transactions.bulkAdd([
      tx('spend', { amountCents: -1000 }),
      tx('salary', { amountCents: 200000, kind: 'income' }),
      tx('transferKind', { amountCents: -5000, kind: 'internal' }),
      tx('transferCat', { amountCents: -7000 }),
      tx('retyped', { amountCents: -3000 }), // a bank spend the owner re-kinded to income
      tx('arrival', { amountCents: 800 }),   // positive amount re-kinded to spend: never money out (§43.1)
    ])
    await db.annotations.bulkAdd([
      ann('spend', all), ann('salary', all), ann('transferKind', all),
      ann('transferCat', { ...all, categoryId: 'cat.internal-transfer' }),
      ann('retyped', { ...all, typeOverride: 'income' }),
      ann('arrival', { ...all, typeOverride: 'spend' }),
    ])
    const expected = { transactions: 1, totalCents: 1000, answeredOf: 1, spendsInScope: 1 }
    expect(await moodBreakdown('2026-11', NOW)).toEqual([{ key: 'mood.happy', label: 'Happy', ...expected }])
    expect(await reasonBreakdown('2026-11', NOW)).toEqual([{ key: 'reason.planned', label: 'Planned', ...expected }])
    expect(await worthwhileBreakdown('2026-11', NOW)).toEqual([{ key: 'worth-it', label: 'Worth it', ...expected }])
    expect(await moodBreakdown(null, NOW)).toEqual([{ key: 'mood.happy', label: 'Happy', ...expected, spendsInScope: null }])
  })

  it('says nothing about cause, in any label or reading', async () => {
    const CAUSAL = /\b(because|caus\w*|lead(s|ing)?\s+to|led\s+to|due\s+to|result(s|ed|ing)?\s+(in|from)|trigger\w*|drive[sn]?|driving|therefore|so\s+that|explain\w*|why|reason\s+for)\b/i
    const moods = await db.moods.toArray()
    const reasons = await db.purchaseReasons.toArray()
    await db.transactions.bulkAdd([tx('a'), tx('b'), tx('c')])
    await db.annotations.bulkAdd([
      ann('a', { moodId: 'mood.gone', purchaseReasonId: 'reason.gone', worthwhile: false }),
      ann('b', { moodId: moods[0]!.id, purchaseReasonId: reasons[0]!.id, worthwhile: true }),
    ])
    const rows = [
      ...(await moodBreakdown('2026-11', NOW)), ...(await reasonBreakdown('2026-11', NOW)), ...(await worthwhileBreakdown('2026-11', NOW)),
    ]
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) expect(r.label).not.toMatch(CAUSAL)
    for (const label of ['Removed mood', 'Removed reason', 'Worth it', 'Not worth it']) expect(label).not.toMatch(CAUSAL)
    // Only counts and sums leave this module: no statistic can ride along on a row.
    for (const r of rows) expect(Object.keys(r).sort()).toEqual(['answeredOf', 'key', 'label', 'spendsInScope', 'totalCents', 'transactions'])
  })
})

describe('whole-history soft-delete filter', () => {
  it('leaves a soft-deleted spend out of every all-history breakdown', async () => {
    await db.transactions.bulkAdd([tx('live', { amountCents: -1000 }), tx('gone', { amountCents: -7000, deletedAt: 5 })])
    const all = { moodId: 'mood.sad', purchaseReasonId: 'reason.impulse', worthwhile: false }
    await db.annotations.bulkAdd([ann('live', all), ann('gone', all)])
    const rows = [
      ...(await moodBreakdown(null, NOW)), ...(await reasonBreakdown(null, NOW)), ...(await worthwhileBreakdown(null, NOW)),
    ]
    expect(rows).toHaveLength(3)
    for (const r of rows) expect(r).toMatchObject({ transactions: 1, totalCents: 1000, answeredOf: 1 })
  })
})

describe('caching (§7.1)', () => {
  it('serves a second call from the cache and recomputes once the data changes', async () => {
    await db.transactions.bulkAdd([tx('a', { amountCents: -1000 })])
    await db.annotations.add(ann('a', { moodId: 'mood.sad', updatedAt: 10 }))
    const first = await moodBreakdown('2026-11', NOW)
    const spy = vi.spyOn(db.transactions, 'bulkGet')
    const reads = vi.spyOn(db.moods, 'toArray')
    expect(await moodBreakdown('2026-11', NOW + 1)).toEqual(first)
    expect(reads).not.toHaveBeenCalled() // not recomputed
    await db.transactions.add(tx('b', { amountCents: -500 }))
    await db.annotations.add(ann('b', { moodId: 'mood.sad', updatedAt: 20 }))
    const after = await moodBreakdown('2026-11', NOW + 2)
    expect(reads).toHaveBeenCalled()
    expect(after[0]).toMatchObject({ transactions: 2, totalCents: 1500 })
    spy.mockRestore(); reads.mockRestore()
  })

  it('keeps the scopes and the breakdowns apart', async () => {
    await db.transactions.bulkAdd([tx('a'), tx('b', { valueDate: '2026-10-03' })])
    await db.annotations.bulkAdd([ann('a', { moodId: 'mood.sad', purchaseReasonId: 'reason.planned' }), ann('b', { moodId: 'mood.sad' })])
    expect((await moodBreakdown('2026-11', NOW))[0]?.transactions).toBe(1)
    expect((await moodBreakdown(null, NOW))[0]?.transactions).toBe(2)
    expect((await moodBreakdown('2026-11', NOW))[0]?.transactions).toBe(1)
    expect((await reasonBreakdown('2026-11', NOW))[0]?.key).toBe('reason.planned')
    expect((await moodBreakdown('2026-11', NOW))[0]?.key).toBe('mood.sad')
  })
})
