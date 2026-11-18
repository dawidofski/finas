import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import { db } from './db'
import { seedDatabase } from './seed'
import { exportBundle } from './backup'
import type { Bundle } from './backup'
import { bytesToBase64, base64ToBytes } from '../lib/base64'
import { passphraseBytes } from '../lib/passphrase'
import { causalWords, jargonWords, shamingWords } from '../test/bannedWords'
import {
  ENCRYPTED_FORMAT, ENCRYPTED_VERSION, KDF, CIPHER, PBKDF2_ITERATIONS, PBKDF2_MAX_ITERATIONS, SALT_BYTES, IV_BYTES,
  ENVELOPE_KEYS, headerBytes, encryptBundle, checkEnvelope, decryptEnvelope,
} from './encryptedBackup'
import type { Envelope, EnvelopeHeader } from './encryptedBackup'

const PASS = 'cuatro palabras sin relacion'
const OTHER_PASS = 'otra frase totalmente distinta'
const MERCHANT = 'Comercio Ejemplo Zeta'
const AMOUNT_CENTS = -987_654
const OWNER_FACING_JARGON = /AES|PBKDF2|salt|\bIV\b|decrypt|authentication tag/i

let bundle: Bundle
let fileText: string
let envelope: Envelope

// The fixture is made once (one derivation) and shared; tests never write to the database.
beforeAll(async () => {
  await db.delete(); await db.open()
  await seedDatabase()
  await db.table('accounts').bulkAdd([{
    id: 'acc.1', fingerprint: 'a'.repeat(64), label: 'Cuenta Ejemplo', last4: null, currency: 'EUR', createdAt: 1_700_000_000_000, archived: false,
  }])
  await db.table('transactions').bulkAdd([{
    id: 'tx.1', accountId: 'acc.1', valueDate: '2026-11-02', amountCents: AMOUNT_CENTS, balanceCents: 5_000_000,
    description: MERCHANT, comment: null, ingCategory: 'Compras', ingSubcategory: 'Compras (otros)', kind: 'spend',
    dedupKey: 'dedup-1', importId: 'imp.1', fileSeq: 1, roundupParentId: null, createdAt: 1_700_000_000_000, deletedAt: null,
  }])
  bundle = await exportBundle()
  fileText = await encryptBundle(bundle, PASS)
  const checked = checkEnvelope(JSON.parse(fileText))
  if (!checked.ok) throw new Error('the fixture must pass its own structure check')
  envelope = checked.envelope
}, 20000)

afterEach(() => { vi.restoreAllMocks() })

const own = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(bytes)

const flipByte = (data: string): string => {
  const bytes = base64ToBytes(data) as Uint8Array
  bytes[5] = (bytes[5] ?? 0) ^ 1
  return bytesToBase64(bytes)
}

function expectPlainOwnerText(detail: string) {
  for (const list of [causalWords, jargonWords, shamingWords]) expect(detail).not.toMatch(list)
  expect(detail).not.toMatch(OWNER_FACING_JARGON)
  expect(detail.endsWith('Nothing was changed.')).toBe(true)
}

describe('encrypted envelope', () => {
  it('round-trips an exported database through encrypt and decrypt, every table identical', async () => {
    const opened = await decryptEnvelope(envelope, PASS)
    expect(opened.ok).toBe(true)
    if (opened.ok) {
      expect(opened.bundle).toEqual(JSON.parse(JSON.stringify(bundle)))
      expect(Object.keys((opened.bundle as Bundle).tables).sort()).toEqual(db.tables.map(t => t.name).sort())
    }
  }, 20000)

  it('refuses a wrong passphrase with cannot-open, before anything is written', async () => {
    const writes = vi.spyOn(db.table('transactions'), 'bulkPut')
    const opened = await decryptEnvelope(envelope, OTHER_PASS)
    expect(opened.ok).toBe(false)
    if (!opened.ok) {
      expect(opened.reason).toBe('cannot-open')
      expect(opened.detail).toMatch(/passphrase may differ/)
      expect(opened.detail).toMatch(/cannot tell which/)
      expectPlainOwnerText(opened.detail)
    }
    expect(writes).not.toHaveBeenCalled()
  }, 20000)

  it('refuses a file with one ciphertext byte flipped with the same reason and the same words', async () => {
    const wrong = await decryptEnvelope(envelope, OTHER_PASS)
    const flipped = await decryptEnvelope({ ...envelope, data: flipByte(envelope.data) }, PASS)
    expect(wrong.ok).toBe(false)
    expect(flipped.ok).toBe(false)
    if (!wrong.ok && !flipped.ok) {
      expect(flipped.reason).toBe(wrong.reason)
      expect(flipped.detail).toBe(wrong.detail)
    }
  }, 20000)

  it('refuses a data field cut short, even though the file still parses', async () => {
    const cut = bytesToBase64((base64ToBytes(envelope.data) as Uint8Array).slice(0, 40))
    const checked = checkEnvelope(JSON.parse(JSON.stringify({ ...envelope, data: cut })))
    expect(checked.ok).toBe(true)
    if (checked.ok) {
      const opened = await decryptEnvelope(checked.envelope, PASS)
      expect(opened.ok).toBe(false)
      if (!opened.ok) expect(opened.reason).toBe('cannot-open')
    }
  }, 20000)

  it('refuses a file whose iteration count or iv was edited, since the header is authenticated', async () => {
    const otherIv = bytesToBase64(new Uint8Array(IV_BYTES).fill(7))
    expect(otherIv).not.toBe(envelope.iv)
    const edited = await decryptEnvelope({ ...envelope, iv: otherIv }, PASS)
    expect(edited.ok).toBe(false)
    const checked = checkEnvelope({ ...envelope, iterations: PBKDF2_ITERATIONS + 1 })
    expect(checked.ok).toBe(true)
    if (checked.ok) expect((await decryptEnvelope(checked.envelope, PASS)).ok).toBe(false)

    // The header is bound by additional data, not only by being an input to the key: the same key and iv sealing the same
    // text WITHOUT the header bound in must not open.
    const base = await crypto.subtle.importKey('raw', own(passphraseBytes(PASS)), 'PBKDF2', false, ['deriveKey'])
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt: own(base64ToBytes(envelope.salt) as Uint8Array), iterations: envelope.iterations },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt'])
    const unbound = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: own(base64ToBytes(envelope.iv) as Uint8Array) }, key, new TextEncoder().encode(JSON.stringify(bundle)))
    const bare = await decryptEnvelope({ ...envelope, data: bytesToBase64(new Uint8Array(unbound)) }, PASS)
    expect(bare.ok).toBe(false)
  }, 20000)

  it('refuses a newer envelope version as newer-format without deriving a key', () => {
    const derive = vi.spyOn(crypto.subtle, 'deriveKey')
    const checked = checkEnvelope({ ...envelope, version: ENCRYPTED_VERSION + 1 })
    expect(checked.ok).toBe(false)
    if (!checked.ok) {
      expect(checked.reason).toBe('newer-format')
      expect(checked.detail).toMatch(/newer version/)
      expectPlainOwnerText(checked.detail)
    }
    const bad = checkEnvelope({ ...envelope, salt: 'not base64!' })
    expect(bad.ok).toBe(false)
    if (!bad.ok) {
      expect(bad.reason).toBe('malformed')
      expectPlainOwnerText(bad.detail)
    }
    expect(derive).not.toHaveBeenCalled()
  })

  it('opens a file with a passphrase typed in decomposed form and a trailing space', async () => {
    const composed = 'mañana será otro día'
    expect(composed.normalize('NFD')).not.toBe(composed)
    const text = await encryptBundle(bundle, composed)
    const checked = checkEnvelope(JSON.parse(text))
    expect(checked.ok).toBe(true)
    if (checked.ok) {
      const opened = await decryptEnvelope(checked.envelope, composed.normalize('NFD') + ' ')
      expect(opened.ok).toBe(true)
    }
    await expect(encryptBundle(bundle, composed + ' ')).rejects.toThrow()
    await expect(encryptBundle(bundle, 'corta')).rejects.toThrow()
  }, 20000)

  it('writes no financial data in clear: only the eight envelope keys, and none of the seeded figures or names', () => {
    expect(Object.keys(JSON.parse(fileText) as object)).toEqual([...ENVELOPE_KEYS])
    expect(fileText.startsWith('{"format":"finance-encrypted"')).toBe(true)
    const needles = [MERCHANT, 'Cuenta Ejemplo', String(AMOUNT_CENTS), String(Math.abs(AMOUNT_CENTS)), 'schemaVersion', 'exportedAt',
      ...db.tables.map(t => t.name)]
    for (const needle of needles) expect(fileText).not.toContain(needle)
    expect(envelope.format).toBe(ENCRYPTED_FORMAT)
    expect(envelope.kdf).toBe(KDF)
    expect(envelope.cipher).toBe(CIPHER)
    expect((base64ToBytes(envelope.salt) as Uint8Array).length).toBe(SALT_BYTES)
    expect((base64ToBytes(envelope.iv) as Uint8Array).length).toBe(IV_BYTES)
  })

  it('uses a fresh salt and iv for every export', async () => {
    const second = JSON.parse(await encryptBundle(bundle, PASS)) as Envelope
    expect(second.salt).not.toBe(envelope.salt)
    expect(second.iv).not.toBe(envelope.iv)
    expect(second.data).not.toBe(envelope.data)
  }, 20000)

  it('opens a file written with a higher iteration count, and refuses one outside the bounds before deriving', async () => {
    const header: EnvelopeHeader = {
      format: ENCRYPTED_FORMAT, version: ENCRYPTED_VERSION, kdf: KDF, iterations: 700_000, cipher: CIPHER,
      salt: bytesToBase64(new Uint8Array(SALT_BYTES).fill(3)), iv: bytesToBase64(new Uint8Array(IV_BYTES).fill(5)),
    }
    const base = await crypto.subtle.importKey('raw', own(passphraseBytes(PASS)), 'PBKDF2', false, ['deriveKey'])
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt: own(base64ToBytes(header.salt) as Uint8Array), iterations: header.iterations },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt'])
    const sealed = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: own(base64ToBytes(header.iv) as Uint8Array), additionalData: own(headerBytes(header)) },
      key, new TextEncoder().encode(JSON.stringify(bundle)))
    const checked = checkEnvelope({ ...header, data: bytesToBase64(new Uint8Array(sealed)) })
    expect(checked.ok).toBe(true)
    if (checked.ok) expect((await decryptEnvelope(checked.envelope, PASS)).ok).toBe(true)

    const derive = vi.spyOn(crypto.subtle, 'deriveKey')
    for (const iterations of [PBKDF2_MAX_ITERATIONS + 1, 599_999, 0]) {
      const out = { ...envelope, iterations }
      expect(checkEnvelope(out).ok).toBe(false)
      expect((await decryptEnvelope(out, PASS)).ok).toBe(false)
    }
    expect(derive).not.toHaveBeenCalled()
  }, 20000)
})
