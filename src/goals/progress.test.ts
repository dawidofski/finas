import { describe, expect, it } from 'vitest'
import type { SavingsGoalRow } from '../db/schema'
import type { GoalMonth } from './contributions'
import { MIN_ESTIMATE_MONTHS, progressOf } from './progress'

const LAST = '2026-10' // the last completed month in every case below
const CREATED = Date.UTC(2026, 0, 15) // 2026-01-15 UTC, before every month used unless a test says otherwise

const goal = (over: Partial<SavingsGoalRow> = {}): SavingsGoalRow => ({
  id: 'g1', name: 'Meta', targetCents: 1000000, deadline: null, contributionPercentBp: 0, createdAt: CREATED,
  completedAt: null, archived: false, ...over,
})

/** Consecutive months ending at LAST, oldest first, one per contribution. */
const seq = (contribs: number[], goalId = 'g1'): GoalMonth[] => {
  const out: GoalMonth[] = []
  contribs.forEach((c, i) => {
    const idx = 2026 * 12 + 9 - (contribs.length - 1 - i) // months since year 0, 0-based
    const month = `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`
    out.push({ month, goalId, contributedCents: c, allocatedCents: 0 })
  })
  return out
}

describe('progressOf', () => {
  it('reports contributed and remaining, and never a negative remaining', () => {
    const p = progressOf(goal(), seq([10000, 20000, 30000]), LAST)
    expect(p.contributedCents).toBe(60000)
    expect(p.remainingCents).toBe(940000)
    expect(p.targetCents).toBe(1000000)
    expect(p.goalId).toBe('g1')
    expect(p.reached).toBe(false)

    const over = progressOf(goal({ targetCents: 50000 }), seq([10000, 20000, 30000]), LAST)
    expect(over.contributedCents).toBe(60000)
    expect(over.remainingCents).toBe(0)
  })

  it('withholds the estimate below three months with a contribution, saying what is short', () => {
    expect(MIN_ESTIMATE_MONTHS).toBe(3)
    // 4 months but only 2 with something put aside: still short.
    const p = progressOf(goal(), seq([0, 0, 5000, 5000]), LAST)
    expect(p.estimate).toBeNull()
    expect(p.estimateWhy).toContain('3')
    expect(p.estimateWhy).toContain('2')

    const none = progressOf(goal(), [], LAST)
    expect(none.estimate).toBeNull()
    expect(none.estimateWhy).toContain('3')

    // exactly three months with a contribution is enough.
    expect(progressOf(goal(), seq([10000, 20000, 30000]), LAST).estimate).not.toBeNull()
  })

  it('gives a range from the owner own faster and slower months, never one date', () => {
    // Six months: 100..600 EUR. Lower half 100/200/300 -> slower rate 200 EUR (20000c);
    // upper half 400/500/600 -> faster rate 500 EUR (50000c). Contributed 2100 EUR, remaining 7900 EUR (790000c).
    // Earliest: 790000 / 50000 = 15.8 -> 16 months after 2026-10: 2026-10 + 16 = 2028-02.
    // Latest:   790000 / 20000 = 39.5 -> 40 months after 2026-10: 2026-10 + 40 = 2030-02.
    const a = progressOf(goal(), seq([10000, 20000, 30000, 40000, 50000, 60000]), LAST)
    expect(a.contributedCents).toBe(210000)
    expect(a.remainingCents).toBe(790000)
    expect(a.estimate).toEqual({ earliestMonth: '2028-02', latestMonth: '2030-02' })
    expect(a.estimateWhy).toBeNull()

    // Seven months 100..700 EUR, target 10000.01 EUR. Odd count: the middle month (400) belongs to neither half.
    // Lower 100/200/300 -> 20000c; upper 500/600/700 -> 60000c. Contributed 280000, remaining 720001.
    // Earliest: 720001 / 60000 = 12.0 + a cent -> 13 months: 2026-10 + 13 = 2027-11.
    // Latest:   720001 / 20000 = 36.0 + a cent -> 37 months: 2026-10 + 37 = 2029-11.
    const b = progressOf(goal({ targetCents: 1000001 }), seq([10000, 20000, 30000, 40000, 50000, 60000, 70000]), LAST)
    expect(b.estimate).toEqual({ earliestMonth: '2027-11', latestMonth: '2029-11' })

    // Exactly three months: halves are one month each, the middle one is dropped. Slower 10000c, faster 30000c.
    // Remaining 940001: 940001/30000 = 31.33 -> 32 -> 2026-10 + 32 = 2029-06; 940001/10000 = 94.0001 -> 95 -> 2034-09.
    const c = progressOf(goal({ targetCents: 1000001 }), seq([10000, 20000, 30000]), LAST)
    expect(c.estimate).toEqual({ earliestMonth: '2029-06', latestMonth: '2034-09' })
  })

  it('says only "no sooner than" when some months had no contribution', () => {
    // 0, 0, 100, 200, 300, 400 EUR. Lower half 0/0/100 -> 0: the slower bound is unbounded. Upper half 200/300/400 -> 300 EUR.
    // Contributed 1000 EUR, target 5000 EUR, remaining 4000 EUR (400000c). 400000/30000 = 13.3 -> 14: 2026-10 + 14 = 2027-12.
    const p = progressOf(goal({ targetCents: 500000 }), seq([0, 0, 10000, 20000, 30000, 40000]), LAST)
    expect(p.estimate).toEqual({ earliestMonth: '2027-12', latestMonth: null })
    expect(p.estimateWhy).toContain('no sooner than')
  })

  it('marks a goal reached once contributions meet the target', () => {
    const exact = progressOf(goal({ targetCents: 60000 }), seq([10000, 20000, 30000]), LAST)
    expect(exact.reached).toBe(true)
    expect(exact.remainingCents).toBe(0)
    expect(exact.estimate).toBeNull()
    const over = progressOf(goal({ targetCents: 50000 }), seq([10000, 20000, 30000]), LAST)
    expect(over.reached).toBe(true)
    expect(over.estimate).toBeNull()
    expect(progressOf(goal({ targetCents: 60001 }), seq([10000, 20000, 30000]), LAST).reached).toBe(false)
  })

  it('counts only months on or after the goal was created, by the UTC calendar', () => {
    // Created 2026-04-30 23:30 UTC: April counts (a local-time conversion east of UTC would call it May).
    // Months 2026-04..2026-10 are 100..700 EUR as in the odd-count case above; two earlier huge months must not count.
    const early: GoalMonth[] = [
      { month: '2025-12', goalId: 'g1', contributedCents: 999999, allocatedCents: 0 },
      { month: '2026-03', goalId: 'g1', contributedCents: 999999, allocatedCents: 0 },
    ]
    const p = progressOf(
      goal({ targetCents: 1000001, createdAt: Date.UTC(2026, 3, 30, 23, 30) }),
      [...early, ...seq([10000, 20000, 30000, 40000, 50000, 60000, 70000])], LAST,
    )
    expect(p.contributedCents).toBe(280000)
    expect(p.estimate).toEqual({ earliestMonth: '2027-11', latestMonth: '2029-11' })
  })

  it('ignores months that belong to another goal', () => {
    const p = progressOf(goal(), [...seq([10000, 20000, 30000]), ...seq([99999], 'g2')], LAST)
    expect(p.contributedCents).toBe(60000)
  })

  it('uses plain words, with no jargon', () => {
    const texts = [
      progressOf(goal(), [], LAST).estimateWhy,
      progressOf(goal({ targetCents: 500000 }), seq([0, 0, 10000, 20000, 30000, 40000]), LAST).estimateWhy,
    ]
    for (const t of texts) {
      expect(t).not.toBeNull()
      expect(t).not.toMatch(/quartile|median/i)
    }
  })
})
