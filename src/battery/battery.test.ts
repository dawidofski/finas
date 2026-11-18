import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import { BANNED_LISTS, causalWords, jargonWords, noJargon } from '../test/bannedWords'
import { BATTERY, isMet, type BatteryData, type RelationshipId } from './battery'

const ZERO: BatteryData = {
  discretionarySpendsWithMood: 0, moodGroupsOfTen: 0, weeksOfMoodCoverage: 0, stressedSpends: 0,
  unstressedSpends: 0, impulseTaggedSpends: 0, spendsWithReasonAndWorthwhile: 0, weekendsObserved: 0,
  incomeEvents: 0, fullMonths: 0, incomeLevelsWithTwoMonths: 0, monthsObserved: 0,
}
// Exactly §12's minimums, per relationship.
const AT_MIN: Record<RelationshipId, Partial<BatteryData>> = {
  'mood-amount': { discretionarySpendsWithMood: 30, moodGroupsOfTen: 2 },
  'mood-frequency': { weeksOfMoodCoverage: 8 },
  'stress-discretionary': { stressedSpends: 10, unstressedSpends: 10 },
  'boredom-impulse': { impulseTaggedSpends: 20 },
  'reason-worthwhile': { spendsWithReasonAndWorthwhile: 30 },
  weekend: { weekendsObserved: 8 },
  payday: { incomeEvents: 3 },
  'small-purchases': { fullMonths: 1 },
  'salary-lifestyle': { incomeLevelsWithTwoMonths: 2 },
  'category-savings': { monthsObserved: 4 },
}
const ready = (id: RelationshipId, d: BatteryData) => BATTERY.find(r => r.id === id)!.gates(d).every(isMet)

/**
 * THE BANNED-LANGUAGE LISTS ARE READ OUT OF THE FILES THAT OWN THEM, not copied. This file used to carry its own
 * copies marked "reused from", and they had already drifted: the jargon copy had four terms the owning list did not.
 * A drifted copy of a LANGUAGE BAN is the worst kind to have, because it silently permits in one file wording that
 * another forbids.
 *
 * The extraction now lives in src/test/bannedWords.ts and all three readers import it: this file,
 * src/battery/finding.test.ts and src/ui/screens/Intelligence.test.tsx. It had been a local function in each of
 * them, which is three copies of the very mechanism that exists to prevent copies. It cannot live in one of the
 * test files and be imported by the others, because importing a .test.ts module re-registers its describe blocks
 * inside the importing file's suite, so every file would run that file's tests too. Hence a plain module.
 *
 * It is still deliberately brittle -- a reworded owning line makes it throw rather than scan a stale pattern -- and
 * it still probes each list against a word that list exists to forbid, now on import as well as in the wording
 * test below, so a pattern that matches nothing cannot pass silently in any of the three.
 */

/** This file's own source reads: the §12 test-column oracle below checks battery.ts against src/battery/stats.ts. */
const SRC = resolve(import.meta.dirname, '..')

/**
 * The statistics words THIS module adds, which no owning list carries: they are the ones a battery of significance
 * tests would leak and the screens would not. Additions, not a copy -- if any of these ever earns a place in a
 * shared list it should move there and come out of here.
 */
const BATTERY_JARGON = /sample|\bn\b|power|signific/i

/**
 * §12's test column, restated as an oracle the way AT_MIN above restates its minimum-data column, and tied to the
 * primitive in src/battery/stats.ts that actually computes it.
 *
 * This exists because battery.ts declared 'Poisson rate comparison by mood day' for mood-frequency long after the
 * implementation had become a rank comparison of weekly counts, and nothing caught it: the `test` field must never
 * render, so the one wrong value in the module was also the only one invisible to the owner, and the only assertion
 * on it was that the string was truthy. A field nothing displays and nothing checks drifts every time.
 */
const STATISTIC: Record<RelationshipId, { readonly names: string; readonly primitive: string } | null> = {
  'mood-amount': { names: 'Spearman', primitive: 'spearmanRhoBp' },
  'mood-frequency': { names: 'Mann-Whitney', primitive: 'mannWhitneyU' },
  'stress-discretionary': { names: 'Mann-Whitney', primitive: 'mannWhitneyU' },
  'boredom-impulse': { names: 'Chi-square', primitive: 'chiSquareScaled' },
  'reason-worthwhile': { names: 'Chi-square', primitive: 'chiSquareScaled' },
  weekend: { names: 'Mann-Whitney', primitive: 'mannWhitneyU' },
  payday: { names: 'Spearman', primitive: 'spearmanRhoBp' },
  'small-purchases': null,
  'salary-lifestyle': { names: 'Mann-Whitney', primitive: 'mannWhitneyU' },
  'category-savings': { names: 'Spearman', primitive: 'spearmanRhoBp' },
}

describe('the declared battery', () => {
  it('declares exactly the ten relationships of the spec, in its order', () => {
    expect(BATTERY.map(r => r.id)).toEqual([
      'mood-amount', 'mood-frequency', 'stress-discretionary', 'boredom-impulse', 'reason-worthwhile',
      'weekend', 'payday', 'small-purchases', 'salary-lifestyle', 'category-savings',
    ])
  })

  it('states for each unmet gate what is missing and how much more is needed', () => {
    for (const r of BATTERY) {
      const gates = r.gates(ZERO)
      expect(gates.length).toBeGreaterThan(0)
      for (const g of gates) {
        expect(g.have).toBe(0)
        expect(g.need).toBeGreaterThan(0)
        expect(g.what).toContain(`needs ${g.need} `)
        expect(g.what).toContain('You have 0')
        expect(g.what).toContain(`${g.need} more`)
      }
    }
    // One short of the minimum says one more is needed, in the singular.
    const g = BATTERY.find(r => r.id === 'boredom-impulse')!.gates({ ...ZERO, impulseTaggedSpends: 19 })[0]!
    expect(g.what).toContain('You have 19, so 1 more purchase is needed')
    // At the minimum nothing more is asked for.
    const met = BATTERY.find(r => r.id === 'boredom-impulse')!.gates({ ...ZERO, impulseTaggedSpends: 20 })[0]!
    expect(met.what).toContain('You have enough')
    expect(met.what).not.toContain('more')
  })

  it('runs a relationship at exactly its minimum sample and withholds one below it', () => {
    for (const r of BATTERY) {
      const min = AT_MIN[r.id]
      const atMin: BatteryData = { ...ZERO, ...min }
      expect(ready(r.id, atMin)).toBe(true)
      // Take each field of the minimum down by one, alone: every gate must withhold at its boundary.
      for (const k of Object.keys(min) as (keyof BatteryData)[]) {
        expect(ready(r.id, { ...atMin, [k]: min[k]! - 1 })).toBe(false)
      }
    }
    // The spec's own example: 30 runs, 29 does not.
    expect(ready('mood-amount', { ...ZERO, discretionarySpendsWithMood: 30, moodGroupsOfTen: 2 })).toBe(true)
    expect(ready('mood-amount', { ...ZERO, discretionarySpendsWithMood: 29, moodGroupsOfTen: 2 })).toBe(false)
  })

  it('says nothing about cause in any question or gate wording, and uses no technical terms', () => {
    // All four lists go through ONE predicate, because a negative assertion over wording that is already clean
    // cannot fail if it is deleted -- removing it and removing the rule it enforces look identical. So the predicate
    // is made to prove itself first, on a word that ONLY ONE of the four lists catches. Drop a list from `violates`
    // and its control fails; return a vacuous regex from the extraction and all four fail.
    const violates = (s: string) =>
      causalWords.test(s) || jargonWords.test(s) || noJargon.test(s) || BATTERY_JARGON.test(s)
    // Each shared list is probed against a word it forbids; bannedWords.ts does the same on import and throws.
    for (const list of BANNED_LISTS) {
      expect(list.forbids, list.name).toMatch(list.pattern)
      expect(list.allows, list.name).not.toMatch(list.pattern)
    }
    expect(violates('spending rose owing to the weather')).toBe(true) // causalWords alone: not in the jargon lists
    expect(violates('your 90th percentile')).toBe(true) // jargonWords alone
    expect(violates('a bayes estimate')).toBe(true) // noJargon alone
    expect(violates('a significant result')).toBe(true) // BATTERY_JARGON alone
    expect(violates('how much you spent on groceries last month')).toBe(false)

    const strings: string[] = []
    for (const r of BATTERY) {
      strings.push(r.question)
      for (const d of [ZERO, { ...ZERO, ...AT_MIN[r.id] }]) for (const g of r.gates(d)) strings.push(g.what)
    }
    expect(strings.length).toBeGreaterThanOrEqual(30)
    // One assertion carries three claims, so that no single edit can quietly drop one: that no declared wording
    // violates, that the scan really ran over THESE strings, and that it would have caught one that did.
    const sentinel = 'because your z-score sample is significant'
    expect([...strings, sentinel].filter(violates)).toEqual([sentinel])
    // The `test` field is deliberately NOT judged here: it is jargon by nature and never renders, which is exactly
    // why it needs the separate assertion below instead.
  })

  it('never writes a plural noun against the number one, in any gate of any relationship', () => {
    // Found by reading the deployed page, not by any test here: one gate read "The app needs 1 complete
    // months of spending", and its met wording read "1 are needed". `gate()` pluralises the trailing
    // unit from `missing`, but the SUBJECT is a written-out phrase the author supplies, so nothing made
    // it agree with the `need` beside it. Only a gate whose need is 1 can show the fault, and exactly one
    // gate has need 1 — which is why nine others reading correctly proved nothing about the tenth.
    const strings: string[] = []
    for (const r of BATTERY) {
      for (const d of [ZERO, { ...ZERO, ...AT_MIN[r.id] }]) for (const g of r.gates(d)) strings.push(g.what)
    }
    expect(strings.length).toBeGreaterThanOrEqual(20) // a scan of nothing proves nothing
    // Within one sentence of a bare "1", a plural noun or a plural verb. `[^.]*?` keeps the search inside
    // the sentence the "1" belongs to, so "needs 1 complete month… so 1 more month is needed" does not
    // match itself across the full stop. `\w[^aeiou]s` wants a consonant before the s, which is what lets
    // "is" through while catching "months". My first attempt checked only the word straight after the
    // number and missed the real fault, because the adjective sat between them.
    // Known limitation, stated rather than discovered later: a future gate with need 1 whose subject
    // legitimately contains a plural ("1 month with at least 5 purchases") would trip this. That is a
    // false positive worth having — it makes the author look at the agreement instead of guessing.
    const disagrees = (s: string): boolean => /\b1 [^.]*?\w[^aeiou]s\b/.test(s) || /\b1 (are|were)\b/.test(s)
    // The detector must see both faults it exists to forbid, and leave correct wording alone.
    expect(disagrees('The app needs 1 complete months of spending')).toBe(true)
    expect(disagrees('1 where 1 are needed')).toBe(true)
    expect(disagrees('The app needs 1 complete month of spending')).toBe(false)
    expect(disagrees('You have 0, so 1 more month is needed')).toBe(false)
    expect(disagrees('You have enough complete month of spending: 1 where 1 is needed.')).toBe(false)
    expect(disagrees('The app needs 2 moods that each have at least 10 purchases')).toBe(false)
    expect(strings.filter(disagrees)).toEqual([])
  })

  it('declares for each relationship the statistic that actually runs, and no test where there is none', () => {
    const statsSource = readFileSync(resolve(SRC, 'battery/stats.ts'), 'utf8')
    expect(statsSource).toMatch(/export function spearmanRhoBp/) // the read is not vacuous
    const mismatches: string[] = []
    const missingPrimitive: string[] = []
    for (const r of BATTERY) {
      const expected = STATISTIC[r.id]
      if (expected === null) {
        expect([r.id, r.test]).toEqual([r.id, null])
        continue
      }
      if (r.test === null || !r.test.includes(expected.names)) {
        mismatches.push(`${r.id}: declares ${String(r.test)}, but runs ${expected.names}`)
      }
      // And the statistic named is one this battery can actually compute. A declared test with no primitive behind
      // it is what 'Poisson rate comparison by mood day' was for as long as it stood: there is no Poisson anything
      // in stats.ts, and an exact Poisson test would have needed a fourth table of hand-entered criticals.
      if (!statsSource.includes(`export function ${expected.primitive}`)) {
        missingPrimitive.push(`${r.id}: no ${expected.primitive} in battery/stats.ts`)
      }
    }
    expect(mismatches).toEqual([])
    expect(missingPrimitive).toEqual([])
    expect(BATTERY.filter(r => r.test === null).map(r => r.id)).toEqual(['small-purchases'])
    // Nothing may claim a statistic the module has no primitive for, however plausible the words read.
    expect(BATTERY.map(r => r.test ?? '').join(' ')).not.toMatch(/poisson|paired|t-test|pearson\b/i)
  })
})
