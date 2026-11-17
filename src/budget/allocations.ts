import { db } from '../db/db'
import type { BudgetAllocationRow } from '../db/schema'
import { addDays, monthKeyOf } from '../lib/dates'

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** The refusal is written for the owner, who reads it on screen: plain words, no field names, no blame. */
export class AllocationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AllocationError'
  }
}

function present(v: unknown): boolean {
  return v !== null && v !== undefined
}

/** Both exclusivity rules, plus the shape of the numbers. Nothing here looks at the total: over 100 % is allowed (spec §21.5). */
function validate(input: Omit<BudgetAllocationRow, 'id'>): void {
  const hasCategory = present(input.categoryId)
  const hasGoal = present(input.savingsGoalId)
  // A savings goal's contribution is itself an allocation (§23.2), so one row must name exactly one thing it is for.
  if (hasCategory && hasGoal) {
    throw new AllocationError('Choose either a spending category or a savings goal for this amount, not both.')
  }
  if (!hasCategory && !hasGoal) {
    throw new AllocationError('Choose a spending category or a savings goal for this amount.')
  }

  const hasPercent = present(input.percentBp)
  const hasFixed = present(input.fixedCents)
  if (hasPercent && hasFixed) {
    throw new AllocationError('Set this as a share of income or as a fixed amount, not both.')
  }
  if (!hasPercent && !hasFixed) {
    throw new AllocationError('Set this as a share of income or as a fixed amount.')
  }
  if (hasPercent && (!Number.isInteger(input.percentBp) || (input.percentBp as number) < 0)) {
    throw new AllocationError('The share of income must be zero or more, with at most two decimals.')
  }
  if (hasFixed && (!Number.isInteger(input.fixedCents) || (input.fixedCents as number) < 0)) {
    throw new AllocationError('The fixed amount must be zero or more.')
  }

  // Round-tripping through addDays rejects 2026-02-30, which a bare regex would let through.
  let validDate = DATE_RE.test(input.effectiveFrom)
  if (validDate) {
    try { validDate = addDays(input.effectiveFrom, 0) === input.effectiveFrom } catch { validDate = false }
  }
  if (!validDate) throw new AllocationError('Choose a valid date for this allocation to start.')
}

function targetKey(a: BudgetAllocationRow): string {
  return a.categoryId !== null ? `category:${a.categoryId}` : `goal:${a.savingsGoalId}`
}

/**
 * Saves an allocation. Saving a second one for the same target on the same effectiveFrom replaces the first (keeping
 * its id): two allocations for one target on one day would be a tie with no meaning, and "I changed my mind today"
 * is the only way the owner can produce one.
 */
export async function saveAllocation(input: Omit<BudgetAllocationRow, 'id'>): Promise<BudgetAllocationRow> {
  validate(input)
  // After the exclusivity rules, so an input naming both targets is told that, not that one of them is missing.
  // Without this the budget would show a real euro figure against a target with no name (a plausible wrong number).
  if (present(input.categoryId) && !(await db.categories.get(input.categoryId as string))) {
    throw new AllocationError('That spending category no longer exists. Choose another one.')
  }
  if (present(input.savingsGoalId) && !(await db.savingsGoals.get(input.savingsGoalId as string))) {
    throw new AllocationError('That savings goal no longer exists. Choose another one.')
  }
  const row: BudgetAllocationRow = {
    id: crypto.randomUUID(),
    categoryId: input.categoryId ?? null,
    savingsGoalId: input.savingsGoalId ?? null,
    percentBp: input.percentBp ?? null,
    fixedCents: input.fixedCents ?? null,
    effectiveFrom: input.effectiveFrom,
    note: input.note ?? null,
  }
  await db.transaction('rw', db.budgetAllocations, async () => {
    const same = (await db.budgetAllocations.toArray()).find(
      (a) => targetKey(a) === targetKey(row) && a.effectiveFrom === row.effectiveFrom,
    )
    // Replace, keeping the id: two rows for one target and day would leave "the one in force" ambiguous, and an
    // overwrite is the lesser surprise. This is deliberate, and pinned by a test.
    if (same) row.id = same.id
    await db.budgetAllocations.put(row)
  })
  return row
}

/**
 * The one allocation per target in force for `month` ('YYYY-MM').
 *
 * In force = the greatest effectiveFrom on or before the LAST day of the month, not the first. A budget is a
 * statement about a whole month, so an allocation set or edited on the 15th governs that entire month rather than
 * leaving its first fortnight under the old figure; taking the first day would make every mid-month edit invisible
 * until the next month. The cost is that an allocation dated the 31st governs a month in which it has barely lived,
 * which is the same trade made the other way round and the one the owner expects.
 */
export async function allocationsFor(month: string): Promise<BudgetAllocationRow[]> {
  if (!MONTH_RE.test(month)) throw new Error(`Invalid month, expected YYYY-MM: ${month}`)
  const nextStart = `${monthKeyOf(addDays(`${month}-28`, 4))}-01`
  const lastDay = addDays(nextStart, -1)

  const inForce = new Map<string, BudgetAllocationRow>()
  for (const a of await db.budgetAllocations.toArray()) {
    if (a.effectiveFrom > lastDay) continue
    const key = targetKey(a)
    const best = inForce.get(key)
    // Equal dates cannot arise through saveAllocation; the id tie-break only keeps a restored backup deterministic.
    if (!best || a.effectiveFrom > best.effectiveFrom || (a.effectiveFrom === best.effectiveFrom && a.id > best.id)) {
      inForce.set(key, a)
    }
  }
  return [...inForce.values()].sort((x, y) => (targetKey(x) < targetKey(y) ? -1 : 1))
}

export async function deleteAllocation(id: string): Promise<void> {
  await db.budgetAllocations.delete(id)
}
