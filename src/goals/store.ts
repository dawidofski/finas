import { db } from '../db/db'
import type { SavingsGoalRow } from '../db/schema'
import { saveAllocation } from '../budget/allocations'
import { addDays, epochMsToIso } from '../lib/dates'

/** The refusal is written for the owner, who reads it on screen: plain words, no field names, no blame. */
export class GoalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GoalError'
  }
}

export interface GoalInput {
  name: string
  targetCents: number
  deadline: string | null
  contributionPercentBp: number
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const MAX_PERCENT_BP = 10000

function checkName(name: string): string {
  const trimmed = typeof name === 'string' ? name.trim() : ''
  if (trimmed === '') throw new GoalError('Give the goal a name.')
  return trimmed
}

function checkTarget(targetCents: number): number {
  if (!Number.isInteger(targetCents) || targetCents <= 0) {
    throw new GoalError('The target must be an amount of money above zero.')
  }
  return targetCents
}

function checkPercent(percentBp: number): number {
  if (!Number.isInteger(percentBp) || percentBp < 0 || percentBp > MAX_PERCENT_BP) {
    throw new GoalError('The share of income must be between 0 % and 100 %, with at most two decimals.')
  }
  return percentBp
}

function checkDeadline(deadline: string | null): string | null {
  if (deadline === null) return null
  // Round-tripping through addDays rejects 2026-02-30, which a bare regex would let through.
  let valid = typeof deadline === 'string' && DATE_RE.test(deadline)
  if (valid) {
    try { valid = addDays(deadline, 0) === deadline } catch { valid = false }
  }
  if (!valid) throw new GoalError('Choose a valid deadline, or leave it empty.')
  return deadline
}

/**
 * Creates a goal and the allocation that makes it contribute, in ONE transaction: a goal with no allocation would
 * contribute nothing forever, and an allocation pointing at no goal would show as a removed goal. The allocation starts
 * on the day `at` falls in. `at` is an argument because the clock is read only at the sanctioned boundary.
 */
export async function createGoal(input: GoalInput, at: number): Promise<SavingsGoalRow> {
  const row: SavingsGoalRow = {
    id: crypto.randomUUID(),
    name: checkName(input.name),
    targetCents: checkTarget(input.targetCents),
    deadline: checkDeadline(input.deadline),
    contributionPercentBp: checkPercent(input.contributionPercentBp),
    createdAt: at,
    completedAt: null,
    archived: false,
  }
  await db.transaction('rw', db.savingsGoals, db.budgetAllocations, async () => {
    await db.savingsGoals.add(row)
    await saveAllocation({
      categoryId: null, savingsGoalId: row.id, percentBp: row.contributionPercentBp, fixedCents: null,
      effectiveFrom: epochMsToIso(at), note: null,
    })
  })
  return row
}

/**
 * Edits a goal. Fields absent from the patch are left alone. When the percentage changes, the allocation is written in the
 * same transaction. With `at`, the new percentage starts on that day and the earlier allocation stays as history (months
 * already lived keep the share they had). Without it, the goal's latest allocation is replaced in place, keeping its
 * start date: there is no clock here to date a new one by.
 */
export async function updateGoal(
  id: string,
  patch: Partial<Pick<SavingsGoalRow, 'name' | 'targetCents' | 'deadline' | 'contributionPercentBp'>>,
  at?: number,
): Promise<void> {
  const existing = await db.savingsGoals.get(id)
  if (!existing) throw new GoalError('That savings goal no longer exists.')
  const next: SavingsGoalRow = { ...existing }
  if (patch.name !== undefined) next.name = checkName(patch.name)
  if (patch.targetCents !== undefined) next.targetCents = checkTarget(patch.targetCents)
  if (patch.deadline !== undefined) next.deadline = checkDeadline(patch.deadline)
  if (patch.contributionPercentBp !== undefined) next.contributionPercentBp = checkPercent(patch.contributionPercentBp)

  await db.transaction('rw', db.savingsGoals, db.budgetAllocations, async () => {
    await db.savingsGoals.put(next)
    if (next.contributionPercentBp === existing.contributionPercentBp) return
    let effectiveFrom: string
    if (at !== undefined) {
      effectiveFrom = epochMsToIso(at)
    } else {
      const latest = (await db.budgetAllocations.where('savingsGoalId').equals(id).toArray())
        .sort((x, y) => (x.effectiveFrom < y.effectiveFrom ? 1 : x.effectiveFrom > y.effectiveFrom ? -1 : 0))[0]
      effectiveFrom = latest?.effectiveFrom ?? epochMsToIso(existing.createdAt)
    }
    await saveAllocation({
      categoryId: null, savingsGoalId: id, percentBp: next.contributionPercentBp, fixedCents: null, effectiveFrom, note: null,
    })
  })
}

/**
 * Archives a goal. Nothing is deleted: the row and every allocation stay, so past contributions remain computable.
 */
export async function archiveGoal(id: string): Promise<void> {
  const n = await db.savingsGoals.where('id').equals(id).modify({ archived: true })
  if (n === 0) throw new GoalError('That savings goal no longer exists.')
}

/** Marks a goal reached at `at`. A goal already marked keeps its first completion time. */
export async function completeGoal(id: string, at: number): Promise<void> {
  await db.transaction('rw', db.savingsGoals, async () => {
    const goal = await db.savingsGoals.get(id)
    if (!goal) throw new GoalError('That savings goal no longer exists.')
    if (goal.completedAt === null) await db.savingsGoals.put({ ...goal, completedAt: at })
  })
}
