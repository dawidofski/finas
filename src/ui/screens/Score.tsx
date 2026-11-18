import { useEffect, useRef, useState, type ReactNode } from 'react'
import { cached } from '../../analytics/cache'
import { monthSeries, type MonthPoint } from '../../analytics/series'
import { monthlyBudget } from '../../budget/month'
import { db } from '../../db/db'
import { regretClusters, type RegretCluster } from '../../learning/regret'
import { addDays, monthKeyOf } from '../../lib/dates'
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
const monthsBetween = (from: string, to: string): string[] => {
  const out: string[] = []
  for (let m = to; m >= from; m = previousMonth(m)) out.push(m)
  return out.reverse()
}

/** One pattern's counts added across months, so a window of several months is one set of clusters. */
function mergeClusters(perMonth: readonly (readonly RegretCluster[])[]): RegretCluster[] {
  const merged = new Map<string, RegretCluster>()
  for (const c of perMonth.flat()) {
    const id = JSON.stringify([c.by, c.key])
    const have = merged.get(id)
    if (have === undefined) merged.set(id, { ...c })
    else { have.regretted += c.regretted; have.total += c.total; have.cents += c.cents }
  }
  return [...merged.values()]
}

/**
 * The six measures, each from the cache (§39.4: this screen never reads the ledger itself). A measure is cached whole,
 * under a key naming its window, and recomputed when the data it reads has moved. Goals are the exception: they are
 * read straight from the small goals table, because the cache's inputs digest does not cover that table (see cache.ts),
 * so a cached goal figure could outlive an edit.
 */
async function measures(today: string, computedAt: number): Promise<Record<ComponentId, Component>> {
  const month = today.slice(0, 7)
  const last = previousMonth(month)
  const seriesFrom = monthsBack(last, SERIES_MONTHS - 1)
  const lateFrom = monthsBack(last, LEARNING_MONTHS - 1)
  const earlyTo = previousMonth(lateFrom)
  const earlyFrom = monthsBack(earlyTo, LEARNING_MONTHS - 1)
  const reviewFrom = monthsBack(month, REVIEW_MONTHS - 1)

  const points: MonthPoint[] = await monthSeries(seriesFrom, last, today, computedAt)
  const regrets = (from: string, to: string): Promise<RegretCluster[]> =>
    Promise.all(monthsBetween(from, to).map((m) => regretClusters(m))).then(mergeClusters)

  const [budget, savings, trend, review, goals, repeated] = await Promise.all([
    cached(`score:budget-awareness:${seriesFrom}:${last}`, async () =>
      budgetAwareness(await Promise.all(points.map(async (p) => ({ budget: await monthlyBudget(p.month, today), hasData: p.hasData })))), computedAt),
    cached(`score:savings-consistency:${seriesFrom}:${last}`, async () => savingsConsistency(points), computedAt),
    cached(`score:improvement:${seriesFrom}:${last}`, async () => improvement(points), computedAt),
    // The window ends at the last day any month can have: dates are strings, so a bound later than the month's real end is harmless, and it keeps the key stable all month.
    cached(`score:spending-awareness:${reviewFrom}:${month}`, () => spendingAwareness(`${reviewFrom}-01`, `${month}-31`), computedAt),
    db.savingsGoals.toArray().then(goalProgress),
    cached(`score:learning:${earlyFrom}:${earlyTo}:${lateFrom}:${last}`, async () => learning(await regrets(earlyFrom, earlyTo), await regrets(lateFrom, last)), computedAt),
  ])
  return {
    'budget-awareness': budget, 'savings-consistency': savings, 'improvement': trend,
    'spending-awareness': review, 'goal-progress': goals, 'learning': repeated,
  }
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
        <dd>{c.kind === 'measured' ? c.inputs : `Nothing to work from yet. ${c.why}`}</dd>
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
  return (
    <>
      <h2>How the total is worked out</h2>
      <p>Weight measured: {result.weightUsed} of {all}. Only what could be measured is added up, and the total is divided by the weight of exactly those parts.</p>
      <p>{sum} ÷ {result.weightUsed}, rounded to a whole number, gives {result.score}. A score of 100 appears only when every measured part scored 100.</p>
    </>
  )
}

/** `today` and `computedAt` come from the route, the one place the clock is read. */
export default function Score({ today, computedAt }: { today: string; computedAt: number }): ReactNode {
  const [result, setResult] = useState<MoneyScore | null>(null)
  const [error, setError] = useState<string | null>(null)
  const latest = useRef(0)

  useEffect(() => {
    const mine = ++latest.current
    setResult(null); setError(null)
    measures(today, computedAt).then(
      (m) => { if (mine === latest.current) setResult(moneyScore(m)) },
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
            <p>
              To begin, <a href="#/import">import your ING statements</a>. Each of the six parts below says what it is waiting for.
            </p>
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
