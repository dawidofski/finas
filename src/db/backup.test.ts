import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { db, SCHEMA_VERSION } from './db'
import { seedDatabase, getSettings } from './seed'
import { exportBundle, restoreBundle, inspectBundle } from './backup'
import type { AccountRow, TransactionRow, AnnotationRow } from './schema'

beforeEach(async () => { await db.delete(); await db.open() })
afterEach(() => { vi.restoreAllMocks() })

const hex = (c: string) => c.repeat(64)
const account = (n: number): AccountRow => ({
  id: `acc.${n}`, fingerprint: hex(String(n)), label: `Cuenta ${n}`, last4: null, currency: 'EUR', createdAt: 1_700_000_000_000 + n, archived: false,
})
const tx = (n: number, over: Partial<TransactionRow> = {}): TransactionRow => ({
  id: `tx.${n}`, accountId: 'acc.1', valueDate: `2026-11-0${n}`, amountCents: -1245 * n, balanceCents: 100_000 - n,
  description: `Shop ${n}`, comment: null, ingCategory: 'Compras', ingSubcategory: 'Compras (otros)', kind: 'spend',
  dedupKey: `dedup-${n}`, importId: 'imp.1', fileSeq: n, roundupParentId: null, createdAt: 1_700_000_000_000, deletedAt: null, ...over,
})
const annotation = (n: number, over: Partial<AnnotationRow> = {}): AnnotationRow => ({
  transactionId: `tx.${n}`, categoryId: null, subcategoryId: null, merchantId: null, typeOverride: null, paymentMethod: null,
  note: null, moodId: null, purchaseReasonId: null, worthwhile: null, reviewed: false, dateOverride: null,
  amountCentsOverride: null, descriptionOverride: null, updatedAt: 1_700_000_000_000, ...over,
})

async function populate() {
  await seedDatabase()
  await db.table('accounts').bulkAdd([account(1), account(2)])
  await db.table('transactions').bulkAdd([1, 2, 3, 4, 5].map(n => tx(n)))
  await db.table('annotations').bulkAdd([1, 2, 3].map(n => annotation(n, { note: `note ${n}` })))
}

/** Everything in the database, ignoring only the export timestamp. */
const snapshot = async () => { const b = await exportBundle(); return { ...b, exportedAt: '' } }

describe('export/restore', () => {
  it('exports every live table, not a fixed list', async () => {
    const bundle = await exportBundle()
    expect(Object.keys(bundle.tables).sort()).toEqual(db.tables.map(t => t.name).sort())
    expect(bundle.schemaVersion).toBe(SCHEMA_VERSION)
    expect(bundle.format).toBe('finance-export')
  })

  it('round-trips every table byte-for-byte', async () => {
    await populate()
    const bundle = await exportBundle()
    expect(bundle.tables.accounts).toHaveLength(2)
    expect(bundle.tables.transactions).toHaveLength(5)
    expect(bundle.tables.annotations).toHaveLength(3)
    await db.delete(); await db.open()
    const report = await restoreBundle(bundle, 'replace')
    expect(report.ok).toBe(true)
    expect(await exportBundle()).toEqual({ ...bundle, exportedAt: expect.any(String) })
  })

  it('survives a JSON text round trip (what a file on disk is)', async () => {
    await populate()
    const bundle = await exportBundle()
    const fromFile = JSON.parse(JSON.stringify(bundle)) as unknown
    await db.delete(); await db.open()
    expect((await restoreBundle(fromFile, 'replace')).ok).toBe(true)
    expect(await snapshot()).toEqual({ ...bundle, exportedAt: '' })
  })

  it('carries the account salt through a restore onto a fresh install', async () => {
    const original = (await getSettings()).privacy.accountSalt
    expect(original.length).toBeGreaterThan(8)
    const bundle = await exportBundle()
    expect((bundle.tables.settings![0] as { privacy: { accountSalt: string } }).privacy.accountSalt).toBe(original)
    await db.delete(); await db.open()
    const fresh = (await getSettings()).privacy.accountSalt // a reinstalled browser makes its own salt
    expect(fresh).not.toBe(original)
    await restoreBundle(bundle, 'replace')
    expect((await getSettings()).privacy.accountSalt).toBe(original)
  })

  it('replace removes local rows that are not in the bundle', async () => {
    await populate()
    const bundle = await exportBundle()
    await db.table('transactions').add(tx(9))
    await db.table('annotations').add(annotation(9))
    expect((await restoreBundle(bundle, 'replace')).ok).toBe(true)
    expect(await snapshot()).toEqual({ ...bundle, exportedAt: '' })
  })

  it('merge adds missing rows and keeps local-only rows', async () => {
    await populate()
    const bundle = await exportBundle()
    await db.table('transactions').add(tx(9))
    bundle.tables.transactions!.push(tx(7))
    const report = await restoreBundle(bundle, 'merge')
    expect(report.ok).toBe(true)
    expect(report.perTable.transactions).toEqual({ incoming: 6, willWrite: 1, conflicts: 0 })
    expect((await db.table('transactions').toArray()).map(r => r.id).sort()).toEqual(
      ['tx.1', 'tx.2', 'tx.3', 'tx.4', 'tx.5', 'tx.7', 'tx.9'])
  })

  describe('refusals write nothing', () => {
    const expectUntouched = async (run: () => Promise<unknown>) => {
      await populate()
      const before = await snapshot()
      await run()
      expect(await snapshot()).toEqual(before)
    }

    it('refuses a bundle from a newer schema version, even with a populated database', async () => {
      await expectUntouched(async () => {
        const newer = { format: 'finance-export', schemaVersion: SCHEMA_VERSION + 1, exportedAt: '', tables: { categories: [] } }
        const report = await restoreBundle(newer, 'replace')
        expect(report).toMatchObject({ ok: false, refusedReason: 'newer-schema' })
      })
    })

    it.each([null, undefined, 'text', 42, [], {}, { format: 'other' }, { format: 'finance-export' }])(
      'refuses malformed bundle %j', async (b) => {
        await expectUntouched(async () => {
          for (const mode of ['replace', 'merge'] as const) {
            const report = await restoreBundle(b, mode)
            expect(report.ok).toBe(false)
            expect(['format', 'malformed']).toContain(report.refusedReason)
          }
        })
      })

    const base = (tables: unknown, extra: object = {}) =>
      ({ format: 'finance-export', schemaVersion: SCHEMA_VERSION, exportedAt: 'x', tables, ...extra })
    it.each([
      ['an unknown table', base({ nonsense: [] })],
      ['a table that is not a list', base({ transactions: {} })],
      ['a row that is not a record', base({ transactions: [7] })],
      ['a row missing its primary key', base({ transactions: [{ dedupKey: 'k' }] })],
      ['a row missing a unique index value', base({ transactions: [{ id: 'bad' }] })],
      ['a duplicated primary key', base({ transactions: [tx(1), tx(1, { dedupKey: 'other' })] })],
      ['a duplicated unique value', base({ transactions: [tx(1), tx(2, { dedupKey: tx(1).dedupKey })] })],
      ['a non-integer schemaVersion', base({}, { schemaVersion: 1.5 })],
      ['a missing exportedAt', base({}, { exportedAt: undefined })],
    ])('refuses a bundle with %s', async (_label, bundle) => {
      await expectUntouched(async () => {
        const report = await restoreBundle(bundle, 'replace')
        expect(report).toMatchObject({ ok: false, refusedReason: 'malformed' })
        expect(report.detail).toBeTruthy()
      })
    })
  })

  describe('inspectBundle', () => {
    it('writes nothing, in either mode, on a populated database', async () => {
      await populate()
      const before = await snapshot()
      const incoming = await exportBundle()
      incoming.tables.transactions!.push(tx(8))
      await inspectBundle(incoming, 'merge')
      await inspectBundle(incoming, 'replace')
      expect(await snapshot()).toEqual(before)
    })

    it('reports exactly what a restore then does', async () => {
      await populate()
      const incoming = await exportBundle()
      incoming.tables.transactions!.push(tx(8))
      incoming.tables.annotations = [annotation(1, { note: 'different' }), annotation(8)]
      const dry = await inspectBundle(incoming, 'merge')
      const real = await restoreBundle(incoming, 'merge')
      expect(real).toEqual(dry)
      expect(dry.perTable.transactions).toEqual({ incoming: 6, willWrite: 1, conflicts: 0 })
      expect(dry.perTable.annotations).toEqual({ incoming: 2, willWrite: 1, conflicts: 1 })
    })

    it('reports a replace as writing every incoming row', async () => {
      await populate()
      const incoming = await exportBundle()
      const report = await inspectBundle(incoming, 'replace')
      expect(report.perTable.transactions).toEqual({ incoming: 5, willWrite: 5, conflicts: 0 })
    })

    it('refuses with the same reasons as restore', async () => {
      expect(await inspectBundle(null, 'merge')).toMatchObject({ ok: false, refusedReason: 'format' })
      const newer = { format: 'finance-export', schemaVersion: SCHEMA_VERSION + 1, exportedAt: '', tables: {} }
      expect(await inspectBundle(newer, 'merge')).toMatchObject({ ok: false, refusedReason: 'newer-schema' })
    })
  })

  describe('merge never resolves annotation conflicts automatically', () => {
    it('keeps the local annotation, counts the incoming one, and lists it for the owner', async () => {
      await populate()
      await db.table('annotations').put(annotation(1, { note: 'my correction', updatedAt: 1000 }))
      const bundle = await exportBundle()
      // Incoming differs and is NEWER: updatedAt must not decide anything.
      bundle.tables.annotations = [
        annotation(1, { note: 'their version', updatedAt: 9_999_999_999_999 }),
        annotation(2, { note: 'note 2' }), // identical to local: not a conflict
        annotation(4, { note: 'brand new' }),
      ]
      const report = await restoreBundle(bundle, 'merge')
      expect(report.ok).toBe(true)
      expect(report.perTable.annotations).toEqual({ incoming: 3, willWrite: 1, conflicts: 1 })
      expect(report.conflictIds).toEqual(['tx.1'])
      expect((await db.table('annotations').get('tx.1'))!.note).toBe('my correction')
      expect((await db.table('annotations').get('tx.1'))!.updatedAt).toBe(1000)
      expect((await db.table('annotations').get('tx.4'))!.note).toBe('brand new')
    })

    it('keeps the local annotation when the incoming one is older, too', async () => {
      await populate()
      await db.table('annotations').put(annotation(1, { note: 'mine', updatedAt: 5000 }))
      const bundle = await exportBundle()
      bundle.tables.annotations = [annotation(1, { note: 'older', updatedAt: 1 })]
      const report = await restoreBundle(bundle, 'merge')
      expect(report.perTable.annotations?.conflicts).toBe(1)
      expect((await db.table('annotations').get('tx.1'))!.note).toBe('mine')
    })

    it('replace mode, by contrast, is an explicit full overwrite', async () => {
      await populate()
      await db.table('annotations').put(annotation(1, { note: 'mine' }))
      const bundle = await exportBundle()
      bundle.tables.annotations = [annotation(1, { note: 'incoming' })]
      const report = await restoreBundle(bundle, 'replace')
      expect(report.perTable.annotations?.conflicts).toBe(0)
      expect((await db.table('annotations').get('tx.1'))!.note).toBe('incoming')
    })
  })

  describe('merge and the account salt', () => {
    const saltOf = async () => (await getSettings()).privacy.accountSalt
    const withSalt = async (salt: string | null) => {
      const b = await exportBundle()
      const row = b.tables.settings![0] as { privacy: { accountSalt: string } }
      if (salt !== null) row.privacy.accountSalt = salt
      return b
    }

    it('replace takes the bundle salt', async () => {
      await populate()
      const bundle = await withSalt('incoming-salt-value')
      expect((await restoreBundle(bundle, 'replace')).ok).toBe(true)
      expect(await saltOf()).toBe('incoming-salt-value')
    })

    it('merge into a database with no salt yet takes the bundle salt', async () => {
      await getSettings() // create settings so there is a salt to export
      const bundle = await withSalt('incoming-salt-value') // a bundle exported elsewhere
      await db.delete(); await db.open() // no settings row at all
      expect((await restoreBundle(bundle, 'merge')).ok).toBe(true)
      expect(await saltOf()).toBe('incoming-salt-value')
    })

    it('merge with matching salts proceeds normally', async () => {
      await populate()
      const bundle = await exportBundle()
      bundle.tables.transactions!.push(tx(7))
      const report = await restoreBundle(bundle, 'merge')
      expect(report.ok).toBe(true)
      expect(await db.table('transactions').count()).toBe(6)
    })

    it('merge with two different salts is refused whole and writes nothing', async () => {
      await populate()
      const local = await saltOf()
      const before = await snapshot()
      const bundle = await withSalt('another-installation-salt')
      bundle.tables.transactions!.push(tx(7))
      for (const report of [await restoreBundle(bundle, 'merge'), await inspectBundle(bundle, 'merge')]) {
        expect(report).toMatchObject({ ok: false, refusedReason: 'salt-mismatch' })
        expect(report.detail).toMatch(/different installation/)
        expect(report.detail).toMatch(/replace/)
      }
      expect(await saltOf()).toBe(local)
      expect(await snapshot()).toEqual(before)
    })
  })

  describe('a bundle can never remove or blank the account salt', () => {
    const badSalts: Array<[string, (row: Record<string, unknown>) => void]> = [
      ['a missing privacy object', r => { delete r.privacy }],
      ['a missing accountSalt', r => { r.privacy = { storeLast4: false } }],
      ['an empty-string salt', r => { r.privacy = { accountSalt: '', storeLast4: false } }],
      ['a whitespace-only salt', r => { r.privacy = { accountSalt: '   ', storeLast4: false } }],
      ['a null salt', r => { r.privacy = { accountSalt: null, storeLast4: false } }],
      ['a numeric salt', r => { r.privacy = { accountSalt: 12345, storeLast4: false } }],
    ]
    for (const mode of ['merge', 'replace'] as const) {
      it.each(badSalts)(`${mode} refuses %s and keeps the local salt`, async (_label, damage) => {
        await populate()
        const local = (await getSettings()).privacy.accountSalt
        const before = await snapshot()
        const bundle = await exportBundle()
        damage(bundle.tables.settings![0] as Record<string, unknown>)
        for (const report of [await restoreBundle(bundle, mode), await inspectBundle(bundle, mode)]) {
          expect(report).toMatchObject({ ok: false, refusedReason: 'malformed' })
          expect(report.detail).toMatch(/accountSalt/)
        }
        expect((await getSettings()).privacy.accountSalt).toBe(local)
        expect(await snapshot()).toEqual(before)
      })
    }
  })

  describe('replace never erases what the bundle omits', () => {
    it('refuses a bundle with an empty tables map and leaves a populated database untouched', async () => {
      await populate()
      const before = await snapshot()
      const empty = { format: 'finance-export', schemaVersion: SCHEMA_VERSION, exportedAt: 'x', tables: {} }
      for (const report of [await restoreBundle(empty, 'replace'), await inspectBundle(empty, 'replace')]) {
        expect(report).toMatchObject({ ok: false, refusedReason: 'malformed' })
      }
      expect(await snapshot()).toEqual(before)
    })

    it('refuses a bundle missing a single table, or the settings row', async () => {
      await populate()
      const before = await snapshot()
      const noMoods = await exportBundle(); delete noMoods.tables.moods
      expect(await restoreBundle(noMoods, 'replace')).toMatchObject({ ok: false, refusedReason: 'malformed' })
      const noSettings = await exportBundle(); noSettings.tables.settings = []
      expect(await restoreBundle(noSettings, 'replace')).toMatchObject({ ok: false, refusedReason: 'malformed' })
      expect(await snapshot()).toEqual(before)
    })

    it('a merge of an empty tables map is a harmless no-op', async () => {
      await populate()
      const before = await snapshot()
      const empty = { format: 'finance-export', schemaVersion: SCHEMA_VERSION, exportedAt: 'x', tables: {} }
      expect((await restoreBundle(empty, 'merge')).ok).toBe(true)
      expect(await snapshot()).toEqual(before)
    })
  })

  describe('merge keeps the owner settings', () => {
    it('keeps local settings, counts a conflict, and replace still overwrites', async () => {
      await populate()
      await db.table('settings').update('singleton', { theme: 'dark' })
      const bundle = await exportBundle();
      (bundle.tables.settings![0] as { theme: string }).theme = 'light' // same salt, older preference
      const dry = await inspectBundle(bundle, 'merge')
      const report = await restoreBundle(bundle, 'merge')
      expect(report).toEqual(dry)
      expect(report.perTable.settings).toEqual({ incoming: 1, willWrite: 0, conflicts: 1 })
      expect(report.localSettingsKept).toBe(true)
      expect((await getSettings()).theme).toBe('dark')
      expect((await restoreBundle(bundle, 'replace')).ok).toBe(true)
      expect((await getSettings()).theme).toBe('light')
    })
  })

  describe('the dry run predicts write-time refusals', () => {
    it('reports a changed bank field as a conflict, keeps the local row, and still adds genuinely new rows', async () => {
      await populate()
      const bundle = await exportBundle()
      bundle.tables.accounts = [account(3)]
      bundle.tables.transactions = [tx(1, { amountCents: 1 })]
      const dry = await inspectBundle(bundle, 'merge')
      expect(dry.ok).toBe(true)
      expect(dry.conflictRows).toEqual(['transactions:tx.1'])
      expect(dry.perTable.transactions).toEqual({ incoming: 1, willWrite: 0, conflicts: 1 })
      expect(dry.perTable.accounts).toEqual({ incoming: 1, willWrite: 1, conflicts: 0 })
      expect(await restoreBundle(bundle, 'merge')).toEqual(dry)
      expect((await db.table('transactions').get('tx.1'))!.amountCents).toBe(tx(1).amountCents)
      expect(await db.table('accounts').get('acc.3')).toBeDefined()
    })

    it('reports a dedupKey held by a different local transaction as a conflict', async () => {
      await populate()
      const before = await snapshot()
      const bundle = await exportBundle()
      bundle.tables.transactions = [tx(8, { dedupKey: tx(2).dedupKey })] // new id, same bank identity as tx.2
      const dry = await inspectBundle(bundle, 'merge')
      expect(dry).toMatchObject({ ok: false, refusedReason: 'conflict', blockedIds: ['transactions:tx.8'] })
      expect(await restoreBundle(bundle, 'merge')).toEqual(dry)
      expect(await snapshot()).toEqual(before)
    })

    it('does not apply an incoming deletedAt either: local always wins', async () => {
      await populate()
      const bundle = await exportBundle()
      bundle.tables.transactions = [tx(1, { deletedAt: 1_800_000_000_000 })]
      const report = await restoreBundle(bundle, 'merge')
      expect(report.ok).toBe(true)
      expect(report.perTable.transactions).toEqual({ incoming: 1, willWrite: 0, conflicts: 1 })
      expect((await db.table('transactions').get('tx.1'))!.deletedAt).toBeNull()
    })
    it('names what it cannot foresee', async () => {
      await populate()
      const dry = await inspectBundle(await exportBundle(), 'merge')
      expect(dry.ok).toBe(true)
      expect(dry.unchecked?.length).toBeGreaterThan(0)
    })
  })

  describe('atomicity', () => {
    it('rolls back replace (including its clear) when an account trips the write guard', async () => {
      await populate()
      const before = await snapshot()
      const bundle = await exportBundle()
      bundle.tables.accounts = [account(3), { ...account(4), fingerprint: 'not-a-fingerprint' }]
      // Structurally valid; the guard lives in the write path, so this fails after clear() ran.
      const report = await restoreBundle(bundle, 'replace')
      expect(report).toMatchObject({ ok: false, refusedReason: 'write-failed' })
      expect(await snapshot()).toEqual(before)
    })

    it('rolls back when a later table fails after earlier tables were written', async () => {
      await populate()
      const before = await snapshot()
      const bundle = await exportBundle()
      bundle.tables.accounts = [account(3)]
      bundle.tables.transactions = [tx(6)]
      bundle.tables.annotations = [annotation(8)]
      const stub = vi.spyOn(db.table('annotations'), 'bulkPut').mockImplementation(() => Promise.reject(new Error('disk exploded')) as never)
      const report = await restoreBundle(bundle, 'merge')
      expect(stub).toHaveBeenCalled()
      expect(report).toMatchObject({ ok: false, refusedReason: 'write-failed' })
      stub.mockRestore()
      expect(await snapshot()).toEqual(before)
    })

    it('surfaces a storage-full failure as a refusal, not a crash, and leaves the database unchanged', async () => {
      await populate()
      const before = await snapshot()
      const bundle = await exportBundle()
      bundle.tables.accounts = [account(3)]
      bundle.tables.annotations = [annotation(8)]
      const quota = () => Promise.reject(new DOMException('The quota has been exceeded.', 'QuotaExceededError'))
      // accounts and transactions are written before annotations, so this fails mid-way.
      const stub = vi.spyOn(db.table('annotations'), 'bulkPut').mockImplementation(quota as never)
      const report = await restoreBundle(bundle, 'replace')
      expect(stub).toHaveBeenCalled()
      expect(report.ok).toBe(false)
      expect(report.refusedReason).toBe('write-failed')
      expect(report.detail).toContain('QuotaExceededError')
      stub.mockRestore()
      expect(await snapshot()).toEqual(before)
    })
  })
})

describe('recurring.dismissed in a backup', () => {
  const recurringRow = (over: Record<string, unknown> = {}) => ({
    id: 'm.gym|monthly|0', merchantId: 'm.gym', amountCents: 3000, toleranceCents: 150, frequency: 'monthly',
    lastSeenDate: '2026-08-05', expectedNextDate: '2026-09-04', matchScore: 6000, confirmedByUser: false, cancelled: false, ...over,
  })

  it('round-trips a dismissed recurring payment', async () => {
    await seedDatabase()
    await db.table('recurring').add(recurringRow({ dismissed: true }))
    const bundle = JSON.parse(JSON.stringify(await exportBundle())) as unknown
    await db.delete(); await db.open()
    expect((await restoreBundle(bundle, 'replace')).ok).toBe(true)
    expect((await db.table('recurring').get('m.gym|monthly|0'))?.dismissed).toBe(true)
  })

  it('restores a backup whose recurring rows predate the field, and reads them as not dismissed', async () => {
    await seedDatabase()
    await db.table('recurring').add(recurringRow())
    const bundle = JSON.parse(JSON.stringify(await exportBundle())) as unknown
    await db.delete(); await db.open()
    expect((await inspectBundle(bundle, 'replace')).ok).toBe(true)
    expect((await restoreBundle(bundle, 'replace')).ok).toBe(true)
    const row = await db.table('recurring').get('m.gym|monthly|0')
    expect(row).toBeTruthy()
    expect(row.dismissed).toBeUndefined()
  })
})
