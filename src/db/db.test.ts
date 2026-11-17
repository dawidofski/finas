import { describe, it, expect, beforeEach } from 'vitest'
import Dexie from 'dexie'
import { db, createDatabase, SCHEMA_VERSION, ENGINE_VERSION, openDatabase, classifyOpenError } from './db'
import { registerMigration, applyMigrations, resetMigrationsForTest } from './migrations'
import type { TransactionRow, AnnotationRow, AccountRow, CategoryKind, SettingsRow } from './schema'

beforeEach(async () => { await db.delete(); await db.open() })

const tx: TransactionRow = {
  id: 'a', accountId: 'x', valueDate: '2026-11-15', amountCents: -95,
  balanceCents: 9436, description: 'd', comment: null, ingCategory: 'Ocio', ingSubcategory: 'Bares',
  kind: 'spend', dedupKey: 'K', importId: 'i', fileSeq: 1, roundupParentId: null,
  createdAt: 1, deletedAt: null,
}

describe('schema v1', () => {
  it('declares every table from the design', () => {
    expect(db.tables.map(t => t.name).sort()).toEqual([
      'accounts','analyticsCache','annotations','budgetAllocations','categories',
      'imports','learningEvents','merchants','moods','purchaseReasons',
      'recommendationState','recurring','savingsGoals','settings','transactions','transfers',
    ])
  })
  it('opens at the declared version, with schema and engine versions independent', () => {
    expect(db.verno).toBe(SCHEMA_VERSION)
    expect(typeof ENGINE_VERSION).toBe('number')
  })
  it('indexes transactions for the dedup key and the account-date pair', () => {
    const t = db.table('transactions').schema
    const idx = t.indexes.map(i => i.name)
    expect(idx).toContain('dedupKey')
    expect(idx).toContain('[accountId+valueDate]')
    expect(t.indexes.find(i => i.name === 'dedupKey')?.unique).toBe(true)
  })
  it('keys annotations by transactionId', () => {
    expect(db.table('annotations').schema.primKey.name).toBe('transactionId')
  })
  it('enforces uniqueness of the dedup key', async () => {
    await db.transactions.add(tx)
    await expect(db.transactions.add({ ...tx, id: 'b' })).rejects.toThrow()
  })
  it('round-trips a transaction unchanged', async () => {
    await db.transactions.add(tx)
    expect(await db.transactions.get('a')).toEqual(tx)
  })
  it('finds a transaction through the account-date compound index', async () => {
    await db.transactions.bulkAdd([tx, { ...tx, id: 'b', dedupKey: 'K2', valueDate: '2026-11-16' }])
    const hit = await db.transactions.where('[accountId+valueDate]').equals(['x', '2026-11-16']).toArray()
    expect(hit.map(r => r.id)).toEqual(['b'])
  })
  it('stores owner edits in annotations as overrides keyed by transactionId', async () => {
    await db.transactions.add(tx)
    const ann: AnnotationRow = {
      transactionId: 'a', categoryId: 'c1', subcategoryId: null, merchantId: null,
      typeOverride: null, paymentMethod: null, note: null, moodId: null, purchaseReasonId: 'r1',
      worthwhile: null, reviewed: true, dateOverride: '2026-11-14',
      amountCentsOverride: -90, descriptionOverride: 'corrected', updatedAt: 2,
    }
    await db.annotations.put(ann)
    expect(await db.annotations.get('a')).toEqual(ann)
    await expect(db.annotations.add({ ...ann })).rejects.toThrow()
    expect((await db.annotations.where('categoryId').equals('c1').toArray()).map(r => r.transactionId)).toEqual(['a'])
    expect((await db.annotations.where('purchaseReasonId').equals('r1').toArray()).length).toBe(1)
  })
  it('does not index booleans on annotations', () => {
    const idx = db.table('annotations').schema.indexes.map(i => i.name)
    expect(idx).not.toContain('reviewed')
    expect(idx).not.toContain('worthwhile')
  })
  it('keeps the category kind and the transaction kind as distinct types', () => {
    const c: CategoryKind = 'essential'
    // @ts-expect-error 'spend' is a transaction kind, not a category kind
    const bad: CategoryKind = 'spend'
    // @ts-expect-error 'essential' is a category kind, not a transaction kind
    const bad2: TransactionRow['kind'] = 'essential'
    expect([c, bad, bad2]).toHaveLength(3)
  })
  it('stores the privacy settings object with a salt and the last4 switch', async () => {
    const s: SettingsRow = {
      id: 'singleton', theme: 'system', locale: 'es-ES',
      privacy: { accountSalt: 'abc', storeLast4: true },
      moodPrompting: { enabled: true }, deepseek: { enabled: false }, backup: { lastBackupAt: null },
    }
    await db.settings.put(s)
    expect(await db.settings.get('singleton')).toEqual(s)
  })
})

describe('transaction immutability (design 8.1)', () => {
  beforeEach(async () => { await db.transactions.add(tx) })
  it.each([
    ['amountCents', -1], ['valueDate', '2026-01-01'], ['description', 'x'], ['balanceCents', 1],
    ['dedupKey', 'Z'], ['kind', 'income'], ['accountId', 'other'],
  ])('rejects update of %s', async (field, value) => {
    await expect(db.transactions.update('a', { [field]: value })).rejects.toThrow(/immutable/)
    expect(await db.transactions.get('a')).toEqual(tx)
  })
  it('rejects put over an existing row that changes a bank field', async () => {
    await expect(db.transactions.put({ ...tx, amountCents: -1 })).rejects.toThrow(/immutable/)
    expect(await db.transactions.get('a')).toEqual(tx)
  })
  it('rejects Collection.modify on a bank field', async () => {
    await expect(db.transactions.where('id').equals('a').modify({ amountCents: -1 })).rejects.toThrow(/immutable/)
  })
  it('permits deletedAt to be set and cleared (soft delete and restore)', async () => {
    await db.transactions.update('a', { deletedAt: 5 })
    expect((await db.transactions.get('a'))?.deletedAt).toBe(5)
    await db.transactions.update('a', { deletedAt: null })
    expect(await db.transactions.get('a')).toEqual(tx)
  })
  it('cannot find non-deleted rows through the deletedAt index (null is not a key), so it must filter', async () => {
    await db.transactions.add({ ...tx, id: 'd', dedupKey: 'K9', deletedAt: 7 })
    const viaIndex = await db.transactions.where('deletedAt').equals(null as never).toArray().catch(() => 'rejected')
    expect(viaIndex === 'rejected' || (Array.isArray(viaIndex) && viaIndex.length === 0)).toBe(true)
    expect((await db.transactions.filter(r => r.deletedAt === null).toArray()).map(r => r.id)).toEqual(['a'])
    expect((await db.transactions.where('deletedAt').above(0).toArray()).map(r => r.id)).toEqual(['d'])
  })
})

describe('account identity protection', () => {
  const acc: AccountRow = {
    id: 'x', fingerprint: 'f'.repeat(64), label: 'Main', last4: '1234',
    currency: 'EUR', createdAt: 1, archived: false,
  }
  it('stores a fingerprint and last4', async () => {
    await db.accounts.add(acc)
    expect(await db.accounts.get('x')).toEqual(acc)
  })
  it('refuses a field that could carry an account number or holder name', async () => {
    await expect(db.accounts.add({ ...acc, iban: 'ES0099990418450200051332' } as never)).rejects.toThrow(/not allowed/)
    await expect(db.accounts.add({ ...acc, holderName: 'Jane Doe' } as never)).rejects.toThrow(/not allowed/)
  })
  it('refuses a last4 that is longer than four digits', async () => {
    await expect(db.accounts.add({ ...acc, last4: '99990418450200051332' })).rejects.toThrow(/last4/)
  })
  it('accepts ordinary labels that contain digits', async () => {
    const labels = ['Cuenta 5566', 'Ahorro 2026', 'AB12 Ahorro vacaciones', '2026 2027 2028', 'Plan 2026-2027-2028']
    for (const [i, label] of labels.entries()) {
      await db.accounts.add({ ...acc, id: `l${i}`, fingerprint: String(i).repeat(64), label })
    }
    expect(await db.accounts.count()).toBe(labels.length)
  })
  it('still refuses long digit runs, however separated', async () => {
    for (const [i, label] of ['99990418450200051332', '999904184502', '9999 0418 4502 0005 1332', '9999-0418-4502-0005-1332', '4111 1111 1111 1111'].entries()) {
      await expect(db.accounts.add({ ...acc, id: `r${i}`, fingerprint: String(i).repeat(64), label })).rejects.toThrow(/account number/)
    }
  })
  it('refuses an IBAN in fingerprint, currency or id', async () => {
    await expect(db.accounts.add({ ...acc, id: 'q', fingerprint: 'ES0099990418450200051332' })).rejects.toThrow(/fingerprint/)
    await expect(db.accounts.add({ ...acc, id: 'q', fingerprint: 'F'.repeat(64) })).rejects.toThrow(/fingerprint/)
    await expect(db.accounts.add({ ...acc, id: 'q', currency: 'ES0099990418450200051332' })).rejects.toThrow(/currency/)
    await expect(db.accounts.add({ ...acc, id: 'ES0099990418450200051332' })).rejects.toThrow(/account number/)
  })
  it('refuses an IBAN in createdAt or archived', async () => {
    await expect(db.accounts.add({ ...acc, id: 'q', createdAt: 'ES0099990418450200051332' as never })).rejects.toThrow(/createdAt/)
    await expect(db.accounts.add({ ...acc, id: 'q', archived: 'ES0099990418450200051332' as never })).rejects.toThrow(/archived/)
    await db.accounts.add(acc)
    await expect(db.accounts.update('x', { createdAt: 'ES0099990418450200051332' as never })).rejects.toThrow(/createdAt/)
    await expect(db.accounts.update('x', { archived: 'ES0099990418450200051332' as never })).rejects.toThrow(/archived/)
  })
  it('requires fingerprint and currency on create, and rejects explicit undefined on update', async () => {
    const { fingerprint: _f, ...noFp } = acc
    const { currency: _c, ...noCur } = acc
    await expect(db.accounts.add(noFp as never)).rejects.toThrow(/fingerprint/)
    await expect(db.accounts.add(noCur as never)).rejects.toThrow(/currency/)
    await db.accounts.add(acc)
    await expect(db.accounts.update('x', { fingerprint: undefined })).rejects.toThrow(/fingerprint/)
    await expect(db.accounts.update('x', { currency: undefined })).rejects.toThrow(/currency/)
    expect(await db.accounts.get('x')).toEqual(acc)
  })
  describe('every write path', () => {
    const bad = { ...acc, id: 'y', fingerprint: 'e'.repeat(64), label: 'ES00 9999 0418 4502 0005 1332' }
    beforeEach(async () => { await db.accounts.add(acc) })
    it('put (new row)', async () => { await expect(db.accounts.put(bad)).rejects.toThrow(/account number/) })
    it('put over an existing row', async () => {
      await expect(db.accounts.put({ ...acc, label: 'ES00 9999 0418 4502 0005 1332' })).rejects.toThrow(/account number/)
      expect((await db.accounts.get('x'))?.label).toBe('Main')
    })
    it('update with a partial iban', async () => {
      await expect(db.accounts.update('x', { iban: 'ES0099990418450200051332' } as never)).rejects.toThrow(/not allowed/)
    })
    it('update with a bad label', async () => {
      await expect(db.accounts.update('x', { label: '9999 0418 4502 0005 1332' })).rejects.toThrow(/account number/)
    })
    it('bulkAdd', async () => { await expect(db.accounts.bulkAdd([bad])).rejects.toThrow(/account number/) })
    it('bulkPut', async () => { await expect(db.accounts.bulkPut([bad])).rejects.toThrow(/account number/) })
    it('Collection.modify', async () => {
      await expect(db.accounts.where('id').equals('x').modify({ holderName: 'Jane Doe' } as never)).rejects.toThrow(/not allowed/)
      expect(await db.accounts.get('x')).toEqual(acc)
    })
  })
  it('refuses an IBAN placed in the label', async () => {
    await expect(db.accounts.add({ ...acc, label: 'ES00 9999 0418 4502 0005 1332' })).rejects.toThrow(/account number/)
  })
})

const ABSENT = Symbol('absent')
async function withIndexedDB<T>(replacement: unknown, fn: () => Promise<T>): Promise<T> {
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB')
  try {
    if (replacement === ABSENT) Reflect.deleteProperty(globalThis, 'indexedDB')
    else Object.defineProperty(globalThis, 'indexedDB', { value: replacement, configurable: true, writable: true })
    return await fn()
  } finally {
    if (desc) Object.defineProperty(globalThis, 'indexedDB', desc)
  }
}

describe('openDatabase', () => {
  it('reports ok when storage works', async () => {
    expect(await openDatabase()).toEqual({ ok: true })
  })
  it('reports blocked rather than throwing when indexedDB is denied', async () => {
    db.close()
    const denied = { open: () => { throw new DOMException('denied', 'SecurityError') } }
    const result = await withIndexedDB(denied, () => openDatabase())
    expect(result).toMatchObject({ ok: false, reason: 'blocked' })
    expect((result as { detail: string }).detail).toContain('SecurityError')
  })
  it('reports unsupported when indexedDB is absent', async () => {
    const result = await withIndexedDB(ABSENT, () => openDatabase())
    expect(result).toMatchObject({ ok: false, reason: 'unsupported' })
  })
})

describe('classifyOpenError', () => {
  const named = (name: string) => Object.assign(new Error(name), { name })
  it.each([
    ['SecurityError', 'blocked'], ['InvalidStateError', 'blocked'], ['MissingAPIError', 'blocked'],
    ['VersionError', 'corrupt'], ['DatabaseClosedError', 'corrupt'],
    ['QuotaExceededError', 'unknown'], ['UnknownError', 'unknown'],
  ])('maps %s to %s', (name, reason) => {
    expect(classifyOpenError(named(name))).toMatchObject({ ok: false, reason })
  })
  it('falls back to unknown, never corrupt, with the message for an unrecognised error', () => {
    expect(classifyOpenError(new Error('boom'))).toEqual({ ok: false, reason: 'unknown', detail: 'boom' })
  })
})

describe('migration registry', () => {
  beforeEach(() => resetMigrationsForTest())

  it('derives SCHEMA_VERSION from the highest registered migration', () => {
    expect(SCHEMA_VERSION).toBe(1)
    registerMigration(4, async () => {})
    registerMigration(2, async () => {})
    expect(SCHEMA_VERSION).toBe(4)
  })
  it('throws when registering after the database has been opened', async () => {
    expect(await openDatabase()).toEqual({ ok: true })
    expect(() => registerMigration(2, async () => {})).toThrow(/already been opened/)
    expect(SCHEMA_VERSION).toBe(1)
  })

  it('is empty at v1 and applies nothing', () => {
    const d = new Dexie('mig-empty')
    d.version(1).stores({ t: 'id' })
    expect(() => applyMigrations(d)).not.toThrow()
    expect(d.verno).toBe(1)
  })
  it('rejects versions that are not integers above 1, and duplicates', () => {
    expect(() => registerMigration(1, async () => {})).toThrow()
    expect(() => registerMigration(2.5, async () => {})).toThrow()
    registerMigration(2, async () => {})
    expect(() => registerMigration(2, async () => {})).toThrow(/already/)
  })
  it('runs registered upgrades in version order on an existing v1 database', async () => {
    const name = 'mig-upgrade'
    await Dexie.delete(name)
    const v1 = new Dexie(name)
    v1.version(1).stores({ t: 'id' })
    await v1.open()
    await v1.table('t').add({ id: 'r', n: 1 })
    v1.close()

    registerMigration(3, async t => { await t.table('t').toCollection().modify({ n: 2 }) })
    registerMigration(2, async t => { await t.table('t').toCollection().modify({ seen2: true }) })
    const v3 = new Dexie(name)
    v3.version(1).stores({ t: 'id' })
    applyMigrations(v3)
    await v3.open()
    expect(v3.verno).toBe(3)
    expect(await v3.table('t').get('r')).toEqual({ id: 'r', n: 2, seen2: true })
    v3.close()
    await Dexie.delete(name)
  })
})

describe('migration with a stores change', () => {
  beforeEach(() => resetMigrationsForTest())
  it('adds a table and an index that are usable after open', async () => {
    const name = 'mig-stores'
    await Dexie.delete(name)
    const v1 = new Dexie(name)
    v1.version(1).stores({ t: 'id' })
    await v1.open()
    v1.close()
    registerMigration(2, async () => {}, { extra: 'id, tag', t: 'id, n' })
    const v2 = new Dexie(name)
    v2.version(1).stores({ t: 'id' })
    applyMigrations(v2)
    await v2.open()
    await v2.table('extra').add({ id: 'e', tag: 'x' })
    await v2.table('t').add({ id: 'r', n: 3 })
    expect((await v2.table('extra').where('tag').equals('x').toArray()).length).toBe(1)
    expect((await v2.table('t').where('n').equals(3).toArray()).length).toBe(1)
    v2.close()
    await Dexie.delete(name)
  })
})

describe('guards survive migrations on any path that opens a database', () => {
  const name = 'finance-guard-test'
  beforeEach(async () => { resetMigrationsForTest(); await Dexie.delete(name) })

  async function expectGuarded(d: ReturnType<typeof createDatabase>) {
    await expect(d.accounts.add({ id: 'g', fingerprint: 'a'.repeat(64), label: 'ok', last4: null, currency: 'EUR', createdAt: 1, archived: false, iban: 'ES0099990418450200051332' } as never)).rejects.toThrow(/not allowed/)
    await d.transactions.add(tx)
    await expect(d.transactions.update('a', { amountCents: -1 })).rejects.toThrow(/immutable/)
  }

  it('after a migration applied and opened through openDatabase-style steps', async () => {
    registerMigration(2, async () => {})
    const d = createDatabase(name)
    applyMigrations(d)
    await d.open()
    expect(d.verno).toBe(2)
    await expectGuarded(d)
    d.close()
  })
  it('when the database is opened directly, bypassing openDatabase, migrations still apply (open() override)', async () => {
    registerMigration(2, async () => {})
    registerMigration(3, async () => {}, { extra: 'id' })
    const d = createDatabase(name)
    await d.open() // no applyMigrations call: open() itself must do it
    expect(d.verno).toBe(3)
    expect(d.tables.map(t => t.name)).toContain('extra')
    await expectGuarded(d)
    d.close()
  })
  it('an auto-open triggered by a plain query also applies migrations (no silent downgrade)', async () => {
    registerMigration(2, async () => {})
    const d = createDatabase(name)
    await d.transaction('r', 'settings', async () => {}) // first touch, never an explicit open()
    expect(d.verno).toBe(2)
    d.close()
  })
  it('registering a migration after any direct open is refused rather than silently ignored', async () => {
    const d = createDatabase(name)
    await d.open()
    expect(() => registerMigration(2, async () => {})).toThrow(/already been opened/)
    d.close()
  })
  it('after the database is closed and reopened', async () => {
    const d = createDatabase(name)
    await d.open()
    d.close()
    await d.open()
    await expectGuarded(d)
    d.close()
  })
})
