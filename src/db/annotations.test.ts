import { describe, it, expect, beforeEach, vi } from 'vitest'
import { db } from './db'
import { seedDatabase } from './seed'
import { resolve, resolveMany, writeAnnotation, categoryIdForIngPair } from './annotations'
import type { AnnotationRow, LearningEventRow, TransactionRow } from './schema'

const tx = (over: Partial<TransactionRow> = {}): TransactionRow => ({
  id: 't1', accountId: 'acc', valueDate: '2026-11-15', amountCents: -1250,
  balanceCents: 50000, description: 'SUPERMERCADO EJEMPLO 123', comment: null,
  ingCategory: 'Alimentación', ingSubcategory: 'Supermercados y alimentación',
  kind: 'spend', dedupKey: 'K1', importId: 'imp', fileSeq: 1, roundupParentId: null,
  createdAt: 1, deletedAt: null, ...over,
})

const ann = (over: Partial<AnnotationRow> = {}): AnnotationRow => ({
  transactionId: 't1', categoryId: null, subcategoryId: null, merchantId: null, typeOverride: null,
  paymentMethod: null, note: null, moodId: null, purchaseReasonId: null, worthwhile: null,
  reviewed: false, dateOverride: null, amountCentsOverride: null, descriptionOverride: null,
  updatedAt: 1, ...over,
})

const events = (): Promise<LearningEventRow[]> => db.learningEvents.orderBy('at').toArray()
const payloadOf = (e: LearningEventRow) => e.payload as { transactionId: string; field: string; old: unknown; new: unknown }

beforeEach(async () => {
  await db.delete(); await db.open(); await seedDatabase()
})

describe('resolve', () => {
  it('returns bank values when there is no annotation', () => {
    const r = resolve(tx(), undefined, new Map())
    expect(r.valueDate).toBe('2026-11-15')
    expect(r.amountCents).toBe(-1250)
    expect(r.description).toBe('SUPERMERCADO EJEMPLO 123')
    expect(r.kind).toBe('spend')
    expect(r.categoryId).toBeNull()
    expect(r.reviewed).toBe(false)
    expect(r.hasOverrides).toBe(false)
  })

  it('prefers each override and leaves the bank row untouched', async () => {
    const row = tx()
    await db.transactions.add(row)
    await db.annotations.add(ann({
      dateOverride: '2026-11-10', amountCentsOverride: -999, descriptionOverride: 'Weekly shop',
      typeOverride: 'income', roundupParentIdOverride: 'p9',
    }))
    const [r] = await resolveMany([row])
    expect(r).toMatchObject({
      valueDate: '2026-11-10', amountCents: -999, description: 'Weekly shop', kind: 'income', roundupParentId: 'p9',
    })
    expect(await db.transactions.get('t1')).toEqual(row)
  })

  it('treats an explicit null roundupParentIdOverride as a detached link, undefined as no override', () => {
    const linked = tx({ roundupParentId: 'p1' })
    expect(resolve(linked, ann(), new Map()).roundupParentId).toBe('p1')
    const detached = resolve(linked, ann({ roundupParentIdOverride: null }), new Map())
    expect(detached.roundupParentId).toBeNull()
    expect(detached.hasOverrides).toBe(true)
  })

  it('derives the category from the ING pair when the owner has not set one', async () => {
    const row = tx()
    await db.transactions.add(row)
    const [r] = await resolveMany([row])
    expect(r?.categoryId).toBe('cat.groceries')
    expect(await db.annotations.count()).toBe(0) // derived at read time, never written
  })

  it('prefers the owner category over the derived one', async () => {
    const row = tx()
    await db.transactions.add(row)
    await db.annotations.add(ann({ categoryId: 'cat.restaurants' }))
    const [r] = await resolveMany([row])
    expect(r?.categoryId).toBe('cat.restaurants')
  })

  it('returns null category for an ING pair with no node', async () => {
    const row = tx({ ingCategory: 'Nueva', ingSubcategory: 'Desconocida' })
    await db.transactions.add(row)
    expect((await resolveMany([row]))[0]?.categoryId).toBeNull()
    expect(await categoryIdForIngPair('Nueva', 'Desconocida')).toBeNull()
    expect(await categoryIdForIngPair('Alimentación', 'Supermercados y alimentación')).toBe('cat.groceries')
  })

  it('refuses an ING pair claimed by two categories rather than picking one arbitrarily', async () => {
    await db.categories.add({ id: 'cat.dup', name: 'dup', parentId: null, kind: 'discretionary', isUserCreated: true, ingMappings: ['Alimentación / Supermercados y alimentación'] })
    await expect(resolveMany([tx()])).rejects.toThrow(/claimed by both/)
  })

  it('returns null category for a row with no ING pair at all', async () => {
    const row = tx({ ingCategory: null, ingSubcategory: null })
    expect((await resolveMany([row]))[0]?.categoryId).toBeNull()
  })

  it('reports hasOverrides only when an override is set', () => {
    const idx = new Map()
    expect(resolve(tx(), ann(), idx).hasOverrides).toBe(false)
    expect(resolve(tx(), ann({ reviewed: true }), idx).hasOverrides).toBe(false)
    expect(resolve(tx(), ann({ note: 'n' }), idx).hasOverrides).toBe(true)
    expect(resolve(tx(), ann({ merchantId: 'm' }), idx).hasOverrides).toBe(true)
    expect(resolve(tx(), ann({ paymentMethod: 'card' }), idx).hasOverrides).toBe(true)
    expect(resolve(tx(), ann({ moodId: 'mood.happy' }), idx).hasOverrides).toBe(true)
    expect(resolve(tx(), ann({ worthwhile: false }), idx).hasOverrides).toBe(true)
    expect(resolve(tx(), ann({ dateOverride: '2026-01-01' }), idx).hasOverrides).toBe(true)
    expect(resolve(tx(), ann({ amountCentsOverride: 0 }), idx).hasOverrides).toBe(true)
    expect(resolve(tx(), ann({ descriptionOverride: 'x' }), idx).hasOverrides).toBe(true)
    expect(resolve(tx(), ann({ typeOverride: 'internal' }), idx).hasOverrides).toBe(true)
    expect(resolve(tx(), ann({ categoryId: 'cat.pets' }), idx).hasOverrides).toBe(true)
  })

  it('resolves 3,000 rows with a constant number of reads, not one per row', async () => {
    const rows = Array.from({ length: 3000 }, (_, i) =>
      tx({ id: `t${i}`, dedupKey: `K${i}`, fileSeq: i }))
    await db.transactions.bulkAdd(rows)
    await db.annotations.bulkAdd(rows.slice(0, 500).map(r => ann({ transactionId: r.id, note: 'x' })))

    let reads = 0
    // Middleware only takes effect on a fresh open.
    db.close()
    db.use({
      stack: 'dbcore', name: 'count-reads',
      create: down => ({
        ...down,
        table: name => {
          const t = down.table(name)
          return {
            ...t,
            get: r => { reads++; return t.get(r) },
            getMany: r => { reads++; return t.getMany(r) },
            query: r => { reads++; return t.query(r) },
            openCursor: r => { reads++; return t.openCursor(r) },
          }
        },
      }),
    })
    let out: Awaited<ReturnType<typeof resolveMany>>
    try {
      await db.open()
      reads = 0
      out = await resolveMany(rows)
    } finally {
      db.close()
      db.unuse({ stack: 'dbcore', name: 'count-reads' })
      await db.open()
    }

    expect(out).toHaveLength(3000)
    expect(out.every(r => r.categoryId === 'cat.groceries')).toBe(true)
    expect(out.filter(r => r.note === 'x')).toHaveLength(500)
    expect(reads).toBe(3) // one categories query + one settings read (the owner's rules) + one annotations bulk get
  })
})

describe('writeAnnotation', () => {
  beforeEach(async () => { await db.transactions.add(tx()) })

  it('appends one learning event per CHANGED field, in the same transaction', async () => {
    await writeAnnotation('t1', { categoryId: 'cat.restaurants', merchantId: 'm1' }, 'owner')
    const ev = await events()
    expect(ev).toHaveLength(2)
    expect(ev.map(e => e.type).sort()).toEqual(['category', 'merchant'])
    expect(ev.map(payloadOf)).toEqual(expect.arrayContaining([
      { transactionId: 't1', field: 'categoryId', old: 'cat.groceries', new: 'cat.restaurants', oldWasDerived: true, newIsDerived: false, intent: 'correction' },
      { transactionId: 't1', field: 'merchantId', old: null, new: 'm1' },
    ]))
    expect(ev.every(e => e.outcome === null)).toBe(true)
    expect((await db.annotations.get('t1'))?.categoryId).toBe('cat.restaurants')
  })

  it('records the derived category as old, marked derived, when the owner corrects the engine guess', async () => {
    await writeAnnotation('t1', { categoryId: 'cat.restaurants' }, 'owner')
    expect((await events()).map(payloadOf)).toEqual([
      { transactionId: 't1', field: 'categoryId', old: 'cat.groceries', new: 'cat.restaurants', oldWasDerived: true, newIsDerived: false, intent: 'correction' },
    ])
  })

  it('marks the owner endorsing the derived category as a confirmation, not a correction', async () => {
    await writeAnnotation('t1', { categoryId: 'cat.groceries' }, 'owner')
    expect((await events()).map(payloadOf)).toEqual([
      { transactionId: 't1', field: 'categoryId', old: 'cat.groceries', new: 'cat.groceries', oldWasDerived: true, newIsDerived: false, intent: 'confirmation' },
    ])
  })

  it('marks a first assignment as not derived when the ING pair has no category', async () => {
    await db.transactions.add(tx({ id: 't2', dedupKey: 'K2', ingCategory: 'Nueva', ingSubcategory: 'X' }))
    await writeAnnotation('t2', { categoryId: 'cat.pets' }, 'owner')
    expect((await events()).map(payloadOf)).toEqual([
      { transactionId: 't2', field: 'categoryId', old: null, new: 'cat.pets', oldWasDerived: false, newIsDerived: false, intent: 'correction' },
    ])
  })

  it('records the previous stored value as old on a later change', async () => {
    await writeAnnotation('t1', { categoryId: 'cat.restaurants' }, 'owner')
    await writeAnnotation('t1', { categoryId: 'cat.pets' }, 'owner')
    const ev = (await events()).map(payloadOf)
    expect(ev).toHaveLength(2)
    expect(ev).toContainEqual({ transactionId: 't1', field: 'categoryId', old: 'cat.restaurants', new: 'cat.pets', oldWasDerived: false, newIsDerived: false, intent: 'correction' })
  })

  it('maps each tracked field to its event type', async () => {
    await writeAnnotation('t1', {
      categoryId: 'c', merchantId: 'm', dateOverride: '2026-01-01', amountCentsOverride: -5,
      descriptionOverride: 'd', typeOverride: 'income', note: 'n',
    }, 'owner')
    expect((await events()).map(e => e.type).sort())
      .toEqual(['amount', 'category', 'date', 'description', 'kind', 'merchant', 'note'])
  })

  it('writes no event for a field whose value is unchanged', async () => {
    await writeAnnotation('t1', { categoryId: 'cat.pets', note: 'a' }, 'owner')
    await writeAnnotation('t1', { categoryId: 'cat.pets', note: 'b' }, 'owner')
    const ev = (await events()).map(payloadOf)
    expect(ev).toHaveLength(3)
    expect(ev.filter(e => e.field === 'categoryId')).toHaveLength(1)
    // an identical re-save emits nothing at all
    await writeAnnotation('t1', { categoryId: 'cat.pets', note: 'b' }, 'owner')
    expect(await events()).toHaveLength(3)
  })

  it('does not treat an absent annotation as a change when the patch value is null', async () => {
    await writeAnnotation('t1', { categoryId: null }, 'owner')
    expect(await events()).toHaveLength(0)
    expect(await db.annotations.get('t1')).toBeDefined()
  })

  it('writes the annotation but no event for the reviewed workflow flag', async () => {
    await writeAnnotation('t1', { reviewed: true }, 'owner')
    expect(await events()).toHaveLength(0)
    expect(await db.annotations.get('t1')).toMatchObject({ reviewed: true })
  })

  it('records a payment-method correction as exactly one paymentMethod event', async () => {
    await writeAnnotation('t1', { paymentMethod: 'card' }, 'owner')
    await writeAnnotation('t1', { paymentMethod: 'card' }, 'owner') // unchanged: no second event
    const all = await events()
    expect(all.map(e => e.type)).toEqual(['paymentMethod'])
    expect(payloadOf(all[0]!)).toEqual({ transactionId: 't1', field: 'paymentMethod', old: null, new: 'card' })
    await writeAnnotation('t1', { paymentMethod: null }, 'owner')
    expect((await events()).map(payloadOf).at(-1)).toEqual({ transactionId: 't1', field: 'paymentMethod', old: 'card', new: null })
  })

  it('leaves no event for an engine write of the payment method', async () => {
    await writeAnnotation('t1', { paymentMethod: 'card' }, 'engine')
    expect(await events()).toHaveLength(0)
  })

  it('creates a complete annotation row and stamps updatedAt', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(123456)
    await writeAnnotation('t1', { note: 'hi' }, 'owner')
    vi.restoreAllMocks()
    expect(await db.annotations.get('t1')).toEqual(ann({ note: 'hi', updatedAt: 123456 }))
  })

  it('ignores a transactionId smuggled in the patch', async () => {
    await writeAnnotation('t1', { transactionId: 'other', note: 'x' } as Partial<AnnotationRow>, 'owner')
    expect(await db.annotations.get('other')).toBeUndefined()
    expect((await db.annotations.get('t1'))?.note).toBe('x')
  })

  it('rolls back the events when the annotation write fails', async () => {
    // A function cannot be structured-cloned, so the put throws after the event has been added.
    const poison = (() => 1) as unknown as string
    await expect(writeAnnotation('t1', { categoryId: 'cat.pets', paymentMethod: poison }, 'owner')).rejects.toThrow()
    expect(await events()).toHaveLength(0)
    expect(await db.annotations.get('t1')).toBeUndefined()
  })

  it('appends no event for an engine-sourced write, but still writes the annotation', async () => {
    await writeAnnotation('t1', { merchantId: 'm1', paymentMethod: 'card' }, 'engine')
    expect(await events()).toHaveLength(0)
    expect(await db.annotations.get('t1')).toMatchObject({ merchantId: 'm1', paymentMethod: 'card' })
  })

  it('refuses an engine-sourced categoryId (§34.3) and writes nothing', async () => {
    await expect(writeAnnotation('t1', { categoryId: 'cat.pets', note: 'x' }, 'engine')).rejects.toThrow(/34\.3/)
    expect(await db.annotations.count()).toBe(0)
    expect(await events()).toHaveLength(0)
  })

  it('records clearing a stored category as a correction falling back to the derived one', async () => {
    await writeAnnotation('t1', { categoryId: 'cat.pets' }, 'owner')
    await writeAnnotation('t1', { categoryId: null }, 'owner')
    expect((await events()).map(payloadOf)).toContainEqual({
      transactionId: 't1', field: 'categoryId', old: 'cat.pets', oldWasDerived: false,
      new: 'cat.groceries', newIsDerived: true, intent: 'correction',
    })
  })

  it('clearing a stored category on a pair with no mapping falls back to nothing, not derived', async () => {
    await db.transactions.add(tx({ id: 't2', dedupKey: 'K2', ingCategory: 'Nueva', ingSubcategory: 'X' }))
    await writeAnnotation('t2', { categoryId: 'cat.pets' }, 'owner')
    await writeAnnotation('t2', { categoryId: null }, 'owner')
    expect((await events()).map(payloadOf)).toContainEqual({
      transactionId: 't2', field: 'categoryId', old: 'cat.pets', oldWasDerived: false,
      new: null, newIsDerived: false, intent: 'correction',
    })
  })

  it('clearing a stored category equal to the derived one is a confirmation with distinguishing flags', async () => {
    await writeAnnotation('t1', { categoryId: 'cat.groceries' }, 'owner') // stored X, derived also X
    await writeAnnotation('t1', { categoryId: null }, 'owner')
    expect((await events()).map(payloadOf)).toContainEqual({
      transactionId: 't1', field: 'categoryId', old: 'cat.groceries', oldWasDerived: false,
      new: 'cat.groceries', newIsDerived: true, intent: 'confirmation',
    })
  })

  it('emits events for subcategory and the round-up parent override', async () => {
    await writeAnnotation('t1', { subcategoryId: 's1', roundupParentIdOverride: 'p1' }, 'owner')
    expect((await events()).map(e => e.type).sort()).toEqual(['roundupParent', 'subcategory'])
  })

  it('lets roundupParentIdOverride return to "no override" with an explicit undefined', async () => {
    await writeAnnotation('t1', { roundupParentIdOverride: 'p1' }, 'owner')
    await writeAnnotation('t1', { roundupParentIdOverride: undefined }, 'owner')
    const row = await db.annotations.get('t1')
    expect('roundupParentIdOverride' in (row as object)).toBe(false)
    expect(resolve(tx({ roundupParentId: 'bank' }), row, new Map()).roundupParentId).toBe('bank')
    const ev = (await events()).map(payloadOf)
    expect(ev).toHaveLength(2)
    expect(ev.some(e => e.field === 'roundupParentIdOverride' && e.old === 'p1' && e.new === undefined)).toBe(true)
  })

  it('keeps "detached" (null) distinct from "no override" (undefined)', async () => {
    await writeAnnotation('t1', { roundupParentIdOverride: null }, 'owner')
    expect((await db.annotations.get('t1'))?.roundupParentIdOverride).toBeNull()
    const [e] = (await events()).map(payloadOf)
    expect(e?.old).toBeUndefined()
    expect(e?.new).toBeNull()
  })

  it('drops unknown keys instead of persisting them', async () => {
    await writeAnnotation('t1', { note: 'x', bogus: 1 } as Partial<AnnotationRow>, 'owner')
    expect(Object.keys((await db.annotations.get('t1')) as object)).not.toContain('bogus')
  })

  it('refuses a transaction that does not exist, leaving no annotation and no event', async () => {
    await expect(writeAnnotation('ghost', { note: 'x' }, 'owner')).rejects.toThrow(/ghost/)
    expect(await db.annotations.count()).toBe(0)
    expect(await events()).toHaveLength(0)
  })

  it('never touches the transactions table', async () => {
    // The immutability hook throws on any update except deletedAt. Count attempts as well as failures.
    const update = vi.spyOn(db.transactions, 'update')
    const put = vi.spyOn(db.transactions, 'put')
    const add = vi.spyOn(db.transactions, 'add')
    const del = vi.spyOn(db.transactions, 'delete')
    const before = await db.transactions.get('t1')
    await writeAnnotation('t1', {
      categoryId: 'c', dateOverride: '2026-01-01', amountCentsOverride: 1, descriptionOverride: 'd', typeOverride: 'income',
    }, 'owner')
    await writeAnnotation('t1', { note: 'again' }, 'engine')
    for (const spy of [update, put, add, del]) expect(spy).not.toHaveBeenCalled()
    expect(await db.transactions.get('t1')).toEqual(before)
    // and the guard is real: a direct update of a bank field does throw
    await expect(db.transactions.update('t1', { amountCents: 1 })).rejects.toThrow(/immutable/)
  })
})
