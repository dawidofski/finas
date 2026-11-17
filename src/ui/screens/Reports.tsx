import { useEffect, useRef, useState, type ReactNode } from 'react'
import { resolveMany } from '../../db/annotations'
import { db } from '../../db/db'
import { monthlyBudget } from '../../budget/month'
import { cached } from '../../analytics/cache'
import { moodBreakdown, reasonBreakdown, worthwhileBreakdown, type AnnotatedRow } from '../../analytics/annotated'
import { afterPayday, smallPurchases, type AfterPayday, type SmallPurchases } from '../../analytics/habits'
import { changeFrom, monthSeries, type MonthPoint } from '../../analytics/series'
import { unusualIn, type UnusualRow } from '../../analytics/unusual'
import { excludedTransactionIds, treatmentOf } from '../../analysis/income'
import { loadCategoryKinds } from '../../analysis/queues'
import { liveTransactionsBetween, nextMonthStart } from '../../analysis/transactionsInRange'
import { addDays, daysBetween, formatMonthTitle, formatSpanishDate, monthKeyOf } from '../../lib/dates'
import { formatEur, percentBpOf } from '../../lib/money'
import { Bars } from '../charts/Bars'
import { Line } from '../charts/Line'
import { formatBp } from './Budget'

/*
 * The one screen that reads every figure the analytics produce. It reads them through the cache (§39.4); the two figures that
 * did not exist as functions (spending by category, and the purchases that stand out) are built here and cached the same way.
 *
 * Recurring expenses are deliberately NOT a panel. They wait on recurring detection (build-order stage 13); an empty panel
 * that promised them would say less than no panel. Add the panel when that stage lands.
 */

/** How many months back the screen looks. The month series, and the history an unusual purchase is judged against. */
const WINDOW = 6
/**
 * THE DECISION THIS SCREEN OWNS: a purchase is judged only against a category that has at least this many purchases in the
 * window. Fewer than this and a "usual amount" is a guess, so nothing is claimed. It is printed on the screen, beside the
 * result, in these same words.
 */
const MIN_SAMPLE = 8
/** A purchase is small when it is under this, in cents. Printed on the screen. */
const SMALL_CEILING_CENTS = 1000
/** Fewer days than this after payday cannot show how spending is spread, so the line is not drawn. */
const MIN_PAYDAY_DAYS = 14
/** The categories drawn as bars; the rest are summed in a sentence. */
const TOP_CATEGORIES = 8
/** The unusual purchases listed; the rest are counted. */
const TOP_UNUSUAL = 5
/**
 * Longest label handed to a bar, counting the ellipsis. `Bars` truncates nothing, and a category name is the owner's: a long one
 * runs into its own amount. 20 characters of a 12px face is about 180 of the 320 drawing units, leaving room for the amount. The
 * full name is never lost: the list beside every chart carries it.
 */
const MAX_BAR_LABEL = 20

const previousMonth = (m: string) => monthKeyOf(addDays(`${m}-01`, -1))

function windowOf(month: string): { from: string; to: string; months: string[] } {
  const months = [month]
  for (let i = 1; i < WINDOW; i++) months.unshift(previousMonth(months[0] as string))
  return { from: months[0] as string, to: month, months }
}

function shortLabel(label: string): string {
  const chars = Array.from(label)
  return chars.length <= MAX_BAR_LABEL ? label : `${chars.slice(0, MAX_BAR_LABEL - 1).join('').trimEnd()}…`
}

/** The months with records that run unbroken up to and including the last point, so a line never joins across a gap. */
function unbrokenRun(points: MonthPoint[]): MonthPoint[] {
  const run: MonthPoint[] = []
  for (let i = points.length - 1; i >= 0; i--) {
    const p = points[i]
    if (!p || !p.hasData) break
    run.unshift(p)
  }
  return run
}

interface CategorySpend { label: string; cents: number }
interface UnusualPurchase { id: string; date: string; description: string; category: string; cents: number; usualCents: number }
interface UnusualReport { judgedCategories: number; found: UnusualPurchase[] }

/** Spending by category, the Budget screen's own lines, so the two can never disagree. */
function categorySpend(month: string, today: string, computedAt: number): Promise<CategorySpend[]> {
  return cached(`reports.categories:${month}`, async () => {
    const budget = await monthlyBudget(month, today)
    return budget.lines
      .filter((l) => l.targetKind === 'category' && l.spentCents !== 0)
      .map((l) => ({ label: l.label, cents: l.spentCents }))
      .sort((a, b) => b.cents - a.cents || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))
  }, computedAt)
}

/**
 * The purchases of `month` that are far above what is usual for their category, judged against the whole window. The amounts
 * and dates are the bank's (§41); the owner's classification decides only what counts as spending, as everywhere else.
 */
function unusualPurchases(month: string, computedAt: number): Promise<UnusualReport> {
  return cached(`reports.unusual:${month}:${WINDOW}:${MIN_SAMPLE}`, async () => {
    const { from, months } = windowOf(month)
    const bank = await liveTransactionsBetween(from, month)
    const byId = new Map(bank.map((t) => [t.id, t]))
    const [resolved, kinds, categories, ...excludedPerMonth] = await Promise.all([
      resolveMany(bank), loadCategoryKinds(), db.categories.toArray(), ...months.map((m) => excludedTransactionIds(m)),
    ])
    const excluded = new Set(excludedPerMonth.flatMap((s) => [...s]))
    const names = new Map(categories.map((c) => [c.id, c.name]))
    const rows: UnusualRow[] = []
    for (const r of resolved) {
      const t = byId.get(r.id)
      if (!t || t.amountCents >= 0 || excluded.has(t.id)) continue
      if (treatmentOf(r.kind, r.categoryId === null ? null : (kinds.get(r.categoryId) ?? null)) !== 'spending') continue
      rows.push({ id: t.id, categoryId: r.categoryId, cents: -t.amountCents, month: t.valueDate.slice(0, 7) })
    }
    const perCategory = new Map<string, number>()
    for (const r of rows) if (r.categoryId !== null) perCategory.set(r.categoryId, (perCategory.get(r.categoryId) ?? 0) + 1)
    const judgedCategories = [...perCategory.values()].filter((n) => n >= MIN_SAMPLE).length
    const found = unusualIn(rows, MIN_SAMPLE).filter((u) => u.month === month).map((u): UnusualPurchase => {
      const t = byId.get(u.transactionId)
      return {
        id: u.transactionId, date: t?.valueDate ?? `${month}-01`, description: t?.description ?? '',
        category: u.categoryId === null ? '' : (names.get(u.categoryId) ?? 'Removed category'), cents: u.cents, usualCents: u.medianCents,
      }
    })
    return { judgedCategories, found }
  }, computedAt)
}

interface Detail {
  categories: CategorySpend[]
  unusual: UnusualReport
  small: SmallPurchases
  smallByMonth: Array<{ month: string; cents: number }>
  payday: AfterPayday | null
  mood: AnnotatedRow[]
  reason: AnnotatedRow[]
  worth: AnnotatedRow[]
}
/** `detail` is null when the month has no records: nothing else is read for it. */
interface Loaded { points: MonthPoint[]; detail: Detail | null }

/** The header of every panel: a named region, so a screen reader can move between panels by landmark and a keyboard by heading. */
function Panel({ id, title, children }: { id: string; title: string; children: ReactNode }): ReactNode {
  return (
    <section className="reports-panel" aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      {children}
    </section>
  )
}

/** "up 12,00 EUR (5 %)" or "down ...". A percentage is printed only against a whole month and a month that has a value to measure against. */
function movementText(cents: number, bp: number | null, partial: boolean): string {
  if (cents === 0) return 'the same as'
  const pct = !partial && bp !== null ? ` (${formatBp(Math.abs(bp))})` : ''
  return `${cents > 0 ? 'up' : 'down'} ${formatEur(Math.abs(cents))}${pct} on`
}

function monthLine(p: MonthPoint): string {
  const name = formatMonthTitle(p.month)
  if (!p.hasData) return `${name}: no records`
  const income = p.incomeBasis === 'actual' ? `income ${formatEur(p.incomeCents)}`
    : p.incomeBasis === 'trailing-average' ? `income about ${formatEur(p.incomeCents)} (an estimate)`
      : 'income not recorded'
  const left = p.incomeBasis === 'none' ? 'left over cannot be worked out'
    : `left over ${p.incomeBasis === 'trailing-average' ? 'about ' : ''}${formatEur(p.netCents)}${p.incomeBasis === 'trailing-average' ? ' (based on estimated income)' : ''}`
  return `${name}: ${income}, spent ${formatEur(p.spentCents)}, ${left}`
}

function SeriesPanel({ points, partial, today }: { points: MonthPoint[]; partial: boolean; today: string }): ReactNode {
  const current = points[points.length - 1] as MonthPoint
  const previous = points.length > 1 ? points[points.length - 2] : undefined
  const run = unbrokenRun(points)
  const gaps = points.filter((p) => !p.hasData)
  const change = previous && previous.hasData ? changeFrom(previous, current, 'spentCents') : null
  return (
    <Panel id="reports-series" title="Month by month">
      {run.length >= 2
        ? <Line points={run.map((p) => ({ label: formatMonthTitle(p.month), cents: p.spentCents }))} title={partial ? 'Spending by month (the latest month is still running)' : 'Spending by month'} />
        : <p>A line of your spending month by month appears once two months in a row have records. You have {run.length} so far.</p>}
      <ul>{points.map((p) => <li key={p.month}>{monthLine(p)}</li>)}</ul>
      {change && change.cents !== null
        ? <p>Spending in {formatMonthTitle(current.month)} is {movementText(change.cents, change.bp, partial)} {formatMonthTitle((previous as MonthPoint).month)}.</p>
        : <p>There is no earlier month with records to compare {formatMonthTitle(current.month)} with.</p>}
      {partial && <p>{formatMonthTitle(current.month)} is still running and counts only up to {formatSpanishDate(today)}, so no percentage is given for it.</p>}
      {gaps.length > 0 && run.length < points.length && <p>The line starts after the last month without records.</p>}
    </Panel>
  )
}

function CategoryPanel({ rows, title }: { rows: CategorySpend[]; title: string }): ReactNode {
  const spending = rows.filter((r) => r.cents > 0)
  const refunded = rows.filter((r) => r.cents < 0)
  const shown = spending.slice(0, TOP_CATEGORIES)
  const rest = spending.slice(TOP_CATEGORIES)
  return (
    <Panel id="reports-categories" title="Where the money went">
      {shown.length === 0
        ? <p>No spending is filed under a category in {title} yet.</p>
        : (
          <>
            {/* Names are the owner's and can be long: the bars get a shortened name, this list carries the full one. */}
            <Bars points={shown.map((r) => ({ label: shortLabel(r.label), cents: r.cents }))} title={`Spending by category in ${title}`} />
            <ol>{shown.map((r) => <li key={r.label}>{r.label}: {formatEur(r.cents)}</li>)}</ol>
          </>
        )}
      {rest.length > 0 && <p>{rest.length} smaller {rest.length === 1 ? 'category' : 'categories'} add up to {formatEur(rest.reduce((s, r) => s + r.cents, 0))}.</p>}
      {refunded.length > 0 && <p>{refunded.map((r) => r.label).join(', ')}: money returned to you came to more than was spent, so {refunded.length === 1 ? 'it is' : 'they are'} not drawn as spending.</p>}
    </Panel>
  )
}

function SplitPanel({ current, title }: { current: MonthPoint; title: string }): ReactNode {
  const classified = current.essentialCents + current.discretionaryCents
  const split = [
    { label: 'Essentials', cents: current.essentialCents },
    { label: 'Discretionary', cents: current.discretionaryCents },
    ...(current.uncategorisedCents > 0 ? [{ label: 'Not categorised', cents: current.uncategorisedCents }] : []),
  ]
  return (
    <Panel id="reports-split" title="Essential and discretionary">
      {current.spentCents > 0 && <Bars points={split} title={`Essential and discretionary spending in ${title}`} />}
      {current.spentCents <= 0 && <p>No spending is recorded in {title}, so there is nothing to split.</p>}
      {classified > 0 && <p>Of the {formatEur(classified)} filed as essential or discretionary, {formatBp(percentBpOf(current.essentialCents, classified))} is essential.</p>}
      {current.uncategorisedCents > 0 && <p>{formatEur(current.uncategorisedCents)} is not filed as either, so it is shown on its own.</p>}
      {current.uncategorisedCents < 0 && <p>{formatEur(-current.uncategorisedCents)} of money returned to you is not filed under a spending category, so it is not counted as spending.</p>}
    </Panel>
  )
}

function UnusualPanel({ report, title }: { report: UnusualReport; title: string }): ReactNode {
  const rule = `A purchase is only judged against at least ${MIN_SAMPLE} purchases in the same category over the last ${WINDOW} months.`
  const listed = report.found.slice(0, TOP_UNUSUAL)
  return (
    <Panel id="reports-unusual" title="Unusual spending">
      <p>{rule}</p>
      {report.judgedCategories === 0 && <p>No category has that many purchases yet, so nothing in {title} could be judged. It begins once a category has {MIN_SAMPLE} purchases.</p>}
      {report.judgedCategories > 0 && report.found.length === 0 && <p>{report.judgedCategories} {report.judgedCategories === 1 ? 'category has' : 'categories have'} enough purchases to judge, and no purchase in {title} is far above what is usual for its category.</p>}
      {listed.length > 0 && (
        <>
          <Bars points={listed.map((u) => ({ label: formatSpanishDate(u.date), cents: u.cents }))} title={`Purchases in ${title} far above what is usual for their category`} />
          <ul>
            {listed.map((u) => (
              <li key={u.id}>{formatSpanishDate(u.date)}, {u.description || 'no description'}{u.category ? ` (${u.category})` : ''}: {formatEur(u.cents)}, where the usual amount for the category is {formatEur(u.usualCents)}</li>
            ))}
          </ul>
        </>
      )}
      {report.found.length > listed.length && <p>{report.found.length - listed.length} more are not listed.</p>}
    </Panel>
  )
}

function SmallPanel({ small, byMonth, partial, title }: { small: SmallPurchases; byMonth: Array<{ month: string; cents: number }>; partial: boolean; title: string }): ReactNode {
  const ceiling = formatEur(SMALL_CEILING_CENTS)
  return (
    <Panel id="reports-small" title="Small purchases">
      {byMonth.length >= 2
        ? <Line points={byMonth.map((m) => ({ label: formatMonthTitle(m.month), cents: m.cents }))} title={partial ? `Small purchases by month (the latest month is still running)` : 'Small purchases by month'} />
        : <p>A line of small purchases month by month appears once two months in a row have records. You have {byMonth.length} so far.</p>}
      {small.count === 0
        ? <p>There were no purchases under {ceiling} in {title}.</p>
        : <p>In {title} there {small.count === 1 ? 'was 1 purchase' : `were ${small.count} purchases`} under {ceiling}, adding up to {formatEur(small.totalCents)}.{small.medianCents !== null && ` The middle amount was ${formatEur(small.medianCents)}.`}</p>}
    </Panel>
  )
}

function PaydayPanel({ payday, month, today, partial, title }: { payday: AfterPayday | null; month: string; today: string; partial: boolean; title: string }): ReactNode {
  if (payday === null) {
    return <Panel id="reports-payday" title="The days after payday"><p>No income is recorded in {title}, so there is no payday to count from.</p></Panel>
  }
  const lastDay = addDays(nextMonthStart(month), -1)
  const paydate = addDays(lastDay, -(payday.daysObserved - 1))
  // A running month has days that have not happened. Their zeros are not "no spending": they are not yet known.
  const days = partial ? payday.days.slice(0, Math.max(0, daysBetween(paydate, today) + 1)) : payday.days
  const total = days.reduce((s, d) => s + d.spentCents, 0)
  const week = days.filter((d) => d.dayOffset < 7).reduce((s, d) => s + d.spentCents, 0)
  const reach = partial ? `up to ${formatSpanishDate(today)}` : `to the end of ${title}`
  return (
    <Panel id="reports-payday" title="The days after payday">
      <p>Your largest income in {title} arrived on {formatSpanishDate(paydate)}. This covers {days.length} {days.length === 1 ? 'day' : 'days'}, from then {reach}.</p>
      {days.length >= MIN_PAYDAY_DAYS
        ? (
          <>
            <Line points={days.map((d) => ({ label: `Day ${d.dayOffset}`, cents: d.spentCents }))} title={`Spending each day after payday in ${title}`} />
            <p>{formatEur(total)} was spent in these {days.length} days, {formatEur(week)} of it in the first 7.</p>
          </>
        )
        : <p>That is too few days to show how spending is spread: at least {MIN_PAYDAY_DAYS} are needed. {partial ? `It needs ${MIN_PAYDAY_DAYS - days.length} more ${MIN_PAYDAY_DAYS - days.length === 1 ? 'day' : 'days'} of this month.` : 'The month ended before that many days had passed since the payday.'}</p>}
    </Panel>
  )
}

function AnnotatedPanel({ id, heading, noun, none, rows, title, hint }: { id: string; heading: string; noun: string; none: string; rows: AnnotatedRow[]; title: string; hint: ReactNode }): ReactNode {
  const first = rows[0]
  // The denominator is shown only where it is known. A null base means the spends nobody annotated were never counted.
  const coverage = first && first.spendsInScope !== null ? `${noun} on ${first.answeredOf} of ${first.spendsInScope} purchases in ${title}.` : first ? `${noun} on ${first.answeredOf} purchases in ${title}.` : null
  return (
    <Panel id={id} title={heading}>
      {rows.length === 0
        ? <p>No purchase in {title} has {none} yet. {hint}</p>
        : (
          <>
            <Bars points={rows.map((r) => ({ label: shortLabel(r.label), cents: r.totalCents }))} title={`${heading} in ${title}`} />
            <ul>{rows.map((r) => <li key={r.key}>{r.label}: {r.transactions} {r.transactions === 1 ? 'purchase' : 'purchases'}, {formatEur(r.totalCents)}</li>)}</ul>
            <p>{coverage}</p>
          </>
        )}
    </Panel>
  )
}

/**
 * `today` (an ISO day) and `computedAt` (epoch ms) come from the route, the one place the clock is read. `month` defaults to the
 * month `today` falls in; the running app never passes it. A month is still running exactly when it is today's.
 */
export default function Reports({ today, computedAt, month: shown }: { today: string; computedAt: number; month?: string }): ReactNode {
  const [data, setData] = useState<Loaded | null>(null)
  const [error, setError] = useState<string | null>(null)
  const latest = useRef(0)
  const month = shown ?? today.slice(0, 7)
  const partial = month === today.slice(0, 7)

  useEffect(() => {
    const mine = ++latest.current
    setData(null); setError(null)
    const { from, to } = windowOf(month)
    void (async () => {
      const points = await monthSeries(from, to, today, computedAt)
      const current = points[points.length - 1]
      if (!current || !current.hasData) return { points, detail: null }
      const run = unbrokenRun(points)
      const [categories, unusual, small, payday, mood, reason, worth, smallRun] = await Promise.all([
        categorySpend(month, today, computedAt), unusualPurchases(month, computedAt), smallPurchases(month, SMALL_CEILING_CENTS, computedAt),
        afterPayday(month, computedAt), moodBreakdown(month, computedAt), reasonBreakdown(month, computedAt), worthwhileBreakdown(month, computedAt),
        Promise.all(run.map((p) => smallPurchases(p.month, SMALL_CEILING_CENTS, computedAt))),
      ])
      const smallByMonth = run.map((p, i) => ({ month: p.month, cents: (smallRun[i] as SmallPurchases).totalCents }))
      return { points, detail: { categories, unusual, small, smallByMonth, payday, mood, reason, worth } }
    })().then(
      (d: Loaded) => {
        if (mine !== latest.current) return
        setData(d)
      },
      (e: unknown) => {
        if (mine === latest.current) setError(`Your reports could not be read${e instanceof Error && e.message ? ` (${e.message})` : ''}. Nothing was changed.`)
      },
    )
  }, [month, today, computedAt])

  const heading = <h1>Reports</h1>
  if (error) return <section className="reports">{heading}<div role="alert" className="notice notice-refusal"><p>{error}</p></div></section>
  if (!data) return <section className="reports">{heading}<p role="status">Loading your reports…</p></section>

  const { points, detail } = data
  const current = points[points.length - 1]
  const title = formatMonthTitle(month)

  if (!current || !points.some((p) => p.hasData)) {
    return (
      <section className="reports">
        {heading}
        <p>
          There is nothing to report yet: no bank movements are recorded for the last {WINDOW} months. To begin,{' '}
          <a href="#/import">import your ING statements</a>, and your reports will appear here.
        </p>
      </section>
    )
  }
  if (!current.hasData) {
    const latestWithData = [...points].reverse().find((p) => p.hasData)
    return (
      <section className="reports">
        {heading}
        <p>
          No bank movements are recorded for {title} yet.
          {latestWithData ? ` Your latest records are from ${formatMonthTitle(latestWithData.month)}.` : ''} Import your newer ING
          statements to see this month.
        </p>
        <p><a href="#/import">Import statements</a></p>
      </section>
    )
  }

  if (!detail) return null
  return (
    <section className="reports">
      {heading}
      <p>{partial ? `Figures for ${title} up to ${formatSpanishDate(today)}.` : `Figures for the whole of ${title}.`}</p>
      <SeriesPanel points={points} partial={partial} today={today} />
      <CategoryPanel rows={detail.categories} title={title} />
      <SplitPanel current={current} title={title} />
      <UnusualPanel report={detail.unusual} title={title} />
      <SmallPanel small={detail.small} byMonth={detail.smallByMonth} partial={partial} title={title} />
      <PaydayPanel payday={detail.payday} month={month} today={today} partial={partial} title={title} />
      <AnnotatedPanel id="reports-mood" heading="Purchases by mood" noun="Mood recorded" none="a mood recorded" rows={detail.mood} title={title} hint={<><a href="#/mood">Record a mood</a> on a purchase to see this.</>} />
      <AnnotatedPanel id="reports-reason" heading="Purchases by reason you gave" noun="Reason recorded" none="a reason recorded" rows={detail.reason} title={title} hint={<>Open a purchase in <a href="#/transactions">Transactions</a> and choose a reason to see this.</>} />
      <AnnotatedPanel id="reports-worth" heading="Looking back: worth it or not" noun="Looked back at" none="a judgement of whether it was worth it" rows={detail.worth} title={title} hint={<><a href="#/worth-it">Answer for a purchase</a> whether it was worth it to see this.</>} />
    </section>
  )
}
