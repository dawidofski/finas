import { fold } from '../lib/text'
import { sha256Hex } from '../lib/hash'
import { ImportError } from './detect'

/**
 * The privacy boundary (design 14.1). The account number becomes a salted SHA-256 fingerprint; the holder's name is
 * tokenised, used to scrub descriptions, and discarded. Neither is ever persisted.
 */

/** Counts only. A report that quoted what it redacted would defeat the redaction. */
export interface ScrubReport {
  descriptionsScrubbed: number
  tokensUsed: number
}

export interface Header {
  readonly accountNumber: string
  readonly holderName: string
  readonly exportedAt: string
}

const MARKER = '[redacted]'
const MIN_TOKEN_LENGTH = 3
const MIN_ACCOUNT_DIGITS = 8
const MAX_ACCOUNT_DIGITS = 34 // an IBAN has at most 34 characters

/** Accent-folded, upper-cased: the form in which tokens and description words are compared. */
const foldUpper = (text: string): string => fold(text).toUpperCase()

/**
 * The module's single definition of "a word": letters, digits and combining marks. The holder tokeniser and the
 * scrubber both use it, so they cannot disagree about what a token is (a hyphenated or apostrophe name, a "SURNAME,
 * NAME" header, or an accent written as a base letter plus a combining mark, which must not split a word in two).
 */
const WORD = /[\p{L}\p{N}\p{M}]+/gu
const wordsOf = (text: string): Array<{ text: string; index: number }> =>
  Array.from(text.matchAll(WORD), (m) => ({ text: m[0], index: m.index }))

/** What may sit between two name words without breaking a run: spaces, hyphen, apostrophe, comma. */
const RUN_JOINER = /^[\s\-'’,]+$/

/**
 * The value of a header entry. ING writes the block in more than one layout, and both are read:
 *   - label in the first column, value in a later one ("Número de cuenta" | "…"), or "Label: value" in one cell;
 *   - a title in the first column and the label further right, indented and ending in a colon, with the value in the
 *     next filled cell ("Movimientos de la Cuenta" | "" | "  Número de cuenta:" | "…"). This is what the bank's own
 *     export has.
 * So the label is looked for in EVERY cell of the first rows, compared with spaces, case, accents and a closing colon
 * ignored, and the value is what follows the colon in that cell, or else the next filled cell to its right.
 */
function headerValue(grid: string[][], label: string): string {
  const wanted = foldUpper(label)
  for (const row of grid.slice(0, 10)) {
    for (let i = 0; i < row.length; i++) {
      const cell = (row[i] ?? '').trim()
      const folded = foldUpper(cell)
      if (folded !== wanted && !folded.startsWith(`${wanted}:`)) continue
      const inline = cell.includes(':') ? cell.slice(cell.indexOf(':') + 1).trim() : ''
      const value = inline || (row.slice(i + 1).find((c) => c.trim() !== '') ?? '').trim()
      if (value) return value
    }
  }
  throw new ImportError('unreadable', `The header block has no "${label}" entry, so this does not look like an ING export.`)
}

/**
 * Reads the header block. The returned account number and holder are plaintext because the pipeline needs them for
 * exactly two operations, fingerprinting and scrubbing, and must keep neither. They are defined non-enumerable so a
 * spread, `JSON.stringify`, structured clone or a Dexie `put` of this object cannot carry them into storage by
 * accident; they remain readable by name.
 */
export function parseHeader(grid: string[][]): Header {
  const accountNumber = headerValue(grid, 'Número de cuenta')
  const holderName = headerValue(grid, 'Titular')
  digitsOf(accountNumber) // refuses an implausible number here, before anything is fingerprinted
  const header = { exportedAt: headerValue(grid, 'Fecha exportación') }
  Object.defineProperties(header, {
    accountNumber: { value: accountNumber, enumerable: false },
    holderName: { value: holderName, enumerable: false },
  })
  return header as Header
}

/**
 * Digits only. A value that cannot be an account number is refused rather than hashed: every such value would
 * collapse onto one fingerprint and merge unrelated accounts. The message never quotes the input.
 *
 * Known residual: the digits of an IBAN include its check digits, so if ING ever changes the number's format the
 * fingerprint changes and a second account appears. Recorded, not solved blind.
 */
function digitsOf(accountNumber: string): string {
  const digits = accountNumber.replace(/\D/g, '')
  if (digits.length < MIN_ACCOUNT_DIGITS || digits.length > MAX_ACCOUNT_DIGITS) {
    throw new ImportError('unreadable', 'The account number in the header is not a plausible account number.')
  }
  return digits
}

/**
 * SHA-256 over the digits plus the per-installation salt, hex. How a later import recognises its account.
 *
 * STABILITY CONTRACT: the exact input string, `${digits}|${salt}` (digits only, in that order, with that separator),
 * is permanent. Changing the separator, the digit extraction or the order yields a different fingerprint for the same
 * account, which looks like a new account: every stored account would silently stop matching its own transactions on
 * the next import. A change would need a migration that re-fingerprints the stored accounts; it must never be
 * recomputed on read.
 */
export async function fingerprintAccount(accountNumber: string, salt: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${digitsOf(accountNumber)}|${salt}`)
  return sha256Hex(bytes)
}

/** Permitted and stored, subject to `privacy.storeLast4` (design 34.5): it labels the account legibly. */
export function last4Of(accountNumber: string): string {
  return digitsOf(accountNumber).slice(-4)
}

/**
 * The holder's words, accent-folded and upper-cased, with fragments under three characters dropped because scrubbing
 * them would mangle merchants. The floor applies AFTER folding and so drops short name parts such as "DE", "LA" or
 * "JO". Tokenised with the scrubber's own word definition, so "GARCIA-LOPEZ", "O'BRIEN" and "TESTER, PRUEBA" yield
 * tokens the scrubber can actually match.
 */
export function nameTokens(holderName: string): string[] {
  return [...new Set(wordsOf(holderName).map((w) => foldUpper(w.text)))].filter((t) => t.length >= MIN_TOKEN_LENGTH)
}

interface Scrubbed {
  text: string
  matched: Set<string>
}

/**
 * Whole-word, accent- and case-insensitive. Canonical: a run of name words separated only by joiners becomes exactly
 * one marker, so how many tokens matched is not observable in the output. That is for what the owner reads; the
 * duplicate key does not depend on the description (design 37), so nothing here is load-bearing for duplicates.
 */
function scrub(text: string, tokens: string[]): Scrubbed {
  const wanted = new Set(tokens.map(foldUpper))
  const matched = new Set<string>()
  let out = ''
  let last = 0
  let runEnd = -1 // end of the redaction just written, or -1 when the previous word was not a match
  for (const word of wordsOf(text)) {
    const start = word.index
    const folded = foldUpper(word.text)
    if (!wanted.has(folded)) continue
    matched.add(folded)
    // Inside a run the joiner and the word are swallowed: the marker is already written.
    if (!(runEnd >= 0 && RUN_JOINER.test(text.slice(runEnd, start)))) out += text.slice(last, start) + MARKER
    last = start + word.text.length
    runEnd = last
  }
  return { text: out + text.slice(last), matched }
}

export function scrubDescription(text: string, tokens: string[]): string {
  return scrub(text, tokens).text
}

/** Scrubs a batch and reports counts only. */
export function scrubAll(descriptions: string[], tokens: string[]): { descriptions: string[]; report: ScrubReport } {
  const used = new Set<string>()
  let descriptionsScrubbed = 0
  const scrubbed = descriptions.map((description) => {
    const result = scrub(description, tokens)
    if (result.matched.size > 0) descriptionsScrubbed += 1
    for (const token of result.matched) used.add(token)
    return result.text
  })
  return { descriptions: scrubbed, report: { descriptionsScrubbed, tokensUsed: used.size } }
}
