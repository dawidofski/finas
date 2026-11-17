import { describe, it, expect, beforeEach } from 'vitest'
import { db } from './db'
import { seedDatabase, getSettings } from './seed'
import { exportBundle, restoreBundle, inspectBundle, TABLE_INTRODUCED_IN, omittableTables } from './backup'
import { registerMigration, resetMigrationsForTest } from './migrations'
import type { TransactionRow } from './schema'

beforeEach(async () => { resetMigrationsForTest(); await db.delete(); await db.open() })

const tx = (n: number): TransactionRow => ({
  id: `tx.${n}`, accountId: 'acc.1', valueDate: `2026-11-0${n}`, amountCents: -1245 * n, balanceCents: 100_000 - n,
  description: `Shop ${n}`, comment: null, ingCategory: 'Compras', ingSubcategory: 'Compras (otros)', kind: 'spend',
  dedupKey: `dedup-${n}`, importId: 'imp.1', fileSeq: n, roundupParentId: null, createdAt: 1_700_000_000_000, deletedAt: null,
})
const cache = (key: string) => ({ key, engineVersion: 1, inputsHash: 'h', computedAt: 1, payload: { n: 1 } })
const snapshot = async () => ({ ...(await exportBundle()), exportedAt: '' })

type Edit = Record<string, unknown>
const find = (rows: unknown[] | undefined, key: string, id: string) => rows!.find(r => (r as Edit)[key] === id) as Edit

describe('merge is additive: local always wins (design 31.2)', () => {
  async function editedLocalState() {
    await seedDatabase()
    await db.table('transactions').bulkAdd([tx(1), tx(2)])
    await db.table('categories').update('cat.groceries', { kind: 'discretionary' }) // an owner edit
    await db.table('merchants').add({ id: 'm.1', canonicalName: 'Supermercado Ejemplo', kind: 'shop', matchPatterns: ['SUPERMERCADO'], defaultCategoryId: null, isSubscription: false, createdAt: 1 })
    await db.table('budgetAllocations').add({ id: 'b.1', categoryId: 'cat.groceries', savingsGoalId: null, percentBp: 3000, fixedCents: null, effectiveFrom: '2026-01-01', note: null })
    await db.table('recommendationState').add({ key: 'r.1', status: 'rejected', shownCount: 3, rejectedCount: 2, lastShownAt: 5, suppressedUntil: null, evidenceFingerprint: null })
  }
  /** An older backup: same keys with the pre-edit values, plus rows the device lacks. */
  async function olderBackup() {
    const b = await exportBundle()
    find(b.tables.categories, 'id', 'cat.groceries').kind = 'essential'
    ;(b.tables.merchants![0] as Edit).matchPatterns = ['OLD']
    ;(b.tables.budgetAllocations![0] as Edit).percentBp = 1000
    Object.assign(b.tables.recommendationState![0] as Edit, { rejectedCount: 0, status: 'shown' })
    b.tables.transactions!.push(tx(9)) // what the owner is recovering
    b.tables.categories!.push({ id: 'cat.extra', name: 'Extra', parentId: null, kind: 'essential', isUserCreated: true, ingMappings: [] })
    return b
  }

  it('keeps every locally edited row, writes only absent keys, and lists each conflict', async () => {
    await editedLocalState()
    const bundle = await olderBackup()
    const dry = await inspectBundle(bundle, 'merge')
    const real = await restoreBundle(bundle, 'merge')
    expect(real).toEqual(dry)
    expect(real.ok).toBe(true)
    expect([...real.conflictRows!].sort()).toEqual(['budgetAllocations:b.1', 'categories:cat.groceries', 'merchants:m.1', 'recommendationState:r.1'])
    expect(real.perTable.categories).toMatchObject({ willWrite: 1, conflicts: 1 }) // cat.extra is new; cat.groceries would have been reverted
    expect(real.perTable.transactions).toMatchObject({ incoming: 3, willWrite: 1, conflicts: 0 })
    for (const t of ['merchants', 'budgetAllocations', 'recommendationState']) {
      expect(real.perTable[t]).toMatchObject({ willWrite: 0, conflicts: 1 })
    }
    expect((await db.table('categories').get('cat.groceries'))!.kind).toBe('discretionary')
    expect((await db.table('merchants').get('m.1'))!.matchPatterns).toEqual(['SUPERMERCADO'])
    expect((await db.table('budgetAllocations').get('b.1'))!.percentBp).toBe(3000)
    expect(await db.table('recommendationState').get('r.1')).toMatchObject({ status: 'rejected', rejectedCount: 2 })
    expect(await db.table('transactions').get('tx.9')).toBeDefined()
    expect(await db.table('categories').get('cat.extra')).toBeDefined()
  })

  it('identical rows are neither new nor conflicts, so willWrite cannot hide a reverted edit', async () => {
    await editedLocalState()
    const report = await inspectBundle(await exportBundle(), 'merge')
    expect(report.conflictRows).toBeUndefined()
    for (const t of Object.values(report.perTable)) expect(t).toMatchObject({ willWrite: 0, conflicts: 0 })
  })

  it('replace still makes the device match the backup', async () => {
    await editedLocalState()
    const bundle = await olderBackup()
    expect((await restoreBundle(bundle, 'replace')).ok).toBe(true)
    expect((await db.table('categories').get('cat.groceries'))!.kind).toBe('essential')
    expect((await db.table('recommendationState').get('r.1'))!.rejectedCount).toBe(0)
  })
})

describe('derived data and reference data across a restore', () => {
  it.each(['merge', 'replace'] as const)('%s clears analyticsCache, local and incoming alike (design 31.3)', async mode => {
    await seedDatabase()
    await db.table('analyticsCache').add(cache('local'))
    const bundle = await exportBundle()
    bundle.tables.analyticsCache = [cache('local'), cache('incoming')]
    const dry = await inspectBundle(bundle, mode)
    expect(dry.perTable.analyticsCache).toMatchObject({ incoming: 2, willWrite: 0 })
    expect((await restoreBundle(bundle, mode)).ok).toBe(true)
    expect(await db.table('analyticsCache').count()).toBe(0)
  })

  it('a refused restore leaves the cache alone', async () => {
    await seedDatabase()
    await db.table('analyticsCache').add(cache('local'))
    expect((await restoreBundle({ format: 'nope' }, 'replace')).ok).toBe(false)
    expect(await db.table('analyticsCache').count()).toBe(1)
  })

  it('re-seeds reference data after a replace whose backup lacked it', async () => {
    await getSettings() // settings only: no categories, moods or reasons
    const bundle = await exportBundle()
    await seedDatabase()
    expect((await restoreBundle(bundle, 'replace')).ok).toBe(true)
    expect(await db.table('categories').count()).toBeGreaterThan(0)
    expect(await db.table('moods').count()).toBeGreaterThan(0)
    expect(await db.table('purchaseReasons').count()).toBeGreaterThan(0)
  })
})

describe('schema-version gates (design 29)', () => {
  it('lists every live table in TABLE_INTRODUCED_IN, and nothing else', () => {
    expect(Object.keys(TABLE_INTRODUCED_IN).sort()).toEqual(db.tables.map(t => t.name).sort())
    expect(Object.values(TABLE_INTRODUCED_IN).every(v => Number.isInteger(v) && v >= 1)).toBe(true)
  })

  it('permits omitting only a table introduced after the bundle version', () => {
    const names = ['accounts', 'transactions', 'newer', 'settings']
    expect(omittableTables(1, names).size).toBe(0) // existing tables at v1, and an unmapped name, are never omittable
    TABLE_INTRODUCED_IN.newer = 2
    try {
      expect([...omittableTables(1, names)]).toEqual(['newer'])
      expect(omittableTables(2, names).size).toBe(0)
    } finally { delete TABLE_INTRODUCED_IN.newer }
  })

  it('exportBundle stamps the version of the open database', async () => {
    expect((await exportBundle()).schemaVersion).toBe(db.verno)
  })

  it('refuses a bundle older than the current schema, in both modes, and changes nothing', async () => {
    await seedDatabase()
    const before = await snapshot()
    const old = await exportBundle() // a complete, otherwise valid v1 bundle
    resetMigrationsForTest() // unseal: the app is now at schema 2 as far as the registry goes; the open db is untouched
    registerMigration(2, async () => {})
    for (const mode of ['merge', 'replace'] as const) {
      for (const report of [await inspectBundle(old, mode), await restoreBundle(old, mode)]) {
        expect(report).toMatchObject({ ok: false, refusedReason: 'older-schema' })
        expect(report.detail).toMatch(/older version/)
      }
    }
    expect(await snapshot()).toEqual(before)
  })
})
