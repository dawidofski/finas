import { attribute } from './attribute'
import { monthlyBudget } from '../budget/month'
import { monthSeries } from '../analytics/series'

export interface GoalMonth { month: string; goalId: string; contributedCents: number; allocatedCents: number }

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// The pure share-out lives in its own module so budget/month.ts can use it without importing this one (this one imports month.ts).
export { attribute }

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
