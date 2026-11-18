/**
 * The encrypted backup envelope: the JSON text of a Bundle sealed with AES-GCM under a key derived from the owner's
 * passphrase with PBKDF2. WebCrypto only, nothing leaves the device, no database is touched here.
 *
 * What is in clear in the file: the format marker, the version, the KDF name and iteration count, the cipher name, the
 * salt and the IV. Nothing else. All seven are authenticated as additional data (headerBytes), so editing any of them
 * makes opening fail instead of quietly changing what is derived.
 *
 * AES-GCM cannot tell a wrong passphrase from an altered file, so both produce one and the same refusal, in words that
 * claim neither. The passphrase is never stored, logged or put in a message.
 */
import type { Bundle } from './backup'
import { bytesToBase64, base64ToBytes } from '../lib/base64'
import { newPassphraseProblem, passphraseBytes, PASSPHRASE_MESSAGES } from '../lib/passphrase'

export const ENCRYPTED_FORMAT = 'finance-encrypted'
export const ENCRYPTED_VERSION = 1
export const KDF = 'PBKDF2-SHA-256'
export const CIPHER = 'AES-256-GCM'
export const PBKDF2_ITERATIONS = 600_000 // what new files are written with; may rise
export const PBKDF2_MIN_ITERATIONS = 600_000 // never raised: older files must keep opening
export const PBKDF2_MAX_ITERATIONS = 10_000_000 // stops a crafted header from hanging the tab
export const SALT_BYTES = 16
export const IV_BYTES = 12
/** Exactly the keys a file may carry, in the order they are written. */
export const ENVELOPE_KEYS = ['format', 'version', 'kdf', 'iterations', 'cipher', 'salt', 'iv', 'data'] as const

export type EnvelopeHeader = {
  format: typeof ENCRYPTED_FORMAT; version: number; kdf: typeof KDF; iterations: number
  cipher: typeof CIPHER; salt: string; iv: string
}
export type Envelope = EnvelopeHeader & { data: string }

/** AES-GCM appends a 16-byte tag, so anything shorter cannot be a sealed file. */
const TAG_BYTES = 16

/** WebCrypto wants a view over a plain ArrayBuffer; this copies into one. */
const own = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(bytes)

const NOTHING_CHANGED = 'Nothing was changed.'
const CANNOT_OPEN =
  'This backup could not be opened. The passphrase may differ from the one used to make it, or the file may have changed or been damaged since, and the app cannot tell which. ' +
  NOTHING_CHANGED
const NEWER_FORMAT =
  'This backup was made by a newer version of the app. Please update the app, then try again. ' + NOTHING_CHANGED
const MALFORMED =
  'This looks like an encrypted backup, but its details are incomplete or not ones this app can read. The file may have been changed or damaged. ' +
  NOTHING_CHANGED

/** The header in a fixed order, as AES-GCM additional data: altering any header field makes opening fail. */
export function headerBytes(h: EnvelopeHeader): Uint8Array {
  return new TextEncoder().encode(JSON.stringify([h.format, h.version, h.kdf, h.iterations, h.cipher, h.salt, h.iv]))
}

async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', own(passphraseBytes(passphrase)), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: own(salt), iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage],
  )
}

/** Whole-file text. Throws if `newPassphraseProblem(p, p)` is not null, so no file can need a passphrase the open path reads differently. */
export async function encryptBundle(bundle: Bundle, passphrase: string): Promise<string> {
  const problem = newPassphraseProblem(passphrase, passphrase)
  if (problem !== null) throw new Error(PASSPHRASE_MESSAGES[problem])
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const header: EnvelopeHeader = {
    format: ENCRYPTED_FORMAT, version: ENCRYPTED_VERSION, kdf: KDF, iterations: PBKDF2_ITERATIONS, cipher: CIPHER,
    salt: bytesToBase64(salt), iv: bytesToBase64(iv),
  }
  const key = await deriveKey(passphrase, salt, header.iterations, 'encrypt')
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: own(headerBytes(header)) },
    key,
    new TextEncoder().encode(JSON.stringify(bundle)),
  )
  const envelope: Envelope = { ...header, data: bytesToBase64(new Uint8Array(sealed)) }
  return JSON.stringify(envelope)
}

export type EnvelopeCheck =
  | { ok: true; envelope: Envelope }
  | { ok: false; reason: 'newer-format' | 'malformed'; detail: string }

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

const malformed = (): EnvelopeCheck => ({ ok: false, reason: 'malformed', detail: MALFORMED })

/** Structure only, no crypto: version, known kdf/cipher, iterations in bounds, salt and iv the right decoded length. */
export function checkEnvelope(parsed: unknown): EnvelopeCheck {
  if (!isRecord(parsed) || parsed.format !== ENCRYPTED_FORMAT) return malformed()
  const { version } = parsed
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return malformed()
  // A newer version may have other fields, so it is refused before anything else about it is judged.
  if (version > ENCRYPTED_VERSION) return { ok: false, reason: 'newer-format', detail: NEWER_FORMAT }
  const keys = Object.keys(parsed)
  if (keys.length !== ENVELOPE_KEYS.length || !ENVELOPE_KEYS.every(k => keys.includes(k))) return malformed()
  const { kdf, iterations, cipher, salt, iv, data } = parsed
  if (kdf !== KDF || cipher !== CIPHER) return malformed()
  if (typeof iterations !== 'number' || !Number.isInteger(iterations)) return malformed()
  if (iterations < PBKDF2_MIN_ITERATIONS || iterations > PBKDF2_MAX_ITERATIONS) return malformed()
  if (typeof salt !== 'string' || base64ToBytes(salt)?.length !== SALT_BYTES) return malformed()
  if (typeof iv !== 'string' || base64ToBytes(iv)?.length !== IV_BYTES) return malformed()
  if (typeof data !== 'string') return malformed()
  const sealed = base64ToBytes(data)
  if (sealed === null || sealed.length < TAG_BYTES) return malformed()
  return {
    ok: true,
    envelope: { format: ENCRYPTED_FORMAT, version, kdf, iterations, cipher, salt, iv, data },
  }
}

export type Opened = { ok: true; bundle: unknown } | { ok: false; reason: 'cannot-open'; detail: string }

const cannotOpen = (): Opened => ({ ok: false, reason: 'cannot-open', detail: CANNOT_OPEN })

/** Derives with the header's own iteration count. Touches no database. */
export async function decryptEnvelope(envelope: Envelope, passphrase: string): Promise<Opened> {
  // Re-checked here, so an out-of-bounds count can never reach the derivation whatever the caller did before.
  const checked = checkEnvelope(envelope)
  if (!checked.ok) return cannotOpen()
  const e = checked.envelope
  const salt = base64ToBytes(e.salt)
  const iv = base64ToBytes(e.iv)
  const sealed = base64ToBytes(e.data)
  if (salt === null || iv === null || sealed === null) return cannotOpen()
  try {
    const key = await deriveKey(passphrase, salt, e.iterations, 'decrypt')
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: own(iv), additionalData: own(headerBytes(e)) }, key, own(sealed))
    const text = new TextDecoder('utf-8', { fatal: true }).decode(plain)
    return { ok: true, bundle: JSON.parse(text) as unknown }
  } catch {
    return cannotOpen() // never inspect the error: a wrong passphrase and a changed file look the same
  }
}
