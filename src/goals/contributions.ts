import { monthlyBudget } from '../budget/month'
import { monthSeries } from '../analytics/series'

export interface GoalMonth { month: string; goalId: string; contributedCents: number; allocatedCents: number }

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Shares `savedCents` between goals in proportion to their allocations, each goal capped at its own allocation, and the
 * parts sum to EXACTLY min(savedCents, sum of allocations). Whole cents come from the floor of each exact share; the
 * cents still unplaced go, one each, to the goals with the largest fractional remainder, ties broken by goal id, so the
 * answer never depends on the order the goals arrive in and independent rounding can neither mint nor lose a cent.
 * Nothing saved (zero or negative) attributes nothing. Every goal given appears in the result, with 0 if it gets none.
 * A goal named twice has its allocations added together.
 */
export function attribute(
  savedCents: number, allocations: readonly { goalId: string; allocatedCents: number }[],
): Map<string, number> {
  const alloc = new Map<string, number>()
  for (const a of allocations) alloc.set(a.goalId, (alloc.get(a.goalId) ?? 0) + Math.max(0, a.allocatedCents))
  const ids = [...alloc.keys()].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0))
  const result = new Map<string, number>(ids.map((id) => [id, 0]))
  let total = 0
  for (const id of ids) total += alloc.get(id) ?? 0
  const target = Math.min(savedCents, total)
  if (target <= 0) return result

  let placed = 0
  const remainders: { id: string; rem: number }[] = []
  for (const id of ids) {
    const numerator = target * (alloc.get(id) ?? 0)
    const rem = numerator % total
    const whole = (numerator - rem) / total
    result.set(id, whole)
    placed += whole
    remainders.push({ id, rem })
  }
  // Largest remainder first; equal remainders in goal-id order (ids is already sorted and the sort is stable).
  remainders.sort((x, y) => y.rem - x.rem || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
  for (let left = target - placed, i = 0; left > 0; left--, i++) {
    const next = remainders[i]
    if (!next) break
    result.set(next.id, (result.get(next.id) ?? 0) + 1)
  }
  return result
}

/**
 * Completed months only, oldest first. The month `today` falls in is never included (a part-month is not a small whole
 * month), nor is a month with no records. Within a month, goals are in goal-id order.
 */
export async function goalContributions(firstMonth: string, lastMonth: string, today: string, computedAt: number): Promise<GoalMonth[]> {
  if (!MONTH_RE.test(firstMonth)) throw new Error(`Invalid month, expected YYYY-MM: ${firstMonth}`)
  if (!MONTH_RE.test(lastMonth)) throw new Error(`Invalid month, expected YYYY-MM: ${lastMonth}`)
  if (!DATE_RE.test(today)) throw new Error(`Invalid date, expected YYYY-MM-DD: ${today}`)
  const running = today.slice(0, 7)
  const points = await monthSeries(firstMonth, lastMonth, today, computedAt)
  const out: GoalMonth[] = []
  for (const p of points) {
    if (!p.hasData || p.month === running) continue
    const budget = await monthlyBudget(p.month, today)
    const goalLines = budget.lines.filter((l) => l.targetKind === 'goal')
    const shares = attribute(budget.totals.savingsCents, goalLines.map((l) => ({ goalId: l.targetId, allocatedCents: l.allocatedCents })))
    const allocatedBy = new Map<string, number>()
    for (const l of goalLines) allocatedBy.set(l.targetId, (allocatedBy.get(l.targetId) ?? 0) + l.allocatedCents)
    for (const [goalId, contributedCents] of shares) {
      out.push({ month: p.month, goalId, contributedCents, allocatedCents: allocatedBy.get(goalId) ?? 0 })
    }
  }
  return out
}
