import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../db/db'
import { seedDatabase } from '../db/seed'
import { allocationsFor } from '../budget/allocations'
import { archiveGoal, completeGoal, createGoal, updateGoal } from './store'

const AT = Date.UTC(2026, 10, 5, 12) // 2026-11-05
const input = { name: 'Viaje inventado', targetCents: 120000, deadline: '2027-06-30', contributionPercentBp: 1000 }

beforeEach(async () => {
  vi.restoreAllMocks()
  await db.delete(); await db.open(); await seedDatabase()
})

describe('createGoal', () => {
  it('creates a goal together with its allocation, or neither', async () => {
    const goal = await createGoal(input, AT)
    expect(await db.savingsGoals.get(goal.id)).toEqual(goal)
    expect(goal).toMatchObject({ createdAt: AT, completedAt: null, archived: false, name: 'Viaje inventado' })
    const allocs = await db.budgetAllocations.toArray()
    expect(allocs).toHaveLength(1)
    expect(allocs[0]).toMatchObject({ savingsGoalId: goal.id, categoryId: null, percentBp: 1000, fixedCents: null, effectiveFrom: '2026-11-05' })

    // The allocation write fails: the goal row must not remain.
    vi.spyOn(db.budgetAllocations, 'put').mockRejectedValue(new Error('disk full'))
    await expect(createGoal({ ...input, name: 'Otra' }, AT)).rejects.toThrow()
    expect(await db.savingsGoals.count()).toBe(1)
    expect(await db.budgetAllocations.count()).toBe(1)
  })

  it('refuses a target that is not a positive whole number of cents', async () => {
    for (const bad of [0, -5, 10.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(createGoal({ ...input, targetCents: bad }, AT), String(bad)).rejects.toThrow(/above zero/)
    }
    expect(await db.savingsGoals.count()).toBe(0)
    expect(await db.budgetAllocations.count()).toBe(0)
  })

  it('refuses a percentage outside 0 to 10000 basis points, or not whole', async () => {
    for (const bad of [-1, 10001, 12.5, Number.NaN]) {
      await expect(createGoal({ ...input, contributionPercentBp: bad }, AT), String(bad)).rejects.toThrow(/between 0 % and 100 %/)
    }
    expect(await db.savingsGoals.count()).toBe(0)
    await createGoal({ ...input, contributionPercentBp: 0 }, AT)
    await createGoal({ ...input, contributionPercentBp: 10000 }, AT)
    expect(await db.savingsGoals.count()).toBe(2)
  })

  it('refuses an empty name and a malformed deadline, writing nothing', async () => {
    await expect(createGoal({ ...input, name: '   ' }, AT)).rejects.toThrow(/name/)
    for (const bad of ['2027-02-30', '30/06/2027', '2027-6-30', '']) {
      await expect(createGoal({ ...input, deadline: bad }, AT), bad).rejects.toThrow(/deadline/)
    }
    expect(await db.savingsGoals.count()).toBe(0)
    expect(await db.budgetAllocations.count()).toBe(0)
    expect((await createGoal({ ...input, deadline: null, name: '  Coche  ' }, AT)).name).toBe('Coche')
  })
})

describe('updateGoal', () => {
  it('edits only the fields given and leaves the allocation alone when the percentage is unchanged', async () => {
    const g = await createGoal(input, AT)
    await updateGoal(g.id, { name: 'Nuevo', targetCents: 5000 })
    expect(await db.savingsGoals.get(g.id)).toEqual({ ...g, name: 'Nuevo', targetCents: 5000 })
    expect(await db.budgetAllocations.count()).toBe(1)
  })

  it('does not write an allocation when the percentage is unchanged, even with a date', async () => {
    const g = await createGoal(input, AT)
    await updateGoal(g.id, { name: 'Nuevo' }, Date.UTC(2026, 11, 10))
    await updateGoal(g.id, { contributionPercentBp: 1000 }, Date.UTC(2026, 11, 11))
    expect(await db.budgetAllocations.count()).toBe(1)
  })

  it('refuses bad input and changes nothing', async () => {
    const g = await createGoal(input, AT)
    await expect(updateGoal(g.id, { targetCents: 0 })).rejects.toThrow(/above zero/)
    await expect(updateGoal(g.id, { contributionPercentBp: 10001 })).rejects.toThrow(/between/)
    await expect(updateGoal(g.id, { name: '' })).rejects.toThrow(/name/)
    await expect(updateGoal(g.id, { deadline: 'mañana' })).rejects.toThrow(/deadline/)
    await expect(updateGoal('nope', { name: 'x' })).rejects.toThrow(/no longer exists/)
    expect(await db.savingsGoals.get(g.id)).toEqual(g)
  })

  it('writes the new percentage with the goal in one transaction, or neither', async () => {
    const g = await createGoal(input, AT)
    vi.spyOn(db.budgetAllocations, 'put').mockRejectedValue(new Error('disk full'))
    await expect(updateGoal(g.id, { name: 'Nuevo', contributionPercentBp: 2000 })).rejects.toThrow()
    expect(await db.savingsGoals.get(g.id)).toEqual(g)
    vi.restoreAllMocks()
    expect((await db.budgetAllocations.toArray())[0]?.percentBp).toBe(1000)
  })

  it('without a date replaces the latest allocation in place; with a date adds history', async () => {
    const g = await createGoal(input, AT)
    const [first] = await db.budgetAllocations.toArray()
    await updateGoal(g.id, { contributionPercentBp: 2000 })
    const after = await db.budgetAllocations.toArray()
    expect(after).toHaveLength(1)
    expect(after[0]).toMatchObject({ id: first?.id, percentBp: 2000, effectiveFrom: '2026-11-05' })

    await updateGoal(g.id, { contributionPercentBp: 3000 }, Date.UTC(2026, 11, 10))
    expect(await db.budgetAllocations.count()).toBe(2)
    expect((await allocationsFor('2026-11'))[0]?.percentBp).toBe(2000)
    expect((await allocationsFor('2026-12'))[0]?.percentBp).toBe(3000)
  })
})

describe('archiveGoal and completeGoal', () => {
  it('archives without deleting, and keeps past contributions readable', async () => {
    const g = await createGoal(input, AT)
    await archiveGoal(g.id)
    expect((await db.savingsGoals.get(g.id))?.archived).toBe(true)
    expect(await db.budgetAllocations.count()).toBe(1)
    expect((await allocationsFor('2026-11')).map((a) => a.savingsGoalId)).toEqual([g.id])
    await expect(archiveGoal('nope')).rejects.toThrow(/no longer exists/)
  })

  it('marks a goal complete once, keeping the first time', async () => {
    const g = await createGoal(input, AT)
    await completeGoal(g.id, AT + 1000)
    await completeGoal(g.id, AT + 9000)
    expect((await db.savingsGoals.get(g.id))?.completedAt).toBe(AT + 1000)
    await expect(completeGoal('nope', AT)).rejects.toThrow(/no longer exists/)
  })
})
