import { describe, it, expect } from 'vitest'
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

// Reused from src/learning/categorise.test.ts and src/ui/screens/Reports.test.tsx, plus the words this task forbids.
const causalWords = /\b(because|cause[sd]?|causing|due to|owing to|leads? to|led to|results? in|resulted|as a result|therefore|thus|so that|drives?|driven|explains?|explained|why|makes you|made you|since you|which is why)\b/i
const jargonWords = /\b(cache|cached|basis|engine|z-score|median|deviation|outlier|percentile|standard|component|net)\b|tier|bayes|classif|posterior|probab|model|algorithm|sample|\bn\b|power|signific/i

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
    const strings: string[] = []
    for (const r of BATTERY) {
      strings.push(r.question)
      for (const d of [ZERO, { ...ZERO, ...AT_MIN[r.id] }]) for (const g of r.gates(d)) strings.push(g.what)
    }
    expect(strings.length).toBeGreaterThanOrEqual(30)
    for (const s of strings) {
      expect(s).not.toMatch(causalWords)
      expect(s).not.toMatch(jargonWords)
    }
  })

  it('needs no test for small-purchase accumulation, and says so', () => {
    expect(BATTERY.find(r => r.id === 'small-purchases')!.test).toBeNull()
    for (const r of BATTERY.filter(r => r.id !== 'small-purchases')) expect(r.test).toBeTruthy()
  })
})
