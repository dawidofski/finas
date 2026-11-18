import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../db/db'
import { seedDatabase } from '../db/seed'
import type { AnnotationRow, SavingsGoalRow, TransactionRow } from '../db/schema'
import type { RegretCluster } from '../learning/regret'
import type { BudgetLine, MonthlyBudget } from '../budget/month'
import type { MonthPoint } from '../analytics/series'
import { budgetAwareness, goalProgress, improvement, learning, savingsConsistency, spendingAwareness } from './components'

function line(allocatedCents: number, spentCents: number, targetKind: 'category' | 'goal' = 'category'): BudgetLine {
  return {
    targetKind, targetId: `c${allocatedCents}-${spentCents}`, label: 'x', allocatedCents, spentCents,
    remainingCents: allocatedCents - spentCents,
    varianceBp: allocatedCents === 0 ? null : 0, fixed: true, unbudgeted: allocatedCents === 0,
  }
}
function budget(month: string, lines: BudgetLine[], partial = false): MonthlyBudget {
  return {
    month, income: { cents: 0, provisional: false, basis: 'actual' }, partial, lines, unallocatedCents: 0,
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
/** A month the budget screen can score: has data and is complete, unless the caller says otherwise. */
const bm = (b: MonthlyBudget, hasData = true) => ({ budget: b, hasData })
const m = (n: number) => `2026-${String(n).padStart(2, '0')}`
/** A month with data whose discretionary share of spending is `bp`, on 10 000 cents of spending. */
const shareMonth = (n: number, bp: number) => point(m(n), { spentCents: 10000, discretionaryCents: bp })
const gap = (n: number) => point(m(n), { hasData: false, transactions: 0, provisional: true, incomeBasis: 'none' })

describe('budgetAwareness', () => {
  it('weights a respected allocation by its size, not by its count', () => {
    // Respected 2000 of (2000 + 200000) allocated: 2000 / 202000 = 0.99% -> 1. A count-based version says 1 of 2 = 50.
    const c = budgetAwareness([bm(budget('2026-01', [line(2000, 1500), line(200000, 250000)]))])
    expect(c).toMatchObject({ kind: 'measured', score: 1 })
  })

  it('ignores a line with no allocation rather than scoring it as overspent', () => {
    // The 5000 unbudgeted line is dropped: respected 10000 of 10000 = 100. A size-weighted score cannot tell the line
    // was admitted (it adds 0 to the total), so the line count in `inputs` is what pins the exclusion: 1 of 1, not 1 of 2.
    const c = budgetAwareness([bm(budget('2026-01', [line(10000, 9000), line(0, 5000)]))])
    expect(c).toMatchObject({ kind: 'measured', score: 100 })
    if (c.kind !== 'measured') throw new Error('expected measured')
    expect(c.inputs).toMatch(/1 of 1 allocation/)
  })

  it('is not measured when no line in any month has an allocation', () => {
    const c = budgetAwareness([bm(budget('2026-01', [line(0, 500)])), bm(budget('2026-02', []))])
    expect(c.kind).toBe('not-measured')
  })

  it('pools the completed months with data, and counts spending exactly at the allocation as respected', () => {
    // Jan: 3000 allocated, spent 3000 (respected). Feb: 2000 allocated, spent 2001 (over). Respected 3000 of 5000 = 60.
    const c = budgetAwareness([bm(budget('2026-01', [line(3000, 3000)])), bm(budget('2026-02', [line(2000, 2001)]))])
    expect(c).toMatchObject({ kind: 'measured', score: 60 })
  })

  it('treats a net-refund (negative) spend as respected', () => {
    expect(budgetAwareness([bm(budget('2026-01', [line(1000, -300)]))])).toMatchObject({ score: 100 })
  })

  it('leaves out the month still in progress, since a part-month always looks under budget', () => {
    // January overspent (0 of 1000). February is partial, 200 spent so far of 1000: admitted it reads 1000 of 2000 = 50.
    const c = budgetAwareness([bm(budget('2026-01', [line(1000, 1500)])), bm(budget('2026-02', [line(1000, 200)], true))])
    expect(c).toMatchObject({ kind: 'measured', score: 0 })
  })

  it('is not measured when the only months are gaps or still in progress', () => {
    const c = budgetAwareness([bm(budget('2026-01', [line(1000, 0)]), false), bm(budget('2026-02', [line(1000, 0)], true))])
    expect(c.kind).toBe('not-measured')
  })

  it('respects a category by staying at or under it', () => {
    // 400 spent of 1000: respected, 100. 1500 of 1000: not, 0.
    expect(budgetAwareness([bm(budget('2026-01', [line(1000, 400, 'category')]))])).toMatchObject({ score: 100 })
    expect(budgetAwareness([bm(budget('2026-01', [line(1000, 1500, 'category')]))])).toMatchObject({ score: 0 })
  })

  it('leaves a savings-goal line out entirely, since no transaction is tied to a goal yet', () => {
    // The goal line (1000 allocated, 0 spent, as the app always produces) is dropped: only the category counts, 500 of 500 = 100.
    // Admitted as unrespected it would read 500 of 1500 = 33.
    const c = budgetAwareness([bm(budget('2026-01', [line(500, 400, 'category'), line(1000, 0, 'goal')]))])
    expect(c).toMatchObject({ kind: 'measured', score: 100 })
    if (c.kind !== 'measured') throw new Error('expected measured')
    expect(c.inputs).toMatch(/1 of 1 allocation/)
    // A month with only a goal line has nothing to measure.
    expect(budgetAwareness([bm(budget('2026-01', [line(1000, 0, 'goal')]))]).kind).toBe('not-measured')
  })

  it('never reports 100 while an allocation was not respected', () => {
    // 199 of 200 respected = 99.5, which rounds to 100; capped at 99 because one line was overspent.
    const c = budgetAwareness([bm(budget('2026-01', [line(199, 199), line(1, 2)]))])
    expect(c).toMatchObject({ score: 99 })
  })

  it('states its figures without judging', () => {
    const c = budgetAwareness([bm(budget('2026-01', [line(2000, 1500), line(200000, 250000)]))])
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

describe('savingsConsistency cap', () => {
  it('does not report 100 while a month had no saving, however many months there are', () => {
    // 199 of 200 months positive = 99.5 -> 100 by rounding; one month did not save, so it stays 99.
    const pts = Array.from({ length: 200 }, (_, i) => point(`m${String(i).padStart(3, '0')}`, { savedCents: i === 0 ? 0 : 100 }))
    expect(savingsConsistency(pts)).toMatchObject({ kind: 'measured', score: 99 })
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

  it('says its months are the ones with spending recorded, since gaps and zero-spend months are skipped', () => {
    const c = improvement([4000, 4000, 4000, 3500, 3500, 3500].map((bp, i) => shareMonth(i + 1, bp)))
    if (c.kind !== 'measured') throw new Error('expected measured')
    expect(c.inputs).toMatch(/months with spending recorded/)
    expect(c.inputs).toMatch(/not counted/)
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

    // Budget awareness: a real gap month still HAS lines (they come from the allocations), each with spent 0. January
    // is overspent: 0 of 1000 respected = 0. With the gap admitted, its untouched 1000 allocation counts as respected:
    // 1000 of 2000 = 50.
    const jan = bm(budget('2026-01', [line(1000, 1500)]))
    const feb = bm(budget('2026-02', [line(1000, 0)]), false)
    expect(budgetAwareness([jan, feb])).toMatchObject({ kind: 'measured', score: 0 })
  })

  it('omits a month with data but no spending from the discretionary share, since it has no ratio', () => {
    // Five usable months plus one with data and spent 0: only five shares, so not measured (not a share of 0).
    const pts = [...[1, 2, 3, 4, 5].map((n) => shareMonth(n, 4000)), point(m(6))]
    expect(improvement(pts).kind).toBe('not-measured')
  })
})

const tx = (id: string, valueDate: string, over: Partial<TransactionRow> = {}): TransactionRow => ({
  id, accountId: 'acc', valueDate, amountCents: -1000, balanceCents: 50000, description: 'SHOP', comment: null,
  ingCategory: null, ingSubcategory: null, kind: 'spend', dedupKey: `K${id}`, importId: 'imp', fileSeq: 1,
  roundupParentId: null, createdAt: 1, deletedAt: null, ...over,
})
const ann = (transactionId: string, over: Partial<AnnotationRow> = {}): AnnotationRow => ({
  transactionId, categoryId: null, subcategoryId: null, merchantId: null, typeOverride: null, paymentMethod: null,
  note: null, moodId: null, purchaseReasonId: null, worthwhile: null, reviewed: false, dateOverride: null,
  amountCentsOverride: null, descriptionOverride: null, updatedAt: 1, ...over,
})

describe('spendingAwareness', () => {
  beforeEach(async () => { await db.delete(); await db.open(); await seedDatabase() })
  const NOV = ['2026-11-01', '2026-11-30'] as const

  it('counts a transaction as reviewed only when the owner actually reviewed it', async () => {
    // Four live transactions in the window. a is reviewed; b has a note but is not reviewed; c and d are untouched.
    // Reviewed 1 of 4 = 25. Counting annotation rows (2 of 4 = 50) would say 50.
    await db.transactions.bulkAdd([tx('a', '2026-11-03'), tx('b', '2026-11-04'), tx('c', '2026-11-05'), tx('d', '2026-11-06')])
    await db.annotations.bulkAdd([ann('a', { reviewed: true }), ann('b', { note: 'lunch' })])
    const c = await spendingAwareness(...NOV)
    expect(c).toMatchObject({ kind: 'measured', score: 25 })
    if (c.kind !== 'measured') throw new Error('expected measured')
    expect(c.inputs).toMatch(/1 of 4 transactions/)
  })

  it('leaves out what the review queue never offers: income, internal movements, round-ups and essentials', async () => {
    // a (spend, reviewed) and b (spend, a note only) are asked about. inc, int, rup and gro are reviewed but never offered
    // (income / internal / roundup kind; ING pair Alimentacion -> cat.groceries, essential). Reviewed 1 of 2 = 50.
    // Counting every live row would read 5 of 6 = 83; leaving them out of the denominator only would give 1 of 6 = 17.
    await db.transactions.bulkAdd([
      tx('a', '2026-11-03'), tx('b', '2026-11-04'),
      tx('inc', '2026-11-05', { kind: 'income', amountCents: 200000 }),
      tx('int', '2026-11-06', { kind: 'internal' }),
      tx('rup', '2026-11-07', { kind: 'roundup' }),
      tx('gro', '2026-11-08', { ingCategory: 'Alimentación', ingSubcategory: 'Supermercados y alimentación' }),
    ])
    await db.annotations.bulkAdd(['a', 'inc', 'int', 'rup', 'gro'].map((id) => ann(id, { reviewed: true })).concat(ann('b', { note: 'n' })))
    const c = await spendingAwareness(...NOV)
    expect(c).toMatchObject({ kind: 'measured', score: 50 })
    if (c.kind !== 'measured') throw new Error('expected measured')
    expect(c.inputs).toMatch(/1 of 2 transactions/)
  })

  it('can reach 100 for an owner whose window also holds a salary and a transfer', async () => {
    await db.transactions.bulkAdd([tx('a', '2026-11-03'), tx('inc', '2026-11-05', { kind: 'income', amountCents: 200000 }), tx('int', '2026-11-06', { kind: 'internal' })])
    await db.annotations.bulkAdd([ann('a', { reviewed: true })])
    expect(await spendingAwareness(...NOV)).toMatchObject({ kind: 'measured', score: 100 })
  })

  it('is not measured when the window holds only rows the app never asks about', async () => {
    await db.transactions.bulkAdd([tx('inc', '2026-11-05', { kind: 'income', amountCents: 200000 })])
    await db.annotations.bulkAdd([ann('inc', { reviewed: true })])
    const c = await spendingAwareness(...NOV)
    expect(c.kind).toBe('not-measured')
    if (c.kind !== 'not-measured') throw new Error('expected not-measured')
    expect(c.why).toMatch(/No transactions in this period are ones the app asks you to review/)
  })

  it('does not score a window whose transactions are all unannotated', async () => {
    await db.transactions.bulkAdd([tx('a', '2026-11-03'), tx('b', '2026-11-04')])
    const c = await spendingAwareness(...NOV)
    expect(c.kind).toBe('not-measured')
    if (c.kind !== 'not-measured') throw new Error('expected not-measured')
    expect(c.why).toMatch(/None of the transactions in this period has been reviewed or annotated/)
  })

  it('does not take a review made outside the window, or on a deleted row, for work done inside it', async () => {
    // Live untouched rows u1, u2 in November; the only annotations are on a reviewed October row and a soft-deleted
    // November row. Nothing in the window is touched: not-measured. Counting those would read a measured 0.
    await db.transactions.bulkAdd([tx('u1', '2026-11-03'), tx('u2', '2026-11-04'), tx('o', '2026-10-30'), tx('x', '2026-11-05', { deletedAt: 5 })])
    await db.annotations.bulkAdd([ann('o', { reviewed: true }), ann('x', { reviewed: true })])
    const c = await spendingAwareness(...NOV)
    expect(c.kind).toBe('not-measured')
    if (c.kind !== 'not-measured') throw new Error('expected not-measured')
    expect(c.why).toMatch(/None of the transactions in this period has been reviewed or annotated/)
  })

  it('does not score a window with nothing live in it', async () => {
    await db.transactions.bulkAdd([tx('o', '2026-10-30'), tx('x', '2026-11-03', { deletedAt: 5 })])
    await db.annotations.bulkAdd([ann('o', { reviewed: true }), ann('x', { reviewed: true })])
    const c = await spendingAwareness(...NOV)
    expect(c.kind).toBe('not-measured')
    if (c.kind !== 'not-measured') throw new Error('expected not-measured')
    expect(c.why).toMatch(/No transactions in this period are ones the app asks you to review/)
  })

  it('uses the window to the day at both ends, not the whole month', async () => {
    // Window Nov 10-20. e (Nov 5, reviewed) and l (Nov 25, reviewed) are outside; a (Nov 10, reviewed), b (Nov 20, note only)
    // and c (Nov 15, untouched) are inside. Reviewed 1 of 3 = 33. Dropping the lower bound reads 2 of 4 = 50, the upper 2 of 4.
    await db.transactions.bulkAdd([tx('e', '2026-11-05'), tx('a', '2026-11-10'), tx('c', '2026-11-15'), tx('b', '2026-11-20'), tx('l', '2026-11-25')])
    await db.annotations.bulkAdd([ann('e', { reviewed: true }), ann('a', { reviewed: true }), ann('b', { note: 'n' }), ann('l', { reviewed: true })])
    expect(await spendingAwareness('2026-11-10', '2026-11-20')).toMatchObject({ kind: 'measured', score: 33 })
  })

  it('scores 0 when the owner has touched transactions but reviewed none', async () => {
    await db.transactions.bulkAdd([tx('a', '2026-11-03'), tx('b', '2026-11-04')])
    await db.annotations.bulkAdd([ann('a', { note: 'n' })])
    expect(await spendingAwareness(...NOV)).toMatchObject({ kind: 'measured', score: 0 })
  })

  it('does not award 100 while a transaction is unreviewed', async () => {
    // 399 of 400 reviewed = 99.75 -> 100 by rounding; it must stay 99.
    const rows = Array.from({ length: 400 }, (_, i) => tx(`t${i}`, '2026-11-03'))
    await db.transactions.bulkAdd(rows)
    await db.annotations.bulkAdd(rows.slice(0, 399).map((r) => ann(r.id, { reviewed: true })))
    expect(await spendingAwareness(...NOV)).toMatchObject({ score: 99 })
  })
})

const goal = (id: string, targetCents: number, over: Partial<SavingsGoalRow> = {}): SavingsGoalRow => ({
  id, name: id, targetCents, deadline: null, contributionPercentBp: 1000, createdAt: 1, completedAt: null, archived: false, ...over,
})

describe('goalProgress', () => {
  it('says the owner has set no goal yet, rather than scoring no progress', () => {
    const c = goalProgress([])
    expect(c.kind).toBe('not-measured')
    if (c.kind !== 'not-measured') throw new Error('expected not-measured')
    expect(c.why).toMatch(/have not set a savings goal yet/)
    expect(c.why).not.toMatch(/no progress|not made/i)
  })

  it('scores progress against each goal target, weighted by the size of the target', () => {
    // Reached 10000 of 10000 + 90000 = 10%. A count-based version says 1 of 2 = 50.
    const c = goalProgress([goal('a', 10000, { completedAt: 5 }), goal('b', 90000)])
    expect(c).toMatchObject({ kind: 'measured', score: 10 })
    if (c.kind !== 'measured') throw new Error('expected measured')
    expect(c.inputs).toMatch(/completed 1 of 2 savings goals/)
    expect(c.inputs).toMatch(/partway toward a goal is not measured/) // completion only: it must not imply partial progress
    // The big goal reached instead: 90000 of 100000 = 90.
    expect(goalProgress([goal('a', 10000), goal('b', 90000, { completedAt: 5 })])).toMatchObject({ score: 90 })
  })

  it('leaves out a goal the owner archived unfinished, but keeps a completed one', () => {
    // Archived unfinished 50000 is dropped: 20000 of 40000 = 50 (admitted it would be 20000 of 90000 = 22).
    expect(goalProgress([goal('a', 20000, { completedAt: 5 }), goal('b', 20000), goal('c', 50000, { archived: true })])).toMatchObject({ score: 50 })
    // Completed then archived still counts: 20000 of 40000 = 50. (Dropped it would be 0 of 20000 = 0.)
    expect(goalProgress([goal('a', 20000, { completedAt: 5, archived: true }), goal('b', 20000)])).toMatchObject({ score: 50 })
  })

  it('is not measured until a goal has been completed, rather than scoring 0 beside a goal that may be mostly funded', () => {
    const c = goalProgress([goal('a', 10000), goal('b', 90000)])
    expect(c.kind).toBe('not-measured')
    if (c.kind !== 'not-measured') throw new Error('expected not-measured')
    expect(c.why).toMatch(/None of your savings goals is marked completed yet/)
  })

  it('ignores a goal with no target rather than dividing by it', () => {
    // Only a zero-target goal: nothing counted, so not-measured (a 0 of 0 must not read as a full score).
    expect(goalProgress([goal('z', 0, { completedAt: 5 })]).kind).toBe('not-measured')
    // Beside a real completed goal the zero-target one adds nothing: 5000 of 5000 = 100.
    expect(goalProgress([goal('z', 0, { completedAt: 5 }), goal('a', 5000, { completedAt: 5 })])).toMatchObject({ score: 100 })
  })

  it('is not measured, and says so differently, when every goal is archived unfinished', () => {
    const c = goalProgress([goal('a', 1000, { archived: true })])
    expect(c.kind).toBe('not-measured')
    if (c.kind !== 'not-measured') throw new Error('expected not-measured')
    expect(c.why).toMatch(/None of your savings goals is active/)
  })

  it('does not award 100 while a goal is unfinished', () => {
    // 199999 of 200000 = 99.9995 -> 100 by rounding; must stay 99.
    expect(goalProgress([goal('a', 199999, { completedAt: 5 }), goal('b', 1)])).toMatchObject({ score: 99 })
  })
})

const cluster = (by: RegretCluster['by'], key: string, regretted: number, total: number): RegretCluster =>
  ({ by, key, label: key, regretted, total, cents: 0 })

describe('learning', () => {
  it('compares a cluster regret rate late against early, and ignores a cluster seen once', () => {
    // Shared: mood m (3/6 = 5000 bp -> 1/6 = 1667 bp: fell), merchant s (1/4 = 2500 -> 2/4 = 5000: rose),
    // category c (2/4 -> 2/4: equal, not fell). 1 fell of 3 = 33. weekday 1 (early only) and reason r (late only) are ignored.
    const early = [cluster('mood', 'm', 3, 6), cluster('merchant', 's', 1, 4), cluster('category', 'c', 2, 4), cluster('weekday', '1', 1, 3)]
    const late = [cluster('mood', 'm', 1, 6), cluster('merchant', 's', 2, 4), cluster('category', 'c', 2, 4), cluster('reason', 'r', 1, 3)]
    const c = learning(early, late)
    expect(c).toMatchObject({ kind: 'measured', score: 33 })
    if (c.kind !== 'measured') throw new Error('expected measured')
    expect(c.inputs).toMatch(/In 1 of 3 patterns/)
  })

  it('says what it cannot see: independence, and that the best outcomes are left out', () => {
    const c = learning([cluster('mood', 'a', 2, 3), cluster('mood', 'b', 2, 3)], [cluster('mood', 'a', 1, 3), cluster('mood', 'b', 1, 3)])
    if (c.kind !== 'measured') throw new Error('expected measured')
    expect(c.inputs).toMatch(/not independent/)
    expect(c.inputs).toMatch(/regret fell to none no longer appears/)
    expect(c.inputs).toMatch(/leaves out your best results/)
    expect(c.inputs).toMatch(/at least 3 answered spends/)
  })

  it('compares rates, not counts', () => {
    // Regretted count rose 2 -> 3 but the rate fell (2/3 = 6667 -> 3/10 = 3000). Both clusters fell: 2 of 2 = 100.
    const early = [cluster('mood', 'a', 2, 3), cluster('mood', 'b', 2, 3)]
    const late = [cluster('mood', 'a', 3, 10), cluster('mood', 'b', 3, 10)]
    expect(learning(early, late)).toMatchObject({ kind: 'measured', score: 100 })
  })

  it('does not compare a cluster with fewer than 3 answered spends in either window', () => {
    // a and b have 3 answered each side and both fell. s (1/2 -> 3/3: early window of 2) and t (1/3 -> 2/2: late window of 2) rose but each has a window under 3.
    // With the floor: 2 of 2 = 100. Without it: a, b fell, s, t rose: 2 of 4 = 50.
    const early = [cluster('mood', 'a', 2, 3), cluster('mood', 'b', 2, 3), cluster('mood', 's', 1, 2), cluster('mood', 't', 1, 3)]
    const late = [cluster('mood', 'a', 1, 3), cluster('mood', 'b', 1, 3), cluster('mood', 's', 3, 3), cluster('mood', 't', 2, 2)]
    expect(learning(early, late)).toMatchObject({ kind: 'measured', score: 100 })
  })

  it('does not score two single-spend clusters as a pattern', () => {
    expect(learning([cluster('mood', 'a', 1, 1), cluster('mood', 'b', 1, 1)], [cluster('mood', 'a', 1, 2), cluster('mood', 'b', 1, 2)]).kind).toBe('not-measured')
  })

  it('does not match the same key across different dimensions', () => {
    // weekday "1" early and mood "1" late are different clusters: only mood x is shared, and 1 shared is too few.
    const early = [cluster('mood', 'x', 2, 4), cluster('weekday', '1', 2, 4)]
    const late = [cluster('mood', 'x', 1, 4), cluster('mood', '1', 1, 4)]
    expect(learning(early, late).kind).toBe('not-measured')
  })

  it('is not measured with fewer than 2 clusters in both windows', () => {
    expect(learning([], []).kind).toBe('not-measured')
    expect(learning([cluster('mood', 'a', 1, 3)], [cluster('mood', 'a', 1, 4)]).kind).toBe('not-measured')
    expect(learning([cluster('mood', 'a', 1, 3), cluster('mood', 'b', 1, 3)], [cluster('mood', 'a', 1, 4), cluster('mood', 'z', 1, 4)]).kind).toBe('not-measured')
  })

  it('does not award 100 while a cluster did not improve, and gives 0 when none did', () => {
    // 99 of 100 shared clusters fell (1/3 -> 1/6) -> 99 (not 100); none fell (equal rates) -> 0.
    const early = Array.from({ length: 100 }, (_, i) => cluster('merchant', `k${i}`, 1, 3))
    const late = early.map((c, i) => (i === 0 ? cluster('merchant', c.key, 1, 3) : cluster('merchant', c.key, 1, 6)))
    expect(learning(early, late)).toMatchObject({ score: 99 })
    expect(learning(early, early)).toMatchObject({ kind: 'measured', score: 0 })
  })
})
