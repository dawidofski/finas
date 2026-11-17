import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../db/db'
import { seedDatabase } from '../db/seed'
import type { AccountRow, TransactionRow } from '../db/schema'
import { buildCategoryIndex } from '../db/annotations'
import { epochMsToIso, formatSpanishDate } from '../lib/dates'
import { BASE, NUMBER, OTHER_NUMBER, HOLDER, statement, type Move } from './__fixtures__/statement'
import { commitPreview } from './commit'
import { ImportError } from './detect'
import { buildPreview, type ImportPreview } from './pipeline'
import { fingerprintAccount } from './scrub'

const counts = async (): Promise<Record<string, number>> =>
  Object.fromEntries(await Promise.all(db.tables.map(async (t) => [t.name, await t.count()] as const)))

/** Every table's full contents, so an in-place overwrite is caught where a row count would not be. */
const contents = async (): Promise<Record<string, string>> =>
  Object.fromEntries(await Promise.all(db.tables.map(async (t) => [t.name, JSON.stringify(await t.toArray())] as const)))

beforeEach(async () => {
  await db.delete()
  await db.open()
  await seedDatabase()
})

const preview = (bytes: Uint8Array, name = 'movimientos.xlsx'): Promise<ImportPreview> => buildPreview(bytes, name)

describe('buildPreview', () => {
  it('builds a preview without writing anything', async () => {
    const before = await contents()
    const p = await preview(statement({ moves: BASE, opening: 100000 }))
    expect(p.rows).toHaveLength(3)
    expect(p.rows.every((r) => r.verdict.kind === 'new')).toBe(true)
    expect(p.balance.ok).toBe(true)
    expect(p.gap.kind).toBe('first-import')
    expect(await contents()).toEqual(before)
  })

  it('reads the salt without creating the settings row', async () => {
    await db.settings.clear()
    const err = await preview(statement({ moves: BASE, opening: 100000 })).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ImportError)
    expect((err as ImportError).message).toMatch(/Open Settings once/)
    expect(await db.settings.count()).toBe(0)
  })

  it('recognises a known account by fingerprint and labels it', async () => {
    const settings = await db.settings.get('singleton')
    const fingerprint = await fingerprintAccount(NUMBER, settings!.privacy.accountSalt)
    const known: AccountRow = { id: 'acc.main', fingerprint, label: 'Cuenta nómina', last4: '5566', currency: 'EUR', createdAt: 1, archived: false }
    await db.accounts.add(known)
    const p = await preview(statement({ moves: BASE, opening: 100000 }))
    expect(p).toMatchObject({ isNewAccount: false, accountId: 'acc.main', accountLabel: 'Cuenta nómina', accountFingerprint: fingerprint })
    expect(p.rows.every((r) => r.row.accountId === 'acc.main')).toBe(true)
  })

  it('mints an account id for a first-seen fingerprint without writing it', async () => {
    const p = await preview(statement({ moves: BASE, opening: 100000 }))
    expect(p.isNewAccount).toBe(true)
    expect(p.accountId).toMatch(/^acc\.[0-9a-f]{10}$/)
    expect(p.accountLabel).toBe('Cuenta 5566')
    expect(await db.accounts.count()).toBe(0)
  })

  it('refuses a byte-identical re-import, naming the previous import date', async () => {
    const bytes = statement({ moves: BASE, opening: 100000 })
    const imported = await commitPreview(await preview(bytes), new Map())
    const err = await preview(bytes).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ImportError)
    expect((err as ImportError).message).toContain(formatSpanishDate(epochMsToIso(imported.importedAt)))
    expect((err as ImportError).code).toBe('already-imported')
    expect((err as ImportError).message).toMatch(/already imported/)
  })

  it('refuses a PDF or CSV with a message pointing at the Excel export', async () => {
    const pdf = new TextEncoder().encode('%PDF-1.7\n1 0 obj\n')
    const csv = new TextEncoder().encode('fecha;importe\n2026-11-10;-12,45\n')
    for (const bytes of [pdf, csv]) {
      const err = await preview(bytes).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(ImportError)
      expect((err as ImportError).code).toBe('unsupported-format')
      expect((err as ImportError).message).toMatch(/Excel/)
    }
    expect(await counts()).toMatchObject({ imports: 0, transactions: 0, accounts: 0 })
  })

  it('flags an overlapping file that shares no row with stored history as a divergence', async () => {
    await commitPreview(await preview(statement({ moves: BASE, opening: 100000 })), new Map())
    // Same calendar days, but a different balance chain: no dedup key can match.
    const other = statement({
      moves: [{ date: '2026-11-11', cents: -500 }, { date: '2026-11-13', cents: -700 }],
      opening: 555500, exported: '16/11/2026 08:00:00',
    })
    const p = await preview(other)
    expect(p.rows.some((r) => r.verdict.kind === 'duplicate')).toBe(false)
    expect(['overlap', 'contiguous']).toContain(p.gap.kind)
    expect(p.divergent).toBe(true)

    const before = await counts()
    await expect(commitPreview(p, new Map())).rejects.toMatchObject({ code: 'divergent-history' })
    expect(await counts()).toEqual(before)
    const imported = await commitPreview(p, new Map(), { acknowledgeDivergence: true })
    expect(imported.rowsNew).toBe(2)
    expect(imported.notes).toMatch(/confirmed/)
  })

  it('does not flag an overlap that really shares rows', async () => {
    await commitPreview(await preview(statement({ moves: BASE, opening: 100000 })), new Map())
    const more = statement({
      moves: [...BASE, { date: '2026-11-13', cents: -150 }], opening: 100000, exported: '16/11/2026 08:00:00',
    })
    const p = await preview(more)
    expect(p.divergent).toBe(false)
    expect(p.rows.filter((r) => r.verdict.kind === 'duplicate')).toHaveLength(3)
  })

  it('refuses a file whose commit would write no rows', async () => {
    await commitPreview(await preview(statement({ moves: BASE, opening: 100000 })), new Map())
    const reExport = statement({ moves: BASE, opening: 100000, exported: '16/11/2026 08:00:00' })
    const err = await preview(reExport).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ImportError)
    expect((err as ImportError).code).toBe('nothing-new')
    expect((err as ImportError).message).toMatch(/3 rows are already in your history/)
    expect((err as ImportError).message).toMatch(/wider date range/)

    // The commit holds the same line even for a preview that was assembled by other means.
    const stored = await db.transactions.toArray()
    const forged: ImportPreview = {
      ...(await preview(statement({ moves: [{ date: '2026-11-20', cents: -100 }], opening: 5000 }))),
    }
    forged.rows = forged.rows.map(({ row }) => ({ row, verdict: { kind: 'duplicate' as const, existingId: stored[0]!.id } }))
    const before = await counts()
    await expect(commitPreview(forged, new Map())).rejects.toMatchObject({ code: 'nothing-new' })
    expect(await counts()).toEqual(before)
  })
})

describe('filename and refusal copy', () => {
  it('stores a renamed file carrying a 20-digit account number redacted, and an ordinary date stamp unchanged', async () => {
    const renamed = await buildPreview(statement({ moves: BASE, opening: 100000 }), 'ES00 9999 0418 4502 0005 1332 movimientos.xlsx')
    expect(renamed.filename).not.toMatch(/\d{4} \d{4}/)
    expect(renamed.filename).toContain('[redacted]')
    expect(renamed.filename).toContain('movimientos.xlsx')
    const unbroken = await buildPreview(statement({ moves: BASE, opening: 100000 }), 'cuenta-99990418450200051332.xlsx')
    expect(unbroken.filename).toBe('cuenta-[redacted].xlsx')
    const plain = await buildPreview(statement({ moves: BASE, opening: 100000 }), 'movements-15112026.xls')
    expect(plain.filename).toBe('movements-15112026.xls')
    await commitPreview(unbroken, new Map())
    expect((await db.imports.toArray())[0]!.filename).toBe('cuenta-[redacted].xlsx')
  })

  it('says why nothing new would be imported when rows wait on review', async () => {
    const first = await buildPreview(statement({ moves: BASE, opening: 100000 }), 'a.xlsx')
    await commitPreview(first, new Map())
    // Same slot, different description: every row is held for review, none is known outright.
    const changed = statement({
      moves: BASE.map((m) => ({ ...m, desc: 'Compra EN OTRA TIENDA' })), opening: 100000, exported: '16/11/2026 08:00:00',
    })
    const err = await buildPreview(changed, 'b.xlsx').catch((e: unknown) => e)
    expect((err as ImportError).code).toBe('nothing-new')
    expect((err as ImportError).message).toMatch(/3 rows were left out of this import/)
    expect((err as ImportError).message).toContain('its description differs')
  })
})

describe('commitPreview', () => {
  it('commits new rows, skips duplicates, and records the import', async () => {
    const first = await commitPreview(await preview(statement({ moves: BASE, opening: 100000 })), new Map())
    expect(first).toMatchObject({ rowsDetected: 3, rowsNew: 3, rowsDuplicate: 0, rowsNeedsReview: 0, balanceChainOk: true })
    expect(first.coverageStart).toBe('2026-11-10')
    expect(first.coverageEnd).toBe('2026-11-12')

    const later = statement({
      moves: [...BASE, { date: '2026-11-13', cents: -150 }, { date: '2026-11-14', cents: 2000 }],
      opening: 100000, exported: '16/11/2026 08:00:00',
    })
    const second = await commitPreview(await preview(later), new Map())
    expect(second).toMatchObject({ rowsDetected: 5, rowsNew: 2, rowsDuplicate: 3 })
    expect(await db.transactions.count()).toBe(5)
    expect(await db.imports.count()).toBe(2)
    expect(await db.accounts.count()).toBe(1)
    const rows = await db.transactions.toArray()
    expect(rows.every((r) => r.importId.startsWith('imp.') && r.deletedAt === null)).toBe(true)
    expect(rows.filter((r) => r.importId === second.id)).toHaveLength(2)
  })

  it('writes nothing when any row fails', async () => {
    // A new account, an unseen ING pair and a transfer-shaped row: every kind of write the commit makes.
    const bytes = statement({
      moves: [
        ...BASE,
        { date: '2026-11-13', cents: -1500, cat: 'Viajes raros', sub: 'Tren fantasía' },
      ],
      opening: 100000,
    })
    const p = await preview(bytes)
    // Between preview and commit another tab stores a row with the dedup key of the file's FIRST row, so the unique-key
    // violation fires at the first insert of bulkAdd. That is the stronger case: the account and category writes made
    // BEFORE bulkAdd must then be rolled back too, which the assertions below prove.
    const victim = p.rows[0]!.row
    const squatter: TransactionRow = {
      ...victim, id: 'squat', importId: 'imp.other', createdAt: 1, deletedAt: null, accountId: 'acc.squatter',
    }
    await db.transactions.add(squatter)
    const before = await contents()

    await expect(commitPreview(p, new Map([[0, { note: 'hello' }]]))).rejects.toThrow(/already exists|constraint/i)
    expect(await contents()).toEqual(before)
    expect(await db.accounts.count()).toBe(0)
    expect(await db.imports.count()).toBe(0)
    expect(await db.annotations.count()).toBe(0)
    expect(await db.categories.get('cat.ing.viajes-raros.tren-fantasia')).toBeUndefined()
  })

  it('creates an unseen ING pair as a leaf flagged for review, under its parent', async () => {
    const p = await preview(statement({
      moves: [
        { date: '2026-11-10', cents: -1000, cat: 'Ocio y viajes', sub: 'Cine y teatro' },
        { date: '2026-11-11', cents: -2000, cat: 'Viajes raros', sub: 'Tren fantasía' },
        { date: '2026-11-12', cents: -300 },
      ],
      opening: 100000,
    }))
    expect(p.unknownPairs).toEqual(expect.arrayContaining([
      { ing: 'Ocio y viajes', ingSub: 'Cine y teatro' }, { ing: 'Viajes raros', ingSub: 'Tren fantasía' },
    ]))
    expect(p.unknownPairs).toHaveLength(2)
    const parentsBefore = await db.categories.where('parentId').equals('cat.group.ocio-viajes').count()
    await commitPreview(p, new Map())

    const cine = (await db.categories.toArray()).find((c) => c.ingMappings.includes('Ocio y viajes / Cine y teatro'))!
    expect(cine).toMatchObject({ name: 'Cine y teatro', parentId: 'cat.group.ocio-viajes', needsReview: true, kind: 'discretionary' })
    expect(await db.categories.where('parentId').equals('cat.group.ocio-viajes').count()).toBe(parentsBefore + 1)

    const tren = (await db.categories.toArray()).find((c) => c.ingMappings.includes('Viajes raros / Tren fantasía'))!
    const parent = await db.categories.get(tren.parentId!)
    expect(parent).toMatchObject({ name: 'Viajes raros', parentId: null, kind: null })
    expect(tren.needsReview).toBe(true)

    // A second file with the same pairs creates nothing more: the mapping now exists.
    const again = await preview(statement({
      moves: [{ date: '2026-11-20', cents: -100, cat: 'Viajes raros', sub: 'Tren fantasía' }], opening: 50000,
    }))
    expect(again.unknownPairs).toEqual([])
  })

  it('refuses a second preview that introduces a pair another import has since claimed', async () => {
    const pair = { cat: 'Viajes raros', sub: 'Tren fantasía' }
    const a = await preview(statement({ moves: [{ date: '2026-11-10', cents: -1000, ...pair }], opening: 50000 }))
    const b = await preview(statement({ moves: [{ date: '2026-11-10', cents: -2000, ...pair }], opening: 80000, number: OTHER_NUMBER }))
    expect(a.unknownPairs).toEqual(b.unknownPairs)
    await commitPreview(a, new Map())
    const before = await contents()
    await expect(commitPreview(b, new Map())).rejects.toMatchObject({ code: 'stale-preview' })
    expect(await contents()).toEqual(before)

    const claiming = (await db.categories.toArray()).filter((c) => c.ingMappings.includes('Viajes raros / Tren fantasía'))
    expect(claiming).toHaveLength(1)
    expect(claiming[0]).toMatchObject({ needsReview: true })
    await expect(buildCategoryIndex()).resolves.toBeInstanceOf(Map)
    // A fresh preview of the second file now sees the pair as known and commits.
    const again = await preview(statement({ moves: [{ date: '2026-11-10', cents: -2000, ...pair }], opening: 80000, number: OTHER_NUMBER }))
    expect(again.unknownPairs).toEqual([])
    await commitPreview(again, new Map())
    expect((await buildCategoryIndex()).get('Viajes raros / Tren fantasía')).toBe(claiming[0]!.id)
  })

  it('stores last4 when storeLast4 is true and omits it when false', async () => {
    await commitPreview(await preview(statement({ moves: BASE, opening: 100000 })), new Map())
    expect((await db.accounts.toArray())[0]).toMatchObject({ last4: '5566', label: 'Cuenta 5566' })

    await db.settings.update('singleton', { privacy: { ...(await db.settings.get('singleton'))!.privacy, storeLast4: false } })
    const p = await preview(statement({
      moves: [{ date: '2026-11-10', cents: -700 }], opening: 9000, number: OTHER_NUMBER,
    }))
    expect(p.last4).toBeNull()
    await commitPreview(p, new Map())
    const other = (await db.accounts.toArray()).find((a) => a.id === p.accountId)!
    expect(other.last4).toBeNull()
    expect(JSON.stringify(await db.accounts.toArray())).not.toContain('5544')
  })

  it('writes preview edits as ANNOTATIONS, not into the bank row', async () => {
    const p = await preview(statement({ moves: BASE, opening: 100000 }))
    const edited = p.rows[1]!.row // the café, as the file has it
    await commitPreview(p, new Map([[1, { categoryId: 'cat.groceries', note: 'weekly shop', descriptionOverride: 'Mercado' }]]))

    const tx = (await db.transactions.toArray()).find((t) => t.dedupKey === edited.dedupKey)!
    expect(tx).toMatchObject({ description: edited.description, amountCents: edited.amountCents, valueDate: edited.valueDate })
    expect(tx.description).not.toBe('Mercado')
    const ann = await db.annotations.get(tx.id)
    expect(ann).toMatchObject({ categoryId: 'cat.groceries', note: 'weekly shop', descriptionOverride: 'Mercado' })
    expect(await db.annotations.count()).toBe(1)
    expect(await db.learningEvents.count()).toBeGreaterThan(0)
  })

  it('refuses a correction aimed at a row that is not being imported', async () => {
    await commitPreview(await preview(statement({ moves: BASE, opening: 100000 })), new Map())
    const p = await preview(statement({
      moves: [...BASE, { date: '2026-11-13', cents: -150 }], opening: 100000, exported: '16/11/2026 08:00:00',
    }))
    const dupIndex = p.rows.findIndex((r) => r.verdict.kind === 'duplicate')
    const before = await counts()
    await expect(commitPreview(p, new Map([[dupIndex, { note: 'x' }]]))).rejects.toMatchObject({ code: 'invalid-correction' })
    expect(await counts()).toEqual(before)
  })

  it('resolves a round-up parent at commit, and leaves an ambiguous one null', async () => {
    const roundup = (parent: string, date = '2026-11-12'): Move => ({
      date, cents: -22, cat: 'Ahorro', sub: 'Redondeo', desc: `Redondeo por tu compra de ${parent}`,
    })
    const p = await preview(statement({
      moves: [
        // Clear case: the round-up directly follows its purchase.
        { date: '2026-11-10', cents: -3478, desc: 'Compra EN TIENDA UNO' }, roundup('34 EUR y 78 cts', '2026-11-10'),
        // Ambiguous: two identical purchases, and the round-up is not adjacent to either.
        { date: '2026-11-12', cents: -500, desc: 'Compra EN TIENDA DOS' }, { date: '2026-11-12', cents: -500, desc: 'Compra EN TIENDA TRES' },
        { date: '2026-11-12', cents: -200, desc: 'Compra EN TIENDA CUATRO' }, roundup('5 EUR y 0 cts'),
      ],
      opening: 100000,
    }))
    expect(p.roundupLinks.map((l) => l.basis).sort()).toEqual(['ambiguous', 'unique-amount'])
    await commitPreview(p, new Map())

    const all = await db.transactions.toArray()
    const parentRow = all.find((t) => t.description.includes('TIENDA UNO'))!
    const linked = all.find((t) => t.description.includes('34 EUR y 78 cts'))!
    const unlinked = all.find((t) => t.description.includes('5 EUR y 0 cts'))!
    expect(linked.kind).toBe('roundup')
    expect(linked.roundupParentId).toBe(parentRow.id)
    expect(unlinked.roundupParentId).toBeNull()
  })

  it('pairs a transfer with the other account after this account\'s rows are written', async () => {
    const settings = await db.settings.get('singleton')
    const fp = await fingerprintAccount(OTHER_NUMBER, settings!.privacy.accountSalt)
    await db.accounts.add({ id: 'acc.savings', fingerprint: fp, label: 'Ahorro', last4: null, currency: 'EUR', createdAt: 1, archived: false })
    await db.transactions.add({
      id: 'sav.1', accountId: 'acc.savings', valueDate: '2026-11-11', amountCents: 5000, balanceCents: 5000,
      description: 'Traspaso recibido', comment: null, ingCategory: 'Movimientos excluidos', ingSubcategory: 'Traspaso entre cuentas',
      kind: 'internal', dedupKey: 'k.sav.1', importId: 'imp.old', fileSeq: 1, roundupParentId: null, createdAt: 1, deletedAt: null,
    })
    const p = await preview(statement({
      moves: [
        { date: '2026-11-10', cents: -1245 },
        { date: '2026-11-11', cents: -5000, cat: 'Movimientos excluidos', sub: 'Traspaso entre cuentas', desc: 'Traspaso emitido' },
      ],
      opening: 100000,
    }))
    await commitPreview(p, new Map())
    const transfers = await db.transfers.toArray()
    expect(transfers).toHaveLength(1)
    const sent = (await db.transactions.toArray()).find((t) => t.kind === 'internal' && t.accountId !== 'acc.savings')!
    expect(transfers[0]).toMatchObject({ outTransactionId: sent.id, inTransactionId: 'sav.1', amountCents: 5000, linkKind: 'internal' })
  })

  it('never persists the file, the full account number or the holder name', async () => {
    const bytes = statement({
      moves: [
        { date: '2026-11-10', cents: -1245, desc: `Traspaso emitido a ${HOLDER}`, comment: 'para TESTER' },
        { date: '2026-11-11', cents: -320, desc: 'Bizum a Prueba Tester' },
      ],
      opening: 100000,
    })
    const p = await preview(bytes, 'Movimientos TESTER 2026.xlsx')
    expect(JSON.stringify(p)).not.toMatch(/TESTER|PRUEBA|4444555566/i)
    await commitPreview(p, new Map([[0, { note: 'ok' }]]))

    const dump: string[] = []
    let binary = 0
    for (const t of db.tables) {
      dump.push(JSON.stringify(await t.toArray(), (_k, v: unknown) => {
        if (v instanceof Uint8Array || v instanceof ArrayBuffer) binary++
        return v
      }))
    }
    const text = dump.join('\n')
    expect(binary).toBe(0)
    expect(text).not.toMatch(/TESTER|PRUEBA|AN[OÓ]NIMA/i)
    expect(text).not.toContain(NUMBER)
    expect(text).not.toContain('ES00 1111 2222 33 4444555566')
    expect(text).not.toMatch(/0011112222334444555566|1111222233|4444555566/)
    // The scrub replaced the name where it appeared in free text; last4 alone is permitted (§34.5).
    expect(text).toContain('[redacted]')
    expect(text).toContain('5566')
    expect((await db.imports.toArray())[0]!.filename).toBe('Movimientos [redacted] 2026.xlsx')
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })
})
