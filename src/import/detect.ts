/**
 * Format detection by content, never by filename. The owner's savings export is called `movements-15112026.xls`
 * and is really a ZIP, so the extension is not just unreliable here, it is wrong. This function does not even
 * accept a name.
 */

export type ImportErrorCode =
  | 'not-a-spreadsheet'
  | 'corrupt-archive'
  | 'empty'
  | 'too-large'
  | 'unreadable'
  | 'unsupported-format'
  /** Overlaps imported days yet shares no transaction with them, and the owner has not confirmed. */
  | 'divergent-history'
  /** The ledger changed between preview and commit (another tab imported); the file must be chosen again. */
  | 'stale-preview'
  /** A correction was aimed at a row that is not being imported. */
  | 'invalid-correction'
  /** This exact file (by hash) was imported before. Nothing to do. */
  | 'already-imported'
  /** The file read correctly but no row in it would be written: the owner may need a wider export. */
  | 'nothing-new'

/**
 * A file that cannot be imported, with a message written for the owner (shown as-is on the import screen).
 * Everything the reading layer can go wrong with becomes one of these; nothing else should reach the screen.
 */
export class ImportError extends Error {
  readonly code: ImportErrorCode

  constructor(code: ImportErrorCode, message: string) {
    super(message)
    this.name = 'ImportError'
    this.code = code
  }
}

export type DetectedFormat = 'xlsx' | 'pdf' | 'csv' | 'unknown'

/** How much of the start of the file is inspected when deciding whether it is delimited text. */
const SNIFF_BYTES = 4096

const startsWith = (bytes: Uint8Array, signature: readonly number[], at = 0): boolean =>
  bytes.length >= at + signature.length && signature.every((byte, i) => bytes[at + i] === byte)

const looksLikeCsv = (bytes: Uint8Array): boolean => {
  const start = startsWith(bytes, [0xef, 0xbb, 0xbf]) ? 3 : 0
  const sample = bytes.subarray(start, start + SNIFF_BYTES)
  if (sample.length === 0) return false
  let delimiter = false
  let newline = false
  for (const byte of sample) {
    if (byte === 0x2c || byte === 0x3b || byte === 0x09) delimiter = true
    else if (byte === 0x0a) newline = true
    else if (byte < 0x20 && byte !== 0x0d) return false // any other control byte: binary, not text
  }
  return delimiter && newline
}

export const detectFormat = (bytes: Uint8Array): DetectedFormat => {
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return 'xlsx' // PK\x03\x04: a ZIP with at least one entry
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) return 'pdf' // %PDF
  if (looksLikeCsv(bytes)) return 'csv'
  return 'unknown'
}
