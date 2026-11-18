import { describe, expect, it } from 'vitest'
import type { BudgetLine, MonthlyBudget } from '../budget/month'
import type { MonthPoint } from '../analytics/series'
import { budgetAwareness, improvement, savingsConsistency } from './components'

function line(allocatedCents: number, spentCents: number): BudgetLine {
  return {
    targetKind: 'category', targetId: `c${allocatedCents}-${spentCents}`, label: 'x', allocatedCents, spentCents,
    remainingCents: allocatedCents - spentCents,
    varianceBp: allocatedCents === 0 ? null : 0, fixed: true, unbudgeted: allocatedCents === 0,
  }
}
function budget(month: string, lines: BudgetLine[]): MonthlyBudget {
  return {
    month, income: { cents: 0, provisional: false, basis: 'actual' }, partial: false, lines, unallocatedCents: 0,
    overcommittedBp: null,
    totals: { spentCents: 0, essentialCents: 0, discretionaryCents: 0, savingsCents: 0, savingsRateBp: null },
  }
}
function point(month: string, o: Partial<MonthPoint> = {}): MonthPoint {
  return {
    month, incomeCents: 0, spentCents: 0, savedCents: 0, essentialCents: 0, discretionaryCents: 0, uncategorisedCents: 0,
    netCents: 0, provisional: false, incomeBasis: 'actual', transactions: 1, hasData: true, ...o,
  }
}
const m = (n: number) => `2026-${String(n).padStart(2, '0')}`
/** A month with data whose discretionary share of spending is `bp`, on 10 000 cents of spending. */
const shareMonth = (n: number, bp: number) => point(m(n), { spentCents: 10000, discretionaryCents: bp })
const gap = (n: number) => point(m(n), { hasData: false, transactions: 0, provisional: true, incomeBasis: 'none' })

describe('budgetAwareness', () => {
  it('weights a respected allocation by its size, not by its count', () => {
    // Respected 2000 of (2000 + 200000) allocated: 2000 / 202000 = 0.99% -> 1. A count-based version says 1 of 2 = 50.
    const c = budgetAwareness([budget('2026-01', [line(2000, 1500), line(200000, 250000)])])
    expect(c).toMatchObject({ kind: 'measured', score: 1 })
  })

  it('ignores a line with no allocation rather than scoring it as overspent', () => {
    // The 5000 unbudgeted line is dropped: respected 10000 of 10000 = 100. A size-weighted score cannot tell the line
    // was admitted (it adds 0 to the total), so the line count in `inputs` is what pins the exclusion: 1 of 1, not 1 of 2.
    const c = budgetAwareness([budget('2026-01', [line(10000, 9000), line(0, 5000)])])
    expect(c).toMatchObject({ kind: 'measured', score: 100 })
    if (c.kind !== 'measured') throw new Error('expected measured')
    expect(c.inputs).toMatch(/1 of 1 allocation/)
  })

  it('is not measured when no line in any month has an allocation', () => {
    const c = budgetAwareness([budget('2026-01', [line(0, 500)]), budget('2026-02', [])])
    expect(c.kind).toBe('not-measured')
  })

  it('pools every month, and counts spending exactly at the allocation as respected', () => {
    // Jan: 3000 allocated, spent 3000 (respected). Feb: 2000 allocated, spent 2001 (over). Respected 3000 of 5000 = 60.
    const c = budgetAwareness([budget('2026-01', [line(3000, 3000)]), budget('2026-02', [line(2000, 2001)])])
    expect(c).toMatchObject({ kind: 'measured', score: 60 })
  })

  it('treats a net-refund (negative) spend as respected', () => {
    expect(budgetAwareness([budget('2026-01', [line(1000, -300)])])).toMatchObject({ score: 100 })
  })

  it('states its figures without judging', () => {
    const c = budgetAwareness([budget('2026-01', [line(2000, 1500), line(200000, 250000)])])
    if (c.kind !== 'measured') throw new Error('expected measured')
    expect(c.inputs).toMatch(/1 of 2/)
    expect(c.inputs).not.toMatch(/careless|failed|should|afford|overspent/i)
  })
})

describe('savingsConsistency', () => {
  it('counts a month as consistent when savings are positive, over months with data', () => {
    // Saved: +500, +1, 0, -200 -> 2 of 4 positive (zero is not positive) = 50.
    const c = savingsConsistency([
      point(m(1), { savedCents: 500 }), point(m(2), { savedCents: 1 }), point(m(3), { savedCents: 0 }),
      point(m(4), { savedCents: -200 }),
    ])
    expect(c).toMatchObject({ kind: 'measured', score: 50 })
  })

  it('rounds to whole points', () => {
    // 2 of 3 = 66.67 -> 67.
    const c = savingsConsistency([point(m(1), { savedCents: 5 }), point(m(2), { savedCents: 5 }), point(m(3))])
    expect(c).toMatchObject({ score: 67 })
  })

  it('withholds savings consistency below three months of data, naming what is short', () => {
    const c = savingsConsistency([point(m(1), { savedCents: 100 }), point(m(2), { savedCents: 100 })])
    expect(c.kind).toBe('not-measured')
    if (c.kind !== 'not-measured') return
    expect(c.why).toContain('3')
    expect(c.why).toContain('2')
    expect(c.why).not.toMatch(/insufficient|not tracking|fail/i)
  })

  it('does not let a gap month make up the three-month minimum', () => {
    const c = savingsConsistency([point(m(1), { savedCents: 100 }), point(m(2), { savedCents: 100 }), gap(3)])
    expect(c.kind).toBe('not-measured')
  })
})

describe('improvement', () => {
  it('withholds improvement below six months, because there is no baseline to compare against', () => {
    const c = improvement([1, 2, 3, 4, 5].map((n) => shareMonth(n, 4000)))
    expect(c.kind).toBe('not-measured')
    if (c.kind !== 'not-measured') return
    expect(c.why).toContain('6')
    expect(c.why).toContain('5')
  })

  it('scores a falling discretionary share above 50: 5 points per 100 bp', () => {
    // Prior three: 4000 each -> 4000. Recent three: 3500 each -> 3500. Improvement 500 bp -> 50 + 5*5 = 75.
    const pts = [4000, 4000, 4000, 3500, 3500, 3500].map((bp, i) => shareMonth(i + 1, bp))
    expect(improvement(pts)).toMatchObject({ kind: 'measured', score: 75 })
  })

  it('scores a rising share below 50 and clamps at the ends', () => {
    // Share rises 4000 -> 4200: improvement -200 bp -> 50 - 10 = 40.
    expect(improvement([4000, 4000, 4000, 4200, 4200, 4200].map((bp, i) => shareMonth(i + 1, bp))))
      .toMatchObject({ score: 40 })
    // Falls 6000 -> 1000: +5000 bp -> 50 + 250, clamped to 100. Rises by the same: 50 - 250, clamped to 0.
    expect(improvement([6000, 6000, 6000, 1000, 1000, 1000].map((bp, i) => shareMonth(i + 1, bp)))).toMatchObject({ score: 100 })
    expect(improvement([1000, 1000, 1000, 6000, 6000, 6000].map((bp, i) => shareMonth(i + 1, bp)))).toMatchObject({ score: 0 })
  })

  it('compares the most recent three against the three before them, ignoring older months and input order', () => {
    // The oldest month (share 9000) is outside the window. Prior 4000, recent 3800: +200 bp -> 50 + 10 = 60.
    const pts = [9000, 4000, 4000, 4000, 3800, 3800, 3800].map((bp, i) => shareMonth(i + 1, bp))
    expect(improvement([...pts].reverse())).toMatchObject({ score: 60 })
  })

  it('does not read income', () => {
    const a = [4000, 4000, 4000, 3500, 3500, 3500].map((bp, i) => shareMonth(i + 1, bp))
    const b = a.map((p) => ({ ...p, incomeCents: 999999, provisional: true, incomeBasis: 'trailing-average' as const }))
    expect(improvement(b)).toEqual(improvement(a))
  })
})

describe('a month with no records', () => {
  it('leaves a month with no records out of every component rather than counting it as zero', () => {
    // Savings: four months saved, two blank gaps. Right: 4 of 4 = 100. Gap counted as zero saving: 4 of 6 = 67.
    const saved = [point(m(1), { savedCents: 10 }), gap(2), point(m(3), { savedCents: 10 }), gap(4),
      point(m(5), { savedCents: 10 }), point(m(6), { savedCents: 10 })]
    expect(savingsConsistency(saved)).toMatchObject({ kind: 'measured', score: 100 })

    // Improvement: six data months, prior 4000 x3, recent 3500 x3 -> +500 bp -> 75. The gap sits last. Given spend but
    // no discretionary (share 0) it would, if admitted, make the recent window [3500, 3500, 0]: mean 2333, against a
    // prior window of [4000, 4000, 3500]: mean 3833. +1500 bp -> 50 + 75 = 125, clamped to 100. The right answer is 75.
    const series = [4000, 4000, 4000, 3500, 3500, 3500].map((bp, i) => shareMonth(i + 1, bp))
    const withGap = [...series, { ...gap(7), spentCents: 10000 }]
    expect(improvement(withGap)).toMatchObject({ kind: 'measured', score: 75 })

    // Budget awareness takes MonthlyBudget, which has no gap flag; a month with no lines simply adds nothing.
    expect(budgetAwareness([budget('2026-01', [line(1000, 500)]), budget('2026-02', [])])).toMatchObject({ score: 100 })
  })

  it('omits a month with data but no spending from the discretionary share, since it has no ratio', () => {
    // Five usable months plus one with data and spent 0: only five shares, so not measured (not a share of 0).
    const pts = [...[1, 2, 3, 4, 5].map((n) => shareMonth(n, 4000)), point(m(6))]
    expect(improvement(pts).kind).toBe('not-measured')
  })
})
