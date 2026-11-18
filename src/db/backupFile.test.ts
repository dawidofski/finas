import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { db } from './db'
import { seedDatabase, getSettings } from './seed'
import { exportBundle, inspectBundle, restoreBundle } from './backup'
import type { Bundle } from './backup'
import { encryptBundle } from './encryptedBackup'
import type { Envelope } from './encryptedBackup'
import { readBackupFile, openEncryptedBackup } from './backupFile'
import { causalWords, jargonWords, shamingWords } from '../test/bannedWords'

const PASS = 'cuatro palabras sin relacion'
const OTHER_PASS = 'otra frase totalmente distinta'
const OWNER_FACING_JARGON = /AES|PBKDF2|salt|\bIV\b|decrypt|authentication tag/i

let bundle: Bundle
let plainText: string
let encryptedText: string
let envelope: Envelope
let opened: unknown

const analyticsRow = { key: 'cache.1', engineVersion: 1, inputsHash: 'h', computedAt: 1_700_000_000_000, payload: { n: 1 } }
const saltOf = (b: Bundle): string => (b.tables.settings![0] as { privacy: { accountSalt: string } }).privacy.accountSalt

// One derivation to seal, one to open: shared by every test that only needs the decrypted object.
beforeAll(async () => {
  await db.delete(); await db.open()
  await seedDatabase()
  await db.table('accounts').bulkAdd([{
    id: 'acc.1', fingerprint: 'a'.repeat(64), label: 'Cuenta Ejemplo', last4: null, currency: 'EUR', createdAt: 1_700_000_000_000, archived: false,
  }])
  await db.table('transactions').bulkAdd([{
    id: 'tx.1', accountId: 'acc.1', valueDate: '2026-11-02', amountCents: -987_654, balanceCents: 5_000_000,
    description: 'Comercio Ejemplo Zeta', comment: null, ingCategory: 'Compras', ingSubcategory: 'Compras (otros)', kind: 'spend',
    dedupKey: 'dedup-1', importId: 'imp.1', fileSeq: 1, roundupParentId: null, createdAt: 1_700_000_000_000, deletedAt: null,
  }])
  bundle = await exportBundle()
  plainText = JSON.stringify(bundle, null, 2)
  encryptedText = await encryptBundle(bundle, PASS)
  const file = readBackupFile(encryptedText)
  if (file.kind !== 'encrypted') throw new Error('the fixture must classify as encrypted')
  envelope = file.envelope
  const result = await openEncryptedBackup(envelope, PASS)
  if (!result.ok) throw new Error('the fixture must open')
  opened = result.bundle
}, 20000)

beforeEach(async () => { await db.delete(); await db.open() })
afterEach(() => { vi.restoreAllMocks() })

const snapshot = async () => ({ ...(await exportBundle()), exportedAt: '' })

function expectPlainOwnerText(detail: string | undefined) {
  expect(detail).toBeDefined()
  for (const list of [causalWords, jargonWords, shamingWords]) expect(detail).not.toMatch(list)
  expect(detail).not.toMatch(OWNER_FACING_JARGON)
  expect((detail ?? '').endsWith('Nothing was changed.')).toBe(true)
}

describe('reading a backup file', () => {
  it('routes a file by its content, whatever it is named', () => {
    // The function takes the text only, so no file name can matter; what counts is the content.
    const plain = readBackupFile(plainText)
    expect(plain.kind).toBe('plain')
    if (plain.kind === 'plain') expect(plain.bundle).toEqual(bundle)
    expect(readBackupFile(JSON.stringify(bundle)).kind).toBe('plain')
    const enc = readBackupFile(encryptedText)
    expect(enc.kind).toBe('encrypted')
    if (enc.kind === 'encrypted') expect(enc.envelope).toEqual(envelope)
    // A newer encrypted version is refused before any passphrase is asked for.
    const newer = readBackupFile(JSON.stringify({ ...envelope, version: 2 }))
    expect(newer.kind).toBe('refused')
    if (newer.kind === 'refused') {
      expect(newer.report.refusedReason).toBe('newer-format')
      expectPlainOwnerText(newer.report.detail)
    }
    // An encrypted file with a broken structure is refused as malformed.
    const broken = readBackupFile(JSON.stringify({ ...envelope, iv: 'AAAA' }))
    expect(broken.kind).toBe('refused')
    if (broken.kind === 'refused') {
      expect(broken.report.refusedReason).toBe('malformed')
      expectPlainOwnerText(broken.report.detail)
    }
  })

  it('reports a cut-short encrypted or plain backup as damaged or incomplete, not as a stranger file', () => {
    for (const text of [encryptedText, plainText, JSON.stringify(bundle)]) {
      const file = readBackupFile(text.slice(0, Math.floor(text.length / 2)))
      expect(file.kind).toBe('refused')
      if (file.kind !== 'refused') continue
      expect(file.report.ok).toBe(false)
      expect(file.report.refusedReason).toBe('malformed')
      expect(file.report.perTable).toEqual({})
      const detail = file.report.detail ?? ''
      expect(detail).toMatch(/damaged or incomplete/)
      expect(detail).not.toMatch(/not a backup|not valid JSON/i)
      // It does not claim to know which part is missing or why.
      expect(detail).not.toMatch(/missing|cut|truncat|wrong passphrase|half/i)
      expectPlainOwnerText(detail)
    }
  })

  it('keeps today\'s refusal for JSON that is not a backup at all', async () => {
    for (const text of ['{"hello":1}', '[1,2,3]', '"just text"', '42', 'null']) {
      const file = readBackupFile(text)
      expect(file.kind).toBe('plain')
      if (file.kind === 'plain') expect((await inspectBundle(file.bundle, 'replace')).refusedReason).toBe('format')
    }
    // Text that does not parse and does not start like ours keeps the wording it has today.
    for (const text of ['this is not json', '{"format":"something-else","x":']) {
      const file = readBackupFile(text)
      expect(file.kind).toBe('refused')
      if (file.kind === 'refused') {
        expect(file.report.refusedReason).toBe('malformed')
        expect(file.report.detail).toBe('This file is not valid JSON, so it is not a backup from this app.')
      }
    }
  })
})

describe('an encrypted backup meets every restore rule', () => {
  it('refuses to merge a decrypted backup from another installation, and writes nothing', async () => {
    await seedDatabase() // this installation makes its own salt
    expect((await getSettings()).privacy.accountSalt).not.toBe(saltOf(bundle))
    const before = await snapshot()
    const viaPlain = await inspectBundle(JSON.parse(plainText), 'merge')
    const viaEncrypted = await inspectBundle(opened, 'merge')
    expect(viaEncrypted.refusedReason).toBe('salt-mismatch')
    expect(viaEncrypted).toEqual(viaPlain)
    expect((await restoreBundle(opened, 'merge')).refusedReason).toBe('salt-mismatch')
    expect(await snapshot()).toEqual(before)
  })

  it('reports conflicts in a decrypted merge exactly as for the same bundle in plain', async () => {
    expect((await restoreBundle(JSON.parse(plainText), 'replace')).ok).toBe(true) // same installation now
    await db.table('accounts').update('acc.1', { label: 'Cuenta Cambiada' })
    const viaPlain = await inspectBundle(JSON.parse(plainText), 'merge')
    const viaEncrypted = await inspectBundle(opened, 'merge')
    expect(viaPlain.ok).toBe(true)
    expect(viaPlain.conflictRows).toContain('accounts:acc.1')
    expect(viaEncrypted).toEqual(viaPlain)
    const before = await snapshot()
    expect((await restoreBundle(opened, 'merge')).conflictRows).toEqual(viaPlain.conflictRows)
    expect(await snapshot()).toEqual(before) // the local row won; nothing was applied
  })

  it('clears analyticsCache when a decrypted backup is restored', async () => {
    await seedDatabase()
    await db.table('analyticsCache').add(analyticsRow)
    expect(await db.table('analyticsCache').count()).toBe(1)
    const report = await restoreBundle(opened, 'replace')
    expect(report.ok).toBe(true)
    expect(report.perTable.analyticsCache?.willWrite).toBe(0)
    expect(await db.table('analyticsCache').count()).toBe(0)
  })

  it('touches no database until the passphrase has opened the file', { timeout: 20000 }, async () => {
    await seedDatabase()
    const before = await snapshot()
    const spies: { mock: { calls: unknown[] } }[] = [vi.spyOn(db, 'transaction')]
    // Table methods live on the prototype chain (Dexie's own Table class, below the per-database subclass).
    for (let proto = Object.getPrototypeOf(db.table('accounts')) as Record<string, (...a: unknown[]) => unknown> | null;
      proto !== null && proto !== Object.prototype; proto = Object.getPrototypeOf(proto) as typeof proto) {
      for (const name of Object.getOwnPropertyNames(proto)) {
        if (name !== 'constructor' && typeof proto[name] === 'function') spies.push(vi.spyOn(proto, name))
      }
    }
    expect(spies.length).toBeGreaterThan(10)
    const wrong = await openEncryptedBackup(envelope, OTHER_PASS)
    expect(wrong.ok).toBe(false)
    if (!wrong.ok) {
      expect(wrong.report.refusedReason).toBe('cannot-open')
      expect(wrong.report.perTable).toEqual({})
      expectPlainOwnerText(wrong.report.detail)
    }
    const right = await openEncryptedBackup(envelope, PASS)
    expect(right.ok).toBe(true)
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
    vi.restoreAllMocks()
    expect(await snapshot()).toEqual(before)
  })

  it('restores an encrypted backup onto a fresh install with replace, salt and every table intact', async () => {
    await seedDatabase() // a fresh install makes its own salt
    const report = await restoreBundle(opened, 'replace')
    expect(report.ok).toBe(true)
    expect(await snapshot()).toEqual({ ...bundle, exportedAt: '' })
    expect((await getSettings()).privacy.accountSalt).toBe(saltOf(bundle))
  })
})
