import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../db/db'
import { seedDatabase } from '../db/seed'
import { allocationsFor, deleteAllocation, saveAllocation } from './allocations'

type Input = Parameters<typeof saveAllocation>[0]
const base: Input = {
  categoryId: 'cat.groceries', savingsGoalId: null, percentBp: 1500, fixedCents: null, effectiveFrom: '2026-01-01', note: null,
}
const make = (over: Partial<Input> = {}): Input => ({ ...base, ...over })

const goal = (id: string) => ({
  id, name: 'Viaje inventado', targetCents: 100000, deadline: null, contributionPercentBp: 0, createdAt: 1, completedAt: null, archived: false,
})

beforeEach(async () => {
  await db.delete(); await db.open(); await seedDatabase()
  await db.savingsGoals.add(goal('goal.1'))
})

describe('saveAllocation validation', () => {
  it('refuses an allocation targeting both a category and a goal', async () => {
    await expect(saveAllocation(make({ savingsGoalId: 'goal.1' }))).rejects.toThrow(/either a spending category or a savings goal/)
    expect(await db.budgetAllocations.count()).toBe(0)
  })

  it('refuses an allocation targeting neither', async () => {
    await expect(saveAllocation(make({ categoryId: null }))).rejects.toThrow(/Choose a spending category or a savings goal/)
  })

  it('refuses an allocation that is both a percentage and a fixed amount', async () => {
    await expect(saveAllocation(make({ fixedCents: 5000 }))).rejects.toThrow(/not both/)
  })

  it('refuses an allocation that is neither a percentage nor a fixed amount', async () => {
    await expect(saveAllocation(make({ percentBp: null }))).rejects.toThrow(/share of income or as a fixed amount/)
  })

  it('accepts a fixed-EUR allocation for an annual bill', async () => {
    const row = await saveAllocation(make({ percentBp: null, fixedCents: 36000, note: 'Seguro anual' }))
    expect(row).toMatchObject({ percentBp: null, fixedCents: 36000, note: 'Seguro anual' })
    expect(await db.budgetAllocations.get(row.id)).toEqual(row)
  })

  it('accepts a goal-targeted allocation', async () => {
    const row = await saveAllocation(make({ categoryId: null, savingsGoalId: 'goal.1' }))
    expect(row.savingsGoalId).toBe('goal.1')
    expect(row.categoryId).toBeNull()
  })

  it('refuses a target that does not exist, after the exclusivity rules', async () => {
    await expect(saveAllocation(make({ categoryId: 'cat.nope' }))).rejects.toThrow(/category no longer exists/)
    await expect(saveAllocation(make({ categoryId: null, savingsGoalId: 'goal.nope' }))).rejects.toThrow(/goal no longer exists/)
    // Both named, one missing: the useful message is that it names both.
    await expect(saveAllocation(make({ categoryId: 'cat.nope', savingsGoalId: 'goal.1' }))).rejects.toThrow(/not both/)
    expect(await db.budgetAllocations.count()).toBe(0)
  })

  it('rejects a negative or non-integer percentBp', async () => {
    for (const bad of [-1, 12.5, Number.NaN]) {
      await expect(saveAllocation(make({ percentBp: bad }))).rejects.toThrow(/share of income must be zero or more, with at most two decimals/)
    }
    expect(await db.budgetAllocations.count()).toBe(0)
  })

  it('rejects a negative or non-integer fixedCents and a bad date', async () => {
    await expect(saveAllocation(make({ percentBp: null, fixedCents: -1 }))).rejects.toThrow(/fixed amount/)
    await expect(saveAllocation(make({ percentBp: null, fixedCents: 1.5 }))).rejects.toThrow(/fixed amount/)
    await expect(saveAllocation(make({ effectiveFrom: '2026-02-30' }))).rejects.toThrow(/valid date/)
  })

  it('does not block allocations beyond 100 % of income', async () => {
    await saveAllocation(make({ percentBp: 8000 }))
    await saveAllocation(make({ categoryId: 'cat.shopping', percentBp: 7000 }))
    expect(await allocationsFor('2026-01')).toHaveLength(2)
  })

  it('replaces an allocation saved again for the same target and date', async () => {
    const first = await saveAllocation(make())
    const second = await saveAllocation(make({ percentBp: 2000 }))
    expect(await db.budgetAllocations.count()).toBe(1)
    expect(second.id).toBe(first.id)
    expect((await allocationsFor('2026-01'))[0]?.percentBp).toBe(2000)
  })
})

describe('allocationsFor', () => {
  it('returns the latest allocation whose effectiveFrom is on or before the month', async () => {
    await saveAllocation(make({ effectiveFrom: '2026-01-01', percentBp: 1000 }))
    await saveAllocation(make({ effectiveFrom: '2026-03-01', percentBp: 2000 }))
    await saveAllocation(make({ effectiveFrom: '2026-05-01', percentBp: 3000 }))
    expect((await allocationsFor('2026-02')).map((a) => a.percentBp)).toEqual([1000])
    expect((await allocationsFor('2026-03')).map((a) => a.percentBp)).toEqual([2000])
    expect((await allocationsFor('2026-04')).map((a) => a.percentBp)).toEqual([2000])
    expect((await allocationsFor('2027-01')).map((a) => a.percentBp)).toEqual([3000])
  })

  it('applies a mid-month or last-day allocation to the whole of that month', async () => {
    await saveAllocation(make({ effectiveFrom: '2026-01-01', percentBp: 1000 }))
    await saveAllocation(make({ effectiveFrom: '2026-02-15', percentBp: 2000 }))
    await saveAllocation(make({ effectiveFrom: '2026-02-28', categoryId: 'cat.pets', percentBp: 500 }))
    const feb = await allocationsFor('2026-02')
    expect(feb.find((a) => a.categoryId === 'cat.groceries')?.percentBp).toBe(2000)
    expect(feb.find((a) => a.categoryId === 'cat.pets')?.percentBp).toBe(500) // 28 Feb is the last day
    const jan = await allocationsFor('2026-01')
    expect(jan.map((a) => a.categoryId)).toEqual(['cat.groceries'])
    expect(jan[0]?.percentBp).toBe(1000)
  })

  it('finds the last day of a leap February and of December', async () => {
    await saveAllocation(make({ effectiveFrom: '2028-02-29', percentBp: 100 }))
    await saveAllocation(make({ categoryId: 'cat.pharmacy', effectiveFrom: '2026-12-31', percentBp: 200 }))
    expect((await allocationsFor('2028-02')).map((a) => a.percentBp)).toEqual([100, 200]) // cat.pharmacy carries over; 29 Feb counts
    expect((await allocationsFor('2028-01')).map((a) => a.percentBp)).toEqual([200])
    expect(await allocationsFor('2026-12')).toHaveLength(1)
    expect(await allocationsFor('2026-11')).toHaveLength(0)
  })

  it('returns nothing for a month before the first effectiveFrom', async () => {
    await saveAllocation(make({ effectiveFrom: '2026-03-10' }))
    expect(await allocationsFor('2026-02')).toEqual([])
  })

  it('keeps one allocation per target when several are in force', async () => {
    await saveAllocation(make({ effectiveFrom: '2026-01-01', percentBp: 1000 }))
    await saveAllocation(make({ effectiveFrom: '2026-02-01', percentBp: 1200 }))
    await saveAllocation(make({ categoryId: 'cat.shopping', percentBp: null, fixedCents: 4000 }))
    await saveAllocation(make({ categoryId: null, savingsGoalId: 'goal.1', percentBp: 500 }))
    const got = await allocationsFor('2026-06')
    expect(got).toHaveLength(3)
    expect(got.find((a) => a.categoryId === 'cat.groceries')?.percentBp).toBe(1200)
    expect(got.find((a) => a.categoryId === 'cat.shopping')?.fixedCents).toBe(4000)
    expect(got.find((a) => a.savingsGoalId === 'goal.1')?.percentBp).toBe(500)
  })

  it('breaks a tie between restored rows deterministically by id', async () => {
    const row = { categoryId: 'cat.groceries', savingsGoalId: null, percentBp: 1, fixedCents: null, effectiveFrom: '2026-01-01', note: null }
    await db.budgetAllocations.bulkAdd([{ ...row, id: 'a' }, { ...row, id: 'b', percentBp: 2 }])
    expect((await allocationsFor('2026-01')).map((a) => a.id)).toEqual(['b'])
  })

  it('refuses a malformed month', async () => {
    await expect(allocationsFor('2026-13')).rejects.toThrow(/Invalid month/)
  })
})

describe('deleteAllocation', () => {
  it('removes the row, and an earlier allocation comes back into force', async () => {
    await saveAllocation(make({ effectiveFrom: '2026-01-01', percentBp: 1000 }))
    const later = await saveAllocation(make({ effectiveFrom: '2026-02-01', percentBp: 2000 }))
    await deleteAllocation(later.id)
    expect((await allocationsFor('2026-03')).map((a) => a.percentBp)).toEqual([1000])
    await expect(deleteAllocation('nope')).resolves.toBeUndefined()
  })
})
