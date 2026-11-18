import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../db/db'
import { seedDatabase } from '../db/seed'
import { saveAllocation } from '../budget/allocations'
import { attribute, goalContributions } from './contributions'

let uid = 0
const TODAY = '2026-11-18'

/** A round-up outflow: money moved into savings, which monthlyBudget counts in totals.savingsCents. */
const saved = async (id: string, valueDate: string, cents: number): Promise<void> => {
  await db.transactions.add({
    id, accountId: 'acc.1', valueDate, amountCents: -cents, balanceCents: 0, description: 'Movimiento inventado', comment: null,
    ingCategory: 'Ahorro', ingSubcategory: 'Redondeo', kind: 'roundup', dedupKey: `k.${++uid}`, importId: 'imp.1', fileSeq: uid,
    roundupParentId: null, createdAt: 1, deletedAt: null,
  })
}

const goal = (id: string) => db.savingsGoals.add({
  id, name: `Meta ${id}`, targetCents: 1000000, deadline: null, contributionPercentBp: 0, createdAt: 1, completedAt: null, archived: false,
})
const allocate = (goalId: string, fixedCents: number) =>
  saveAllocation({ categoryId: null, savingsGoalId: goalId, percentBp: null, fixedCents, effectiveFrom: '2026-01-01', note: null })

beforeEach(async () => {
  uid = 0
  await db.delete(); await db.open(); await seedDatabase()
})

const parts = (m: Map<string, number>) => Object.fromEntries([...m].sort())

describe('attribute', () => {
  it('shares a month of savings between goals in proportion to their allocations', () => {
    // allocations 30000 : 10000, saved 20000 -> 15000 and 5000
    expect(parts(attribute(20000, [{ goalId: 'a', allocatedCents: 30000 }, { goalId: 'b', allocatedCents: 10000 }])))
      .toEqual({ a: 15000, b: 5000 })
  })

  it('contributes nothing when nothing, or less than nothing, was saved', () => {
    const al = [{ goalId: 'a', allocatedCents: 30000 }, { goalId: 'b', allocatedCents: 10000 }]
    expect(parts(attribute(0, al))).toEqual({ a: 0, b: 0 })
    expect(parts(attribute(-5000, al))).toEqual({ a: 0, b: 0 })
  })

  it('never attributes more than was saved, to the cent, whatever the rounding', () => {
    // 3 goals, allocations 1 : 1 : 1, saved 100. Exact share 33.33.. each; floors are 33+33+33 = 99, one cent left.
    // Remainders are all equal (1/3), so the tie goes to the lowest goal id: a gets it. Independent rounding would give 99.
    const even = attribute(100, [{ goalId: 'c', allocatedCents: 500 }, { goalId: 'a', allocatedCents: 500 }, { goalId: 'b', allocatedCents: 500 }])
    expect(parts(even)).toEqual({ a: 34, b: 33, c: 33 })
    // allocations 1 : 1 : 1 again but saved 101: floors 33 each (99), two cents left, tie order a then b.
    expect(parts(attribute(101, [{ goalId: 'b', allocatedCents: 700 }, { goalId: 'c', allocatedCents: 700 }, { goalId: 'a', allocatedCents: 700 }])))
      .toEqual({ a: 34, b: 34, c: 33 })
    // allocations 5 : 3 : 3 (sum 11), saved 10. Exact 4.545.. / 2.727.. / 2.727..; floors 4, 2, 2 = 8, two cents left.
    // Remainders: 50 mod 11 = 6, 30 mod 11 = 8, 30 mod 11 = 8 -> the two 8s (b, c) get them. Independent rounding gives 5+3+3 = 11.
    const uneven = attribute(10, [{ goalId: 'a', allocatedCents: 5 }, { goalId: 'b', allocatedCents: 3 }, { goalId: 'c', allocatedCents: 3 }])
    expect(parts(uneven)).toEqual({ a: 4, b: 3, c: 3 })
    expect([...uneven.values()].reduce((x, y) => x + y, 0)).toBe(10)
  })

  it('is deterministic: the order the goals arrive in does not change who gets the spare cent', () => {
    const a = { goalId: 'a', allocatedCents: 1 }, b = { goalId: 'b', allocatedCents: 1 }
    expect(parts(attribute(1, [a, b]))).toEqual({ a: 1, b: 0 })
    expect(parts(attribute(1, [b, a]))).toEqual({ a: 1, b: 0 })
  })

  it('caps a goal at its own allocation and leaves the rest unattributed', () => {
    // allocations 3000 + 1000 = 4000, saved 9000: each gets exactly its allocation, 5000 belongs to no goal.
    const m = attribute(9000, [{ goalId: 'a', allocatedCents: 3000 }, { goalId: 'b', allocatedCents: 1000 }])
    expect(parts(m)).toEqual({ a: 3000, b: 1000 })
  })

  it('gives a goal with no allocation nothing', () => {
    expect(parts(attribute(500, [{ goalId: 'a', allocatedCents: 0 }, { goalId: 'b', allocatedCents: 1000 }]))).toEqual({ a: 0, b: 500 })
  })
})

describe('goalContributions', () => {
  it('shares a month of savings between goals in proportion to their allocations', async () => {
    await goal('g.a'); await goal('g.b')
    await allocate('g.a', 30000); await allocate('g.b', 10000)
    await saved('s1', '2026-09-10', 20000)
    expect(await goalContributions('2026-09', '2026-09', TODAY, 1)).toEqual([
      { month: '2026-09', goalId: 'g.a', contributedCents: 15000, allocatedCents: 30000 },
      { month: '2026-09', goalId: 'g.b', contributedCents: 5000, allocatedCents: 10000 },
    ])
  })

  it('contributes nothing in a month with an allocation but no savings', async () => {
    await goal('g.a'); await allocate('g.a', 30000)
    // The month has records (a spend), but nothing went to savings.
    await db.transactions.add({
      id: 'sp', accountId: 'acc.1', valueDate: '2026-09-10', amountCents: -1000, balanceCents: 0, description: 'Movimiento inventado', comment: null,
      ingCategory: null, ingSubcategory: null, kind: 'spend', dedupKey: 'k.sp', importId: 'imp.1', fileSeq: 99, roundupParentId: null, createdAt: 1, deletedAt: null,
    })
    expect(await goalContributions('2026-09', '2026-09', TODAY, 1)).toEqual([
      { month: '2026-09', goalId: 'g.a', contributedCents: 0, allocatedCents: 30000 },
    ])
  })

  it('leaves out the running month and any month with no records', async () => {
    await goal('g.a'); await allocate('g.a', 30000)
    await saved('s1', '2026-08-10', 1000)
    // 2026-09 has no records at all; 2026-11 is the running month and does.
    await saved('s3', '2026-10-10', 2000)
    await saved('s4', '2026-11-02', 4000)
    const out = await goalContributions('2026-08', '2026-11', TODAY, 1)
    expect(out.map((r) => [r.month, r.contributedCents])).toEqual([['2026-08', 1000], ['2026-10', 2000]])
  })

  it('returns oldest month first, goals by id within a month', async () => {
    await goal('g.b'); await goal('g.a')
    await allocate('g.b', 100); await allocate('g.a', 100)
    await saved('s1', '2026-10-10', 100); await saved('s2', '2026-09-10', 100)
    const out = await goalContributions('2026-09', '2026-10', TODAY, 1)
    expect(out.map((r) => `${r.month}/${r.goalId}`)).toEqual(['2026-09/g.a', '2026-09/g.b', '2026-10/g.a', '2026-10/g.b'])
  })
})
