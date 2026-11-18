import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { enteredBrackets, type BatteryReads } from './run'

/**
 * The entry rule ("a plain array means the gate is unmet, so it does not enter the correction") has ONE copy, here in
 * run.ts, and the Intelligence screen reads its decision from `enteredBrackets` instead of rebuilding it from its
 * rows. This pins each outcome shape's decision, and pins that the screen does not carry a second copy.
 */
const gate = [{ what: 'a gate', met: false }]
const ranked = { bracket: 'strong' }
const contingency = (over: object) => ({ verdict: 'tested', bracket: 'moderate', ...over })
const reads = (over: Partial<Record<keyof BatteryReads, unknown>>): BatteryReads => ({
  mood: ranked, frequency: ranked, stress: ranked, boredom: contingency({}), reasons: contingency({}), week: ranked, payday: ranked, salary: ranked,
  savings: { categories: [{ bracket: 'weak' }] },
  ...over,
}) as unknown as BatteryReads
const ids = (r: BatteryReads) => enteredBrackets(r).map((e) => e.item)

describe('enteredBrackets: the one entry rule', () => {
  it('enters every validly tested relationship', () => {
    expect(ids(reads({}))).toHaveLength(9)
  })

  it('does not enter a relationship whose gate array is unmet, in any of the nine', () => {
    for (const key of ['mood', 'frequency', 'stress', 'boredom', 'reasons', 'week', 'payday', 'salary', 'savings'] as const) {
      expect(ids(reads({ [key]: gate })), key).toHaveLength(8)
    }
  })

  it('enters a tested contingency whose bracket is none, but not a sparse, too-many-categories or withheld one', () => {
    expect(enteredBrackets(reads({ boredom: contingency({ bracket: 'none' }) })).find((e) => e.item === 'boredom-impulse')?.bracket).toBe('none')
    expect(ids(reads({ boredom: contingency({ verdict: 'sparse', bracket: 'none' }) }))).not.toContain('boredom-impulse')
    expect(ids(reads({ boredom: contingency({ verdict: 'too-many-categories', bracket: 'none' }) }))).not.toContain('boredom-impulse')
    expect(ids(reads({ boredom: { withheld: true, why: 'w', n: 0, period: 'p' } }))).not.toContain('boredom-impulse')
  })

  it('enters category savings with no category as a tested none', () => {
    expect(enteredBrackets(reads({ savings: { categories: [] } })).find((e) => e.item === 'category-savings')?.bracket).toBe('none')
  })

  it('is the only copy: the screen reads the decision from it and does not rebuild it from its rows', () => {
    const screen = readFileSync(resolve(import.meta.dirname, '../ui/screens/Intelligence.tsx'), 'utf8')
    expect(screen).toMatch(/judged: enteredBrackets\(reads\)/)
    expect(screen).not.toMatch(/body\.kind === 'looked' \? \[\{ item/)
  })
})
