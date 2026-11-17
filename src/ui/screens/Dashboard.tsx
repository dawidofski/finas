import { useEffect, useRef, useState, type ReactNode } from 'react'
import { changeFrom, monthSeries, type Change, type MonthPoint, type NumericField } from '../../analytics/series'
import { addDays, formatMonthTitle, formatSpanishDate, monthKeyOf } from '../../lib/dates'
import { formatEur } from '../../lib/money'
import { Bars } from '../charts/Bars'
import { Line } from '../charts/Line'
import { formatBp } from './Budget'

/** How many months back the screen looks. Six is what the trend line shows; it is also the window the empty state speaks about. */
const WINDOW = 6

const previousMonth = (m: string) => monthKeyOf(addDays(`${m}-01`, -1))

function windowOf(month: string): { from: string; to: string } {
  let from = month
  for (let i = 1; i < WINDOW; i++) from = previousMonth(from)
  return { from, to: month }
}

/** The months with records that run unbroken up to and including the last point. Stops at the first gap, so a line never joins across one. */
function unbrokenRun(points: MonthPoint[]): MonthPoint[] {
  const run: MonthPoint[] = []
  for (let i = points.length - 1; i >= 0; i--) {
    const p = points[i]
    if (!p || !p.hasData) break
    run.unshift(p)
  }
  return run
}

/**
 * "up 12,00 EUR (5 %)", "down ...", or "the same". A null percentage (nothing to measure against) is simply not printed, and
 * neither is any percentage while the month is still running: part of a month has no valid basis against a whole one.
 */
function movement(c: Change, partial: boolean): string | null {
  if (c.basis === 'none' || c.cents === null) return null
  if (c.cents === 0) return 'the same'
  const pct = c.bp === null || partial ? '' : ` (${formatBp(Math.abs(c.bp))})`
  return `${c.cents > 0 ? 'up' : 'down'} ${formatEur(Math.abs(c.cents))}${pct}`
}

/** `days`: how many days of the current month have passed, counting today. Only meaningful while `partial`. */
function Comparison({ previous, current, partial, days }: { previous: MonthPoint; current: MonthPoint; partial: boolean; days: number }): ReactNode {
  const last = formatMonthTitle(previous.month)
  const line = (label: string, field: NumericField, estimate: boolean): ReactNode => {
    const text = movement(changeFrom(previous, current, field), partial)
    return text === null ? null : <li key={field}>{label}: {text}{estimate ? ' (estimated income)' : ''}</li>
  }
  const incomeKnown = current.incomeBasis !== 'none' && previous.incomeBasis !== 'none'
  const estimate = current.incomeBasis === 'trailing-average' || previous.incomeBasis === 'trailing-average'
  return (
    <>
      <h2>Compared with {last}</h2>
      <ul className="dashboard-changes">
        {line('Spending', 'spentCents', false)}
        {line('Saved', 'savedCents', false)}
        {incomeKnown && line('Income', 'incomeCents', estimate)}
        {incomeKnown && line('Left over', 'netCents', estimate)}
      </ul>
      {!incomeKnown && <p>Income and what is left over are not compared, because income is not recorded for both months.</p>}
      {partial
        ? (
          <p>
            This compares {days === 1 ? 'the first day' : `the first ${days} days`} of {formatMonthTitle(current.month)} with all of {last}.
            {' '}{formatMonthTitle(current.month)} is still running, so the changes are in euros only, with no percentage.
          </p>
        )
        : <p>Both months are complete.</p>}
    </>
  )
}

/**
 * `today` (an ISO day) and `computedAt` (epoch ms) are supplied by the route, the one place the clock is read. `month` defaults to
 * the month `today` falls in; the running app never passes it. A month is still running exactly when it is today's, as in budget/month.ts.
 */
export default function Dashboard({ today, computedAt, month: shown }: { today: string; computedAt: number; month?: string }): ReactNode {
  const [points, setPoints] = useState<MonthPoint[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const latest = useRef(0)
  const month = shown ?? today.slice(0, 7)
  const partial = month === today.slice(0, 7)

  useEffect(() => {
    const mine = ++latest.current
    setPoints(null); setError(null)
    const { from, to } = windowOf(month)
    monthSeries(from, to, today, computedAt).then(
      (p) => { if (mine === latest.current) setPoints(p) },
      (e: unknown) => {
        if (mine === latest.current) setError(`Your dashboard could not be read${e instanceof Error && e.message ? ` (${e.message})` : ''}. Nothing was changed.`)
      },
    )
  }, [month, today, computedAt])

  const heading = <h1>Dashboard</h1>
  if (error) return <section className="dashboard">{heading}<div role="alert" className="notice notice-refusal"><p>{error}</p></div></section>
  if (!points) return <section className="dashboard">{heading}<p role="status">Loading your dashboard…</p></section>

  const current = points[points.length - 1]
  const previous = points.length > 1 ? points[points.length - 2] : undefined

  if (!current || !points.some((p) => p.hasData)) {
    return (
      <section className="dashboard">
        {heading}
        <p>
          There is nothing to show yet: no bank movements are recorded for the last {WINDOW} months. To begin,{' '}
          <a href="#/import">import your ING statements</a>, and your income and spending will appear here.
        </p>
      </section>
    )
  }

  const title = formatMonthTitle(current.month)
  if (!current.hasData) {
    const latestWithData = [...points].reverse().find((p) => p.hasData)
    return (
      <section className="dashboard">
        {heading}
        <h2>{title}</h2>
        <p>
          No bank movements are recorded for {title} yet.
          {latestWithData ? ` Your latest records are from ${formatMonthTitle(latestWithData.month)}.` : ''} Import your newer ING
          statements to see this month.
        </p>
        <p><a href="#/import">Import statements</a></p>
      </section>
    )
  }

  const run = unbrokenRun(points)
  const incomeLine = current.incomeBasis === 'actual' ? `Income: ${formatEur(current.incomeCents)}`
    : current.incomeBasis === 'trailing-average' ? `Income: ${formatEur(current.incomeCents)} (an estimate: the average of your last three months)`
      : 'Income: none recorded yet this month'
  const netLine = current.incomeBasis === 'none' ? 'Left over: cannot be worked out until this month’s income is recorded'
    : `Left over: ${formatEur(current.netCents)}${current.incomeBasis === 'trailing-average' ? ' (based on estimated income)' : ''}`

  // Only fixed, short names reach the bars. A category name could run into its amount, because the chart does not truncate.
  const split = [
    { label: 'Essentials', cents: current.essentialCents },
    { label: 'Discretionary', cents: current.discretionaryCents },
    ...(current.uncategorisedCents > 0 ? [{ label: 'Not categorised', cents: current.uncategorisedCents }] : []),
  ]

  return (
    <section className="dashboard">
      {heading}
      <h2>{title}</h2>
      <p>{partial ? `Figures up to ${formatSpanishDate(today)}.` : 'Figures for the whole month.'}</p>
      <ul className="dashboard-figures">
        <li>{incomeLine}</li>
        <li>Spent: {formatEur(current.spentCents)}</li>
        <li>Saved: {formatEur(current.savedCents)}</li>
        <li>{netLine}</li>
      </ul>
      {current.uncategorisedCents < 0 && (
        <p>{formatEur(-current.uncategorisedCents)} of money returned to you is not filed under a spending category, so it is not counted as spending.</p>
      )}

      {previous && previous.hasData
        ? <Comparison previous={previous} current={current} partial={partial} days={Number(today.slice(8, 10))} />
        : <p>There is no earlier month with records to compare {title} with.</p>}

      {current.spentCents > 0 && <Bars points={split} title={`Where ${title} spending went`} />}

      {run.length >= 2
        ? <Line points={run.map((p) => ({ label: formatMonthTitle(p.month), cents: p.spentCents }))} title={partial ? 'Spending by month (the latest month is still running)' : 'Spending by month'} />
        : <p>A line of your spending month by month appears once two months in a row have records. You have {run.length} so far.</p>}

      <p><a href="#/budget">Open the budget</a> · <a href="#/transactions">See your transactions</a></p>
    </section>
  )
}
