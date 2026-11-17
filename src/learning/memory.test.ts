import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { db } from '../db/db'
import { seedDatabase } from '../db/seed'
import { writeAnnotation } from '../db/annotations'
import type { LearningEventRow, MerchantRow, TransactionRow } from '../db/schema'
import { categoryMemory, rememberedCategoryFor } from './memory'

const tx = (id: string, over: Partial<TransactionRow> = {}): TransactionRow => ({
  id, accountId: 'acc', valueDate: '2026-11-15', amountCents: -1250,
  balanceCents: 50000, description: 'SHOP', comment: null,
  ingCategory: null, ingSubcategory: null,
  kind: 'spend', dedupKey: `K${id}`, importId: 'imp', fileSeq: 1, roundupParentId: null,
  createdAt: 1, deletedAt: null, ...over,
})

/** A category correction through the real write path, with a merchant attached. */
const correct = (id: string, categoryId: string, merchantId = 'm1') =>
  writeAnnotation(id, { categoryId, merchantId }, 'owner')

let clock = 1000
beforeEach(async () => {
  vi.restoreAllMocks()
  await db.delete(); await db.open(); await seedDatabase()
  clock = 1000
  // Distinct, increasing event times so "latest" is unambiguous.
  vi.spyOn(Date, 'now').mockImplementation(() => (clock += 10))
  await db.transactions.bulkAdd([tx('t1'), tx('t2'), tx('t3'), tx('t4')])
})

/** Reads of the event log: a method call on the table, or the dynamic accessor `db.table('learningEvents')` in any form. */
const readsLearningEvents = (text: string): boolean =>
  /table\(\s*['"`]learningEvents['"`]/.test(text) ||
  /learningEvents\s*\.\s*(toArray|where|orderBy|filter|each|get|bulkGet|count|toCollection|reverse|limit|offset|first|last|keys|primaryKeys)\b/.test(text)

describe('the learningEvents read detector', () => {
  it('flags reads, including the dynamic accessor, and ignores writes', () => {
    expect(readsLearningEvents('db.learningEvents.toArray()')).toBe(true)
    expect(readsLearningEvents("db.learningEvents\n  .where('type')")).toBe(true)
    expect(readsLearningEvents("db.table('learningEvents').toArray()")).toBe(true)
    expect(readsLearningEvents('db.table( "learningEvents" )')).toBe(true)
    expect(readsLearningEvents('db.learningEvents.bulkAdd(events)')).toBe(false)
    expect(readsLearningEvents("db.transaction('rw', db.learningEvents, async () => {})")).toBe(false)
  })
})

describe('categoryMemory', () => {
  it('returns nothing for an empty log (the normal first experience)', async () => {
    const m = await categoryMemory()
    expect(m.size).toBe(0)
    expect(rememberedCategoryFor('m1', m)).toBeNull()
  })

  it('returns nothing after one correction and the category after two', async () => {
    await correct('t1', 'groceries')
    expect(rememberedCategoryFor('m1', await categoryMemory())).toBeNull()
    await correct('t2', 'groceries')
    expect(rememberedCategoryFor('m1', await categoryMemory())).toBe('groceries')
  })

  it('counts the owner latest intent per transaction, not every event in the log', async () => {
    await correct('t1', 'groceries')
    await correct('t1', 'transport')
    expect(await db.learningEvents.where('type').equals('category').count()).toBe(2)
    const m = await categoryMemory()
    expect(m.get('m1')).toMatchObject({ categoryId: 'transport', corrections: 1 })
    expect(rememberedCategoryFor('m1', m)).toBeNull()
    // A second transaction to Transport makes two corrections for Transport; Groceries holds none.
    await correct('t2', 'transport')
    expect(rememberedCategoryFor('m1', await categoryMemory())).toBe('transport')
  })

  it('breaks a tie between two categories by the most recent correction', async () => {
    await correct('t1', 'groceries')
    await correct('t2', 'groceries')
    await correct('t3', 'transport')
    await correct('t4', 'transport') // 2 v 2; transport is the most recent
    expect((await categoryMemory()).get('m1')).toMatchObject({ categoryId: 'transport', corrections: 2 })
  })

  it('prefers the category with more corrections over a more recent one', async () => {
    await correct('t1', 'groceries')
    await correct('t2', 'groceries')
    await correct('t3', 'transport')
    expect((await categoryMemory()).get('m1')).toMatchObject({ categoryId: 'groceries', corrections: 2 })
  })

  it('resolves two same-time events for one transaction identically whatever order they are read in', async () => {
    await writeAnnotation('t1', { merchantId: 'm1' }, 'engine')
    const ev = (id: string, categoryId: string): LearningEventRow => ({
      id, at: 5000, type: 'category', outcome: null,
      payload: { transactionId: 't1', field: 'categoryId', old: null, new: categoryId, intent: 'correction' },
    })
    await db.learningEvents.bulkAdd([ev('a', 'groceries'), ev('b', 'transport')])
    const stored = await db.learningEvents.toArray()
    const spy = vi.spyOn(db.learningEvents, 'toArray')
    spy.mockResolvedValue(stored)
    const forward = (await categoryMemory()).get('m1')
    spy.mockResolvedValue([...stored].reverse())
    const backward = (await categoryMemory()).get('m1')
    expect(forward).toMatchObject({ categoryId: 'transport' })
    expect(backward).toEqual(forward)
  })

  it('ignores events for a transaction that has since been soft-deleted', async () => {
    await correct('t1', 'groceries')
    await correct('t2', 'groceries')
    await db.transactions.update('t2', { deletedAt: 5 })
    expect(rememberedCategoryFor('m1', await categoryMemory())).toBeNull()
  })

  it('does not count a confirmation as a correction', async () => {
    await correct('t1', 'groceries')
    await db.learningEvents.add({
      id: 'conf', at: 9000, type: 'category', outcome: null,
      payload: { transactionId: 't2', field: 'categoryId', old: 'groceries', new: 'groceries', intent: 'confirmation' },
    })
    await writeAnnotation('t2', { merchantId: 'm1' }, 'engine')
    expect((await categoryMemory()).get('m1')).toMatchObject({ corrections: 1 })
  })

  it('skips corrections on a transaction with no merchant', async () => {
    await writeAnnotation('t1', { categoryId: 'groceries' }, 'owner')
    await writeAnnotation('t2', { categoryId: 'groceries' }, 'owner')
    expect((await categoryMemory()).size).toBe(0)
  })

  it('skips malformed and legacy payloads instead of crashing', async () => {
    await correct('t1', 'groceries')
    // t2 has a merchant, so a malformed event naming it would be counted if it were not rejected.
    await writeAnnotation('t2', { merchantId: 'm1' }, 'engine')
    const bad =(id: string, payload: unknown): LearningEventRow => ({ id, at: 9000, type: 'category', payload, outcome: null })
    await db.learningEvents.bulkAdd([
      bad('b1', null), bad('b2', 'text'), bad('b3', {}), bad('b4', { new: 'groceries' }),
      bad('b5', { transactionId: 't2', new: 42 }),
    ])
    expect((await categoryMemory()).get('m1')).toMatchObject({ categoryId: 'groceries', corrections: 1 })
  })

  describe('merchant pattern fallback', () => {
    const merchant = (id: string, pattern: string): MerchantRow => ({
      id, canonicalName: id, kind: 'merchant', matchPatterns: [pattern], defaultCategoryId: null, isSubscription: false, createdAt: 1,
    })
    beforeEach(async () => {
      await db.merchants.bulkAdd([merchant('uno', 'TIENDA UNO'), merchant('sol', 'FARMACIA SOL')])
      await db.transactions.bulkDelete(['t1', 't2', 't3', 't4'])
      await db.transactions.bulkAdd([
        tx('t1', { description: 'COMPRA TIENDA UNO MADRID' }), tx('t2', { description: 'TIENDA UNO BARCELONA' }),
        tx('t3', { description: 'COMPRA TIENDA UNO VALENCIA' }), tx('t4', { description: 'UNRELATED PLACE 99' }),
      ])
    })
    const noMerchant = (id: string, categoryId: string) => writeAnnotation(id, { categoryId }, 'owner')

    it('attributes corrections on rows with no stored merchant to the merchant whose pattern matches', async () => {
      await noMerchant('t1', 'groceries')
      await noMerchant('t2', 'groceries')
      // The premise of this test: neither row carries a merchant, so only the fallback can attribute them.
      expect((await db.annotations.bulkGet(['t1', 't2'])).map(a => a?.merchantId)).toEqual([null, null])
      expect(rememberedCategoryFor('uno', await categoryMemory())).toBe('groceries')
    })

    it('lets a stored merchantId win over a pattern that matches a different merchant', async () => {
      await writeAnnotation('t1', { categoryId: 'groceries', merchantId: 'sol' }, 'owner')
      await writeAnnotation('t2', { categoryId: 'groceries', merchantId: 'sol' }, 'owner')
      const m = await categoryMemory()
      expect(m.get('sol')).toMatchObject({ categoryId: 'groceries', corrections: 2 })
      expect(m.has('uno')).toBe(false)
    })

    it('uses the bank description, not a description override', async () => {
      await writeAnnotation('t4', { categoryId: 'groceries', descriptionOverride: 'TIENDA UNO' }, 'owner')
      await noMerchant('t1', 'groceries')
      expect((await categoryMemory()).get('uno')).toMatchObject({ corrections: 1 })
    })

    it('still skips a row that matches no pattern and has no stored merchant', async () => {
      await noMerchant('t4', 'groceries')
      await noMerchant('t1', 'groceries')
      const m = await categoryMemory()
      expect([...m.keys()]).toEqual(['uno'])
      expect(m.get('uno')).toMatchObject({ corrections: 1 })
    })

    it('reads db.merchants once per call, not once per event', async () => {
      await noMerchant('t1', 'groceries')
      await noMerchant('t2', 'groceries')
      await noMerchant('t3', 'groceries')
      const spy = vi.spyOn(db.merchants, 'toArray')
      await categoryMemory()
      expect(spy).toHaveBeenCalledTimes(1)
    })

    it('reads no merchants at all when the caller supplies the list, and matches against that list', async () => {
      await noMerchant('t1', 'groceries')
      await noMerchant('t2', 'groceries')
      const spy = vi.spyOn(db.merchants, 'toArray')
      const m = await categoryMemory([merchant('other', 'TIENDA UNO')])
      expect(spy).not.toHaveBeenCalled()
      expect(rememberedCategoryFor('other', m)).toBe('groceries')
      expect(m.has('uno')).toBe(false)
    })
  })

  it('scans the log once, and is the only module that reads learningEvents', async () => {
    await correct('t1', 'groceries')
    await correct('t2', 'groceries')
    const spy = vi.spyOn(db.learningEvents, 'toArray')
    await categoryMemory()
    expect(spy).toHaveBeenCalledTimes(1)

    const src = resolve(import.meta.dirname, '..')
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap(e =>
      e.isDirectory() ? walk(join(d, e.name)) : /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [join(d, e.name)] : [])
    const files = walk(src)
    expect(files.length).toBeGreaterThan(40)
    const readers = files.filter(f => !f.endsWith(join('learning', 'memory.ts')) && readsLearningEvents(readFileSync(f, 'utf8')))
    expect(readers).toEqual([])
  })
})
