import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../db/db'
import { seedDatabase } from '../db/seed'
import { allocationsFor, saveAllocation } from '../budget/allocations'
import { attribute } from './contributions'
import { archiveGoal, completeGoal, createGoal, updateGoal } from './store'

const AT = Date.UTC(2026, 10, 5, 12) // 2026-11-05
const DEC10 = Date.UTC(2026, 11, 10) // 2026-12-10
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
    await updateGoal(g.id, { name: 'Nuevo', targetCents: 5000 }, DEC10)
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
    await expect(updateGoal(g.id, { targetCents: 0 }, DEC10)).rejects.toThrow(/above zero/)
    await expect(updateGoal(g.id, { contributionPercentBp: 10001 }, DEC10)).rejects.toThrow(/between/)
    await expect(updateGoal(g.id, { name: '' }, DEC10)).rejects.toThrow(/name/)
    await expect(updateGoal(g.id, { deadline: 'mañana' }, DEC10)).rejects.toThrow(/deadline/)
    await expect(updateGoal('nope', { name: 'x' }, DEC10)).rejects.toThrow(/no longer exists/)
    expect(await db.savingsGoals.get(g.id)).toEqual(g)
  })

  it('writes the new percentage with the goal in one transaction, or neither', async () => {
    const g = await createGoal(input, AT)
    vi.spyOn(db.budgetAllocations, 'put').mockRejectedValue(new Error('disk full'))
    await expect(updateGoal(g.id, { name: 'Nuevo', contributionPercentBp: 2000 }, DEC10)).rejects.toThrow()
    expect(await db.savingsGoals.get(g.id)).toEqual(g)
    vi.restoreAllMocks()
    expect((await db.budgetAllocations.toArray())[0]?.percentBp).toBe(1000)
  })

  it('never edits an allocation in place: a changed percentage starts a new one on the day given', async () => {
    const g = await createGoal(input, AT)
    const [first] = await db.budgetAllocations.toArray()
    await updateGoal(g.id, { contributionPercentBp: 2000 }, DEC10)
    expect(await db.budgetAllocations.count()).toBe(2)
    expect(await db.budgetAllocations.get(first?.id ?? '')).toEqual(first) // untouched, same start date
    expect((await allocationsFor('2026-11'))[0]?.percentBp).toBe(1000) // a month already lived keeps its share
    expect((await allocationsFor('2026-12'))[0]).toMatchObject({ percentBp: 2000, effectiveFrom: '2026-12-10' })
    expect((await db.savingsGoals.get(g.id))?.contributionPercentBp).toBe(2000)
  })

  it('compares the new percentage with the allocation in force, not with the goal row', async () => {
    const g = await createGoal(input, AT) // row says 1000
    await saveAllocation({ categoryId: null, savingsGoalId: g.id, percentBp: 2000, fixedCents: null, effectiveFrom: '2026-11-20', note: null }) // a Budget-screen edit
    await updateGoal(g.id, { contributionPercentBp: 1000 }, DEC10) // equals the row, differs from what is in force
    expect((await allocationsFor('2026-12'))[0]).toMatchObject({ percentBp: 1000, effectiveFrom: '2026-12-10' })
    await updateGoal(g.id, { contributionPercentBp: 1000 }, Date.UTC(2026, 11, 20)) // now equal to what is in force
    expect(await db.budgetAllocations.count()).toBe(3)
  })
})

/** The shares in force for a month, as attribute() takes them (basis points stand in for cents: only the ratio matters). */
const inForce = async (month: string) =>
  (await allocationsFor(month)).map((a) => ({ goalId: a.savingsGoalId ?? '', allocatedCents: (a.percentBp ?? 0) * 10 }))

describe('archiveGoal and completeGoal', () => {
  it('archiving gives the goal nothing for the whole month it happens in and every month after, and the other goal gets more', async () => {
    const a = await createGoal(input, AT)
    const b = await createGoal({ ...input, name: 'Otra' }, AT)
    const before = attribute(10000, await inForce('2026-12'))
    expect(before.get(a.id)).toBe(5000)
    expect(before.get(b.id)).toBe(5000)

    await archiveGoal(a.id, DEC10)
    expect((await db.savingsGoals.get(a.id))?.archived).toBe(true)
    expect(await db.budgetAllocations.where('savingsGoalId').equals(a.id).count()).toBe(2) // history kept, one zero added
    // November (before the day) is untouched, so past contributions stay computable.
    const nov = attribute(10000, await inForce('2026-11'))
    expect(nov.get(a.id)).toBe(5000)
    for (const month of ['2026-12', '2027-01', '2030-06']) {
      const after = attribute(10000, await inForce(month))
      expect(after.get(a.id), month).toBe(0)
      expect(after.get(b.id), month).toBe(10000)
    }
    await expect(archiveGoal('nope', DEC10)).rejects.toThrow(/no longer exists/)
  })

  it('completing ends the allocation the same way (the whole month it happens in and after), and only the first completion does', async () => {
    const a = await createGoal(input, AT)
    const b = await createGoal({ ...input, name: 'Otra' }, AT)
    await completeGoal(a.id, DEC10)
    await completeGoal(a.id, Date.UTC(2027, 2, 1))
    expect((await db.savingsGoals.get(a.id))?.completedAt).toBe(DEC10)
    expect(await db.budgetAllocations.where('savingsGoalId').equals(a.id).count()).toBe(2)
    const after = attribute(10000, await inForce('2027-01'))
    expect(after.get(a.id)).toBe(0)
    expect(after.get(b.id)).toBe(10000)
    await expect(completeGoal('nope', AT)).rejects.toThrow(/no longer exists/)
  })

  it('writes the row change and the allocation together, or neither', async () => {
    const g = await createGoal(input, AT)
    vi.spyOn(db.budgetAllocations, 'put').mockRejectedValue(new Error('disk full'))
    await expect(archiveGoal(g.id, DEC10)).rejects.toThrow()
    await expect(completeGoal(g.id, DEC10)).rejects.toThrow()
    expect(await db.savingsGoals.get(g.id)).toEqual(g)
  })
})
