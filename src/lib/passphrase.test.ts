import { describe, expect, it } from 'vitest'
import { PASSPHRASE_MESSAGES, PASSPHRASE_MIN_CHARS, newPassphraseProblem, passphraseBytes } from './passphrase'
import { causalWords, jargonWords, shamingWords } from '../test/bannedWords'

const twelve = 'abcdefghijkl'
const composed = 'café-café-café' // e with acute as one character
const decomposed = 'café-café-café' // the same letters typed as e plus a combining accent

describe('passphrase rules', () => {
  it('refuses a passphrase shorter than twelve characters, counting characters rather than bytes', () => {
    expect(PASSPHRASE_MIN_CHARS).toBe(12)
    const eleven = twelve.slice(0, 11)
    expect(newPassphraseProblem(eleven, eleven)).toBe('too-short')
    expect(newPassphraseProblem(twelve, twelve)).toBeNull()
    // eleven characters, 22 bytes: a byte count would let it through
    const tildes = 'ñ'.repeat(11)
    expect(new TextEncoder().encode(tildes).length).toBe(22)
    expect(newPassphraseProblem(tildes, tildes)).toBe('too-short')
    expect(newPassphraseProblem('ñ'.repeat(12), 'ñ'.repeat(12))).toBeNull()
    // a character outside the basic plane is one character, not two (JavaScript length counts it as two)
    const astral = '\u{1F600}'.repeat(6)
    expect(astral.length).toBe(12)
    expect(newPassphraseProblem(astral, astral)).toBe('too-short')
    expect(newPassphraseProblem('', '')).toBe('too-short')
  })

  it('treats a composed and a decomposed accented letter as the same passphrase', () => {
    expect(composed).not.toBe(decomposed)
    expect(newPassphraseProblem(composed, decomposed)).toBeNull()
    expect(Array.from(passphraseBytes(decomposed))).toEqual(Array.from(passphraseBytes(composed)))
    // the length is counted after joining: eleven composed letters typed decomposed are still eleven
    const shortDecomposed = 'é'.repeat(11)
    expect(shortDecomposed.length).toBe(22)
    expect(newPassphraseProblem(shortDecomposed, shortDecomposed)).toBe('too-short')
    expect(newPassphraseProblem('é'.repeat(12), 'é'.repeat(12))).toBeNull()
  })

  it('refuses a new passphrase that starts or ends with a space, and says so plainly', () => {
    for (const edged of [' ' + twelve, twelve + ' ', '\t' + twelve, twelve + '\n', ' ' + twelve, twelve + '　']) {
      expect(newPassphraseProblem(edged, edged)).toBe('edge-space')
    }
    // either box, not only the first
    expect(newPassphraseProblem(twelve, twelve + ' ')).toBe('edge-space')
    // twelve spaces are long enough, and still refused for their edges
    expect(newPassphraseProblem(' '.repeat(12), ' '.repeat(12))).toBe('edge-space')
    // spaces inside are the owner's business
    expect(newPassphraseProblem('one two three four', 'one two three four')).toBeNull()
    expect(PASSPHRASE_MESSAGES['edge-space']).toMatch(/space/i)
  })

  it('trims edge whitespace when turning a passphrase into bytes, and nothing inside it', () => {
    // Restore trims what export refuses, so a passphrase pasted with a stray space or newline still opens the file.
    const plain = Array.from(passphraseBytes('correct horse battery'))
    expect(Array.from(passphraseBytes('  correct horse battery\n'))).toEqual(plain)
    expect(Array.from(passphraseBytes(' correct horse battery　'))).toEqual(plain)
    expect(plain).toEqual(Array.from(new TextEncoder().encode('correct horse battery')))
    // inside is untouched: one space and two spaces are different passphrases
    expect(Array.from(passphraseBytes('correct  horse battery'))).not.toEqual(plain)
    expect(Array.from(passphraseBytes('a b'))).toEqual([97, 32, 98])
    expect(passphraseBytes('   ').length).toBe(0)
  })

  it('reports two different typings as a mismatch, and two NFC-equal ones as a match', () => {
    expect(newPassphraseProblem(twelve, twelve + 'x')).toBe('mismatch')
    expect(newPassphraseProblem(twelve, twelve.toUpperCase())).toBe('mismatch')
    expect(newPassphraseProblem(twelve, twelve)).toBeNull()
    expect(newPassphraseProblem(composed, decomposed)).toBeNull()
    // a short pair that differs is told it is short, which is the thing to fix first
    expect(newPassphraseProblem('short', 'other')).toBe('too-short')
  })

  it('words every problem without jargon, shame or a strength score', () => {
    const problems = ['too-short', 'edge-space', 'mismatch'] as const
    expect(Object.keys(PASSPHRASE_MESSAGES).sort()).toEqual([...problems].sort())
    for (const p of problems) {
      const m = PASSPHRASE_MESSAGES[p]
      expect(m.length).toBeGreaterThan(20)
      expect(m).not.toMatch(/nfc|utf|unicode|entropy|normali|byte|code ?point|encod|invalid|illegal|error|weak|strong|strength|bad|wrong|stupid|obvious|guess|crack/i)
      expect(m).not.toMatch(/%|\bscore\b/i)
      // The project's shared lists, not only the words above: these sentences reach the owner on the Settings screen.
      for (const list of [causalWords, jargonWords, shamingWords]) expect(m).not.toMatch(list)
    }
    expect(PASSPHRASE_MESSAGES['too-short']).toContain('12')
  })
})
