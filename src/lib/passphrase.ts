/**
 * The rules for the passphrase that locks a backup file. A passphrase is a secret: nothing here logs it, stores it, or
 * puts any of it (or its length) into a message. Every message names the rule, never the input.
 */
export const PASSPHRASE_MIN_CHARS = 12

export type PassphraseProblem = 'too-short' | 'edge-space' | 'mismatch'

/**
 * The same visible text must give the same passphrase on another device and keyboard months later, so it is joined into
 * its composed form first (an accented letter typed as one character or as a letter plus a separate accent is the same).
 * Not locale-dependent.
 */
function joined(text: string): string {
  return text.normalize('NFC')
}

/** Characters as a person counts them: not UTF-16 units (an emoji is two) and not bytes (an accented letter is two). */
function characterCount(text: string): number {
  return Array.from(text).length
}

function hasEdgeSpace(text: string): boolean {
  return text !== text.trim()
}

/**
 * Export only: checks a new passphrase typed twice. Length is code points after NFC; the comparison is after NFC.
 *
 * ASYMMETRY, keep both halves together: a new passphrase with a space (or tab, newline) at either end is REFUSED here,
 * and passphraseBytes below TRIMS those same edges when the owner types it again to restore. Trimming on restore is only
 * safe because no backup is ever made with edge spaces; if either half changes, an owner can be locked out of their file.
 */
export function newPassphraseProblem(first: string, second: string): PassphraseProblem | null {
  const a = joined(first)
  const b = joined(second)
  if (hasEdgeSpace(a) || hasEdgeSpace(b)) return 'edge-space'
  if (characterCount(a) < PASSPHRASE_MIN_CHARS) return 'too-short'
  if (a !== b) return 'mismatch'
  return null
}

/**
 * The one place a passphrase becomes bytes: NFC, edges trimmed, UTF-8. Both encrypt and decrypt call it.
 *
 * The trim is the other half of the edge-space refusal in newPassphraseProblem: restore forgives a stray space or newline
 * from pasting, and that is safe only because export refuses to make a passphrase that has one.
 */
export function passphraseBytes(passphrase: string): Uint8Array {
  return new TextEncoder().encode(joined(passphrase).trim())
}

/** Owner-facing sentence for each problem. */
export const PASSPHRASE_MESSAGES: Record<PassphraseProblem, string> = {
  'too-short': `Please use at least ${PASSPHRASE_MIN_CHARS} characters.`,
  'edge-space': 'Please remove the space at the start or end of your passphrase. Spaces in the middle are fine.',
  mismatch: 'The two passphrases are not the same. Please type them again.',
}
