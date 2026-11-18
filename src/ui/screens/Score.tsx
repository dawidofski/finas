import { useEffect, useRef, useState, type ReactNode } from 'react'
import { cached } from '../../analytics/cache'
import { monthSeries, type MonthPoint } from '../../analytics/series'
import { monthlyBudget } from '../../budget/month'
import { db } from '../../db/db'
import type { SavingsGoalRow } from '../../db/schema'
import { regretClustersBetween } from '../../learning/regret'
import { goalContributions } from '../../goals/contributions'
import { progressOf } from '../../goals/progress'
import { GOAL_MONTHS, goalWindow } from '../../goals/window'
import { addDays, monthKeyOf } from '../../lib/dates'
import { divRound } from '../../lib/money'
import { budgetAwareness, goalProgress, improvement, learning, savingsConsistency, spendingAwareness, type Component } from '../../score/components'
import { moneyScore, type ComponentId, type MoneyScore, type ScoredComponent } from '../../score/score'

/** Completed months the series-based measures look back over. Improvement needs six of them to have spending, so this leaves room for gaps. */
const SERIES_MONTHS = 12
/** Months in the review window, counting the one in progress: the review measure speaks about recent activity. */
const REVIEW_MONTHS = 6
/** Each of the two windows the repeated-regret measure compares: the latest completed months, and the same number before them. */
const LEARNING_MONTHS = 3

const previousMonth = (m: string): string => monthKeyOf(addDays(`${m}-01`, -1))
const monthsBack = (from: string, n: number): string => { let m = from; for (let i = 0; i < n; i++) m = previousMonth(m); return m }
/** The last day of a month, 'YYYY-MM-DD': the day before the first of the next. */
const lastDayOf = (month: string): string => addDays(`${monthKeyOf(addDays(`${month}-28`, 4))}-01`, -1)

/**
 * The six measures, each from the cache (§39.4: this screen never reads the ledger itself). A measure is cached whole,
 * under a key naming its window, so a new month is a new key. Within a window it is recomputed when the cache's digest
 * moves, and that digest covers transactions, annotations, transfers, budget allocations and savings goals (by content),
 * but not categories (cache.ts). Goal progress IS cached, under a key naming its window: a goal's edit, completion or
 * archiving, and the allocation each of those writes, all move the digest, so a cached figure cannot outlive one. The one
 * gap left is the budget measure, which goes through monthlyBudget and so reads category names: renaming a category
 * leaves that one measure as it was until something the digest covers changes, or the cache is rebuilt.
 */
async function measures(today: string, computedAt: number): Promise<{ parts: Record<ComponentId, Component>; recorded: boolean }> {
  const month = today.slice(0, 7)
  const last = previousMonth(month)
  const seriesFrom = monthsBack(last, SERIES_MONTHS - 1)
  const lateFrom = monthsBack(last, LEARNING_MONTHS - 1)
  const earlyTo = previousMonth(lateFrom)
  const earlyFrom = monthsBack(earlyTo, LEARNING_MONTHS - 1)
  const reviewFrom = monthsBack(month, REVIEW_MONTHS - 1)
  const reviewTo = lastDayOf(month)

  const points: MonthPoint[] = await monthSeries(seriesFrom, last, today, computedAt)
  // Whether any record exists at all, this month's included: it decides which sentence the empty state says.
  const recorded = points.some((p) => p.hasData) || (await monthSeries(month, month, today, computedAt)).some((p) => p.hasData)

  const goalRows = await db.savingsGoals.toArray()
  const [budget, savings, trend, review, goals, repeated] = await Promise.all([
    cached(`score:budget-awareness:${seriesFrom}:${last}`, async () =>
      budgetAwareness(await Promise.all(points.map(async (p) => ({ budget: await monthlyBudget(p.month, today), hasData: p.hasData })))), computedAt),
    cached(`score:savings-consistency:${seriesFrom}:${last}`, async () => savingsConsistency(points), computedAt),
    cached(`score:improvement:${seriesFrom}:${last}`, async () => improvement(points), computedAt),
    // To the month's own last day, so the window and its key stay the same all month.
    cached(`score:spending-awareness:${reviewFrom}:${month}`, () => spendingAwareness(`${reviewFrom}-01`, reviewTo), computedAt),
    goalMeasure(goalRows, last, today, computedAt),
    cached(`score:learning:${earlyFrom}:${earlyTo}:${lateFrom}:${last}`, async () => learning(await regretClustersBetween(earlyFrom, earlyTo), await regretClustersBetween(lateFrom, last)), computedAt),
  ])
  return {
    recorded,
    parts: {
      'budget-awareness': budget, 'savings-consistency': savings, 'improvement': trend,
      'spending-awareness': review, 'goal-progress': goals, 'learning': repeated,
    },
  }
}

/**
 * Goal progress: every goal's own figures from `progressOf`, the same ones the goals screen shows, over the months since the
 * earliest goal was created, at most the last GOAL_MONTHS completed months. Cached under a key naming that window.
 */
async function goalMeasure(goals: readonly SavingsGoalRow[], last: string, today: string, computedAt: number): Promise<Component> {
  if (goals.length === 0) return goalProgress([])
  const { from, capped } = goalWindow(goals, last)
  const compute = async (): Promise<Component> => {
    const months = from > last ? [] : await goalContributions(from, last, today, computedAt)
    const c = goalProgress(goals.map((goal) => ({ goal, progress: progressOf(goal, months, last) })))
    return c.kind === 'measured' && capped
      ? { ...c, inputs: `${c.inputs} Only the last ${GOAL_MONTHS} completed months are counted.` }
      : c
  }
  return from > last ? compute() : cached(`score:goal-progress:${from}:${last}`, compute, computedAt)
}

function Item({ item }: { item: ScoredComponent }): ReactNode {
  const c = item.component
  return (
    <li className="score-item">
      <h3>{item.label}</h3>
      <dl>
        <dt>Status</dt>
        <dd>{c.kind === 'measured' ? `Measured: ${c.score} out of 100` : 'Not yet measured'}</dd>
        <dt>Weight</dt>
        <dd>{item.weight}</dd>
        <dt>Inputs</dt>
        <dd>{c.kind === 'measured' ? c.inputs : c.why}</dd>
        <dt>Arithmetic</dt>
        <dd>
          {c.kind === 'measured'
            ? `${c.score} × ${item.weight} = ${c.score * item.weight}`
            : 'Left out of the sum and out of the divisor. It is not counted as 0.'}
        </dd>
      </dl>
    </li>
  )
}

function Total({ result }: { result: MoneyScore }): ReactNode {
  const all = result.components.reduce((n, c) => n + c.weight, 0)
  const sum = result.components.reduce((n, c) => n + (c.component.kind === 'measured' ? c.component.score * c.weight : 0), 0)
  const rounded = divRound(sum, result.weightUsed)
  return (
    <>
      <h2>How the total is worked out</h2>
      <p>Weight measured: {result.weightUsed} of {all}. Only what could be measured is added up, and the total is divided by the weight of exactly those parts.</p>
      {rounded > (result.score ?? 0)
        ? <p>{sum} ÷ {result.weightUsed}, rounded to a whole number, would be {rounded}. It is shown as {result.score} because 100 appears only when every measured part scored 100.</p>
        : <p>{sum} ÷ {result.weightUsed}, rounded to a whole number, gives {result.score}. A score of 100 appears only when every measured part scored 100.</p>}
    </>
  )
}

/** `today` and `computedAt` come from the route, the one place the clock is read. */
export default function Score({ today, computedAt }: { today: string; computedAt: number }): ReactNode {
  const [result, setResult] = useState<MoneyScore | null>(null)
  const [recorded, setRecorded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const latest = useRef(0)

  useEffect(() => {
    const mine = ++latest.current
    setResult(null); setError(null)
    measures(today, computedAt).then(
      (m) => { if (mine === latest.current) { setRecorded(m.recorded); setResult(moneyScore(m.parts)) } },
      (e: unknown) => {
        if (mine === latest.current) setError(`Your Money Score could not be worked out${e instanceof Error && e.message ? ` (${e.message})` : ''}. Nothing was changed.`)
      },
    )
  }, [today, computedAt])

  const heading = <h1>Money Score</h1>
  if (error) return <section className="score">{heading}<div role="alert" className="notice notice-refusal"><p>{error}</p></div></section>
  if (!result) return <section className="score">{heading}<p role="status">Loading your Money Score…</p></section>

  return (
    <section className="score">
      {heading}
      {result.score === null
        ? (
          <>
            <p>
              Your Money Score cannot be given yet. Nothing can be measured from your records so far, so there is no number to show.
              This is the normal starting point, not a result.
            </p>
            {recorded
              ? <p>Your records are in, but they do not yet cover enough to measure anything: most parts need a few completed months. Each of the six parts below says what it is waiting for.</p>
              : <p>To begin, <a href="#/import">import your bank statements</a>. Each of the six parts below says what it is waiting for.</p>}
          </>
        )
        : <p>Your Money Score: {result.score} out of 100</p>}
      {result.score !== null && <Total result={result} />}
      <h2>The six parts</h2>
      <ol aria-label="The six parts of the Money Score" className="score-items">
        {result.components.map((item) => <Item key={item.id} item={item} />)}
      </ol>
    </section>
  )
}
