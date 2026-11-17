import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../db/db'
import { seedDatabase } from '../db/seed'
import type { AnnotationRow, TransactionRow } from '../db/schema'
import { dedupKeyFor, type CandidateRow } from './normalise'
import { REVIEW_REASON_TEXT, classifyRows, type DedupVerdict } from './dedup'

const cand = (over: Partial<CandidateRow> = {}): CandidateRow => ({
  accountId: 'acc.1', valueDate: '2026-11-15', amountCents: -2320, balanceCents: 50000,
  description: 'Pago en COMERCIO EJEMPLO SL', comment: null, ingCategory: 'Compras', ingSubcategory: 'Compras (otros)',
  kind: 'spend', dedupKey: '', fileSeq: 1, roundupParentId: null, ...over,
})

/** Builds a candidate with its real key, as normaliseGrid does. */
const keyed = async (over: Partial<CandidateRow> = {}): Promise<CandidateRow> => {
  const c = cand(over)
  return { ...c, dedupKey: await dedupKeyFor(c) }
}

/** Stores a candidate as an already-imported transaction. */
const store = async (c: CandidateRow, id: string, over: Partial<TransactionRow> = {}): Promise<void> => {
  await db.transactions.add({ ...c, id, importId: 'imp.old', createdAt: 1, deletedAt: null, ...over })
}

const ann = (over: Partial<AnnotationRow>): AnnotationRow => ({
  transactionId: 't', categoryId: null, subcategoryId: null, merchantId: null, typeOverride: null,
  paymentMethod: null, note: null, moodId: null, purchaseReasonId: null, worthwhile: null,
  reviewed: false, dateOverride: null, amountCentsOverride: null, descriptionOverride: null,
  updatedAt: 1, ...over,
})

beforeEach(async () => {
  await db.delete(); await db.open(); await seedDatabase()
})

describe('classifyRows', () => {
  it('treats an exact key match as a duplicate', async () => {
    const c = await keyed()
    await store(c, 't1')
    expect(await classifyRows([c])).toEqual([{ kind: 'duplicate', existingId: 't1' }])
  })

  it('treats an unmatched row as new', async () => {
    await store(await keyed(), 't1')
    const other = await keyed({ amountCents: -500, balanceCents: 49500 })
    expect(await classifyRows([other])).toEqual([{ kind: 'new' }])
  })

  it('returns no verdicts for no rows', async () => {
    expect(await classifyRows([])).toEqual([])
  })

  it('treats two identical same-day amounts as separate transactions', async () => {
    // The two COMERCIO EJEMPLO SL -23.20 rows differ by running balance, hence by key.
    const first = await keyed({ balanceCents: 50000 })
    const second = await keyed({ balanceCents: 48880 })
    expect(first.dedupKey).not.toBe(second.dedupKey)
    expect(await classifyRows([first, second])).toEqual([{ kind: 'new' }, { kind: 'new' }])
    await store(first, 't1')
    expect(await classifyRows([first, second])).toEqual([{ kind: 'duplicate', existingId: 't1' }, { kind: 'new' }])
  })

  it('flags same date, amount and balance with a different description for review', async () => {
    await store(await keyed({ description: 'Pago en TIENDA UNO' }), 't1')
    const v = await classifyRows([await keyed({ description: 'Pago en TIENDA DOS' })])
    expect(v).toEqual([{ kind: 'review', existingId: 't1', reason: 'same-slot-different-description' }])
  })

  it('flags a match against a SOFT-DELETED row for review, never as new', async () => {
    const c = await keyed()
    await store(c, 't1', { deletedAt: 5 })
    const [v] = await classifyRows([c])
    expect(v).toEqual({ kind: 'review', existingId: 't1', reason: 'deleted' })
    // 'new' would make the insert throw on the unique dedupKey; prove that is the hazard being avoided.
    await expect(store(c, 't2')).rejects.toThrow()
  })

  it('reports deleted ahead of a description difference', async () => {
    await store(await keyed({ description: 'Pago en TIENDA UNO' }), 't1', { deletedAt: 5 })
    const v = await classifyRows([await keyed({ description: 'Pago en TIENDA DOS' })])
    expect(v).toEqual([{ kind: 'review', existingId: 't1', reason: 'deleted' }])
  })

  it('names the reason on every review verdict', async () => {
    await store(await keyed({ balanceCents: 1, description: 'A' }), 't1')
    await store(await keyed({ balanceCents: 2 }), 't2', { deletedAt: 5 })
    const verdicts = await classifyRows([
      await keyed({ balanceCents: 1, description: 'B' }),
      await keyed({ balanceCents: 2 }),
    ])
    const reviews = verdicts.filter((v) => v.kind === 'review')
    expect(reviews.map((v) => v.reason)).toEqual(['same-slot-different-description', 'deleted'])
  })

  it('keeps verdicts aligned with input order across a mixed batch', async () => {
    const a = await keyed({ balanceCents: 10 })
    const b = await keyed({ balanceCents: 20 })
    const c = await keyed({ balanceCents: 30 })
    await store(a, 'ta'); await store(c, 'tc')
    expect(await classifyRows([c, b, a])).toEqual([
      { kind: 'duplicate', existingId: 'tc' }, { kind: 'new' }, { kind: 'duplicate', existingId: 'ta' },
    ])
  })

  it('still matches a transaction the owner has edited', async () => {
    // Review Focus 5: the owner changes date, amount and description. The key reads bank values only.
    const c = await keyed()
    await store(c, 't1')
    await db.annotations.add(ann({
      transactionId: 't1', dateOverride: '2026-11-01', amountCentsOverride: -9999, descriptionOverride: 'Mi nota',
    }))
    expect(await classifyRows([c])).toEqual([{ kind: 'duplicate', existingId: 't1' }])
    // The stored bank row is untouched, so a differently-edited look-alike is not mistaken for it.
    const edited = await keyed({ valueDate: '2026-11-01', amountCents: -9999 })
    expect(await classifyRows([edited])).toEqual([{ kind: 'new' }])
  })

  it('sends a later row sharing a key within the file to review, keeping the first verdict', async () => {
    const a = await keyed({ balanceCents: 10, description: 'Pago en TIENDA UNO' })
    const twin = await keyed({ balanceCents: 10, description: 'Pago en TIENDA DOS' })
    const other = await keyed({ balanceCents: 20 })
    expect(twin.dedupKey).toBe(a.dedupKey)
    expect(await classifyRows([a, other, twin])).toEqual([
      { kind: 'new' }, { kind: 'new' }, { kind: 'review', reason: 'duplicate-within-file', firstIndex: 0 },
    ])
    await store(a, 't1')
    expect(await classifyRows([a, twin])).toEqual([
      { kind: 'duplicate', existingId: 't1' }, { kind: 'review', reason: 'duplicate-within-file', firstIndex: 0 },
    ])
  })

  it('keeps the deleted verdict first and points every later copy at index 0', async () => {
    const a = await keyed({ balanceCents: 10 })
    await store(a, 't1', { deletedAt: 5 })
    const verdicts = await classifyRows([a, { ...a, fileSeq: 2 }, { ...a, fileSeq: 3 }])
    expect(verdicts).toEqual([
      { kind: 'review', existingId: 't1', reason: 'deleted' },
      { kind: 'review', reason: 'duplicate-within-file', firstIndex: 0 },
      { kind: 'review', reason: 'duplicate-within-file', firstIndex: 0 },
    ])
  })

  it('has owner-readable text for every review reason', () => {
    for (const reason of ['deleted', 'same-slot-different-description', 'duplicate-within-file'] as const) {
      expect(REVIEW_REASON_TEXT[reason].length).toBeGreaterThan(20)
    }
    expect(REVIEW_REASON_TEXT['duplicate-within-file']).toMatch(/skipped/)
  })

  // The point is that the count does not scale with the row count: one read for 300 rows is as decisive as for 3,000.
  it('costs a single database query for a 300-row batch', async () => {
    const rows: CandidateRow[] = []
    for (let i = 0; i < 300; i++) rows.push(await keyed({ balanceCents: 100000 + i, fileSeq: i + 1 }))
    await db.transactions.bulkAdd(rows.slice(0, 150).map((b, i) => ({
      ...b, id: `t${i}`, importId: 'imp.old', createdAt: 1, deletedAt: null,
    })))
    // Middleware only takes effect on a fresh open; installed before open() or it would count zero.
    let reads = 0
    db.close()
    db.use({
      stack: 'dbcore', name: 'count-reads',
      create: (down) => ({
        ...down,
        table: (name) => {
          const t = down.table(name)
          return {
            ...t,
            get: (r) => { reads++; return t.get(r) },
            getMany: (r) => { reads++; return t.getMany(r) },
            query: (r) => { reads++; return t.query(r) },
            openCursor: (r) => { reads++; return t.openCursor(r) },
          }
        },
      }),
    })
    let verdicts: DedupVerdict[]
    try {
      await db.open()
      reads = 0
      verdicts = await classifyRows(rows)
    } finally {
      db.close()
      db.unuse({ stack: 'dbcore', name: 'count-reads' })
      await db.open()
    }
    // Measured: Dexie's anyOf().toArray() issues exactly one dbcore read (a single cursor over the sorted keys),
    // the same for 10 and 3,000 rows (re-measured at 300 here). Zero would mean the middleware was not installed.
    expect(reads).toBe(1)
    expect(verdicts.filter((v) => v.kind === 'duplicate')).toHaveLength(150)
    expect(verdicts.filter((v) => v.kind === 'new')).toHaveLength(150)
  })
})
