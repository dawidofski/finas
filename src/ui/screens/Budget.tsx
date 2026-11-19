import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { db } from '../../db/db'
import type { BudgetAllocationRow, CategoryRow, SavingsGoalRow } from '../../db/schema'
import { AllocationError, allocationsFor, deleteAllocation, saveAllocation } from '../../budget/allocations'
import { monthlyBudget, type BudgetLine, type MonthlyBudget } from '../../budget/month'
import { CategoryPayments } from '../CategoryPayments'
import { addDays, formatMonthTitle, formatSpanishDate, monthKeyOf } from '../../lib/dates'
import { centsToTypedString, divRound, formatBp, formatEur, parseTypedAmount, percentBpOf } from '../../lib/money'
import './budget-goals.css'

const monthTitle = formatMonthTitle
const previousMonth = (m: string) => monthKeyOf(addDays(`${m}-01`, -1))
const nextMonth = (m: string) => monthKeyOf(addDays(`${m}-28`, 4))

const keyOf = (kind: 'category' | 'goal', id: string) => `${kind}:${id}`
const allocationKey = (a: BudgetAllocationRow) =>
  a.categoryId !== null ? keyOf('category', a.categoryId) : keyOf('goal', a.savingsGoalId as string)

interface Loaded {
  budget: MonthlyBudget
  allocations: Map<string, BudgetAllocationRow>
  categories: CategoryRow[]
  goals: SavingsGoalRow[]
}

async function load(month: string, today: string): Promise<Loaded> {
  const [budget, rows, categories, goals] = await Promise.all([
    monthlyBudget(month, today), allocationsFor(month), db.categories.toArray(), db.savingsGoals.toArray(),
  ])
  return {
    budget,
    allocations: new Map(rows.map((a) => [allocationKey(a), a])),
    categories: categories.sort((a, b) => a.name.localeCompare(b.name)),
    goals: goals.filter((g) => !g.archived).sort((a, b) => a.name.localeCompare(b.name)),
  }
}

/** What qualifies a figure derived from income. It is printed next to the figure, not only in the header. */
function basisNote(income: MonthlyBudget['income']): string | null {
  if (!income.provisional) return null
  return income.basis === 'trailing-average' ? 'estimated income' : 'no income recorded yet'
}

function incomeSentence(income: MonthlyBudget['income']): string {
  if (income.basis === 'actual') return `Income this month: ${formatEur(income.cents)}.`
  if (income.basis === 'trailing-average') {
    return `No income is recorded for this month yet, so the figures below use an estimate of ${formatEur(income.cents)}, ` +
      "the average of your last three months. They will change once this month's income is recorded."
  }
  return 'No income recorded yet for this month. Amounts set as a share of income show as ' + formatEur(0) + ' until it is, ' +
    'and amounts you set as a fixed sum still count.'
}

interface EditorTarget { preset: string; existing: BudgetAllocationRow | null }

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])'

interface EditorProps {
  month: string
  target: EditorTarget
  categories: CategoryRow[]
  goals: SavingsGoalRow[]
  busy: boolean
  error: string | null
  onSave: (row: Omit<BudgetAllocationRow, 'id'>) => void
  onRemove: (() => void) | null
  onClose: () => void
}

function AllocationEditor(props: EditorProps): ReactNode {
  const { existing, preset } = props.target
  const [target, setTarget] = useState(preset)
  const [mode, setMode] = useState<'percent' | 'fixed'>(existing?.fixedCents != null ? 'fixed' : 'percent')
  const [value, setValue] = useState(
    existing?.fixedCents != null ? centsToTypedString(existing.fixedCents)
      : existing?.percentBp != null ? centsToTypedString(existing.percentBp) : '',
  )
  // An edit made in this month applies from this month on; an allocation started inside the month keeps its own date.
  const monthStart = `${props.month}-01`
  const [from, setFrom] = useState(existing && existing.effectiveFrom > monthStart ? existing.effectiveFrom : monthStart)
  const [problem, setProblem] = useState<string | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const id = useId()
  const field = (n: string) => `${id}-${n}`
  useEffect(() => { panelRef.current?.querySelector<HTMLElement>('input, select, button')?.focus() }, [])

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape' && !e.defaultPrevented) { e.stopPropagation(); props.onClose(); return }
    if (e.key !== 'Tab') return
    const items = Array.from(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
    const first = items[0]
    const last = items[items.length - 1]
    if (!first || !last) return
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
  }

  function submit() {
    let amount: number
    try { amount = parseTypedAmount(value) } catch {
      setProblem(mode === 'percent' ? 'Type the share of income as a number, for example 12 or 12,5.'
        : 'Type the amount as a number, for example 250 or 1.850,00.')
      return
    }
    setProblem(null)
    const [kind, targetId] = target.split(':')
    // Read with the app's own decimal reader: "12,5" is 1250, which as cents and as basis points is 12,5 (a percent).
    props.onSave({
      categoryId: kind === 'category' ? targetId ?? null : null,
      savingsGoalId: kind === 'goal' ? targetId ?? null : null,
      percentBp: mode === 'percent' ? amount : null,
      fixedCents: mode === 'fixed' ? amount : null,
      effectiveFrom: from,
      note: existing?.note ?? null,
    })
  }

  const parents = props.categories.filter((c) => c.parentId === null)
  const shownError = problem ?? props.error
  return (
    <div className="tx-backdrop">
      <div ref={panelRef} className="tx-editor" role="dialog" aria-modal="true" aria-labelledby={field('title')} onKeyDown={onKeyDown}>
        <h2 id={field('title')}>{existing ? 'Edit allocation' : 'Add an allocation'}</h2>
        {shownError && <div role="alert" className="notice notice-refusal"><p>{shownError}</p></div>}
        <form onSubmit={(e) => { e.preventDefault(); submit() }}>
          <label htmlFor={field('target')}>What it is for</label>
          <select id={field('target')} value={target} disabled={existing !== null} onChange={(e) => setTarget(e.target.value)}>
            <option value="">Choose a category or savings goal</option>
            {parents.map((p) => (
              <optgroup key={p.id} label={p.name}>
                <option value={keyOf('category', p.id)}>{`${p.name}, as a whole group`}</option>
                {props.categories.filter((c) => c.parentId === p.id).map((c) => <option key={c.id} value={keyOf('category', c.id)}>{c.name}</option>)}
              </optgroup>
            ))}
            {props.goals.length > 0 && (
              <optgroup label="Savings goals">
                {props.goals.map((g) => <option key={g.id} value={keyOf('goal', g.id)}>{g.name}</option>)}
              </optgroup>
            )}
          </select>

          <label htmlFor={field('mode')}>Set it as</label>
          <select id={field('mode')} value={mode} onChange={(e) => setMode(e.target.value as 'percent' | 'fixed')}>
            <option value="percent">A share of income</option>
            <option value="fixed">A fixed amount</option>
          </select>

          <label htmlFor={field('value')}>{mode === 'percent' ? 'Share of income, in percent' : 'Amount in euros'}</label>
          <input id={field('value')} type="text" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} />

          <label htmlFor={field('from')}>Applies from</label>
          <input id={field('from')} type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-describedby={field('from-hint')} />
          <small id={field('from-hint')}>Earlier months keep the figure they had.</small>

          <div className="actions">
            <button type="submit" className="btn btn-primary" disabled={props.busy}>{props.busy ? 'Saving…' : 'Save'}</button>
            <button type="button" className="btn" disabled={props.busy} onClick={props.onClose}>Cancel</button>
            {props.onRemove && <button type="button" className="btn" disabled={props.busy} onClick={props.onRemove}>Remove allocation</button>}
          </div>
        </form>
      </div>
    </div>
  )
}

/** " · 12 % of income (estimated income)", or nothing at all when there was no basis for a percentage. Null is never drawn as 0. */
function Share({ bp, note }: { bp: number | null; note: string | null }): ReactNode {
  return bp === null ? null : <> · {formatBp(bp)} of income{note ? ` (${note})` : ''}</>
}

/** Bar value for a line: the whole bar when a plan of zero already has something against it, empty when it has nothing. */
const barMax = (allocated: number): number => (allocated > 0 ? allocated : 1)
const barValue = (spent: number, allocated: number): number => (allocated > 0 ? Math.min(Math.max(spent, 0), allocated) : spent > 0 ? 1 : 0)

function BudgetedRow({ line, budget, onOpen }: { line: BudgetLine; budget: MonthlyBudget; onOpen: (l: BudgetLine, el: HTMLElement) => void }): ReactNode {
  const { income } = budget
  const share = income.cents > 0 ? percentBpOf(line.allocatedCents, income.cents) : null
  const over = line.remainingCents < 0
  const isGoal = line.targetKind === 'goal'
  return (
    <li className="budget-line bg-card" data-budget-line={keyOf(line.targetKind, line.targetId)}>
      <button type="button" className="tx-open bg-name" data-budget-open={keyOf(line.targetKind, line.targetId)} onClick={(e) => onOpen(line, e.currentTarget)}>
        {line.label}
      </button>
      {isGoal
        // A goal line is money set aside (the month's savings attributed to the goal), not money spent.
        ? (
          <p className="budget-fig bg-caption">
            {budget.partial ? 'Set aside so far' : 'Set aside'}: {formatEur(line.spentCents)}
            {line.varianceBp !== null && line.varianceBp !== 0 && ` · ${formatBp(Math.abs(line.varianceBp))} ${line.varianceBp > 0 ? 'above' : 'below'} plan`}
            {' · '}{over ? `${formatEur(-line.remainingCents)} set aside beyond the plan` : `${formatEur(line.remainingCents)} still to set aside`}
          </p>
        )
        : (
          <>
            <p className="budget-fig bg-amounts row-between">
              <span className="bg-spent">{budget.partial ? 'Spent so far' : 'Spent'}: {formatEur(line.spentCents)}</span>
              <span className="muted">of {formatEur(line.allocatedCents)}</span>
            </p>
            <p className="budget-fig bg-caption muted" data-over={over ? 'true' : undefined}>
              {line.varianceBp !== null && `${formatBp(Math.abs(line.varianceBp))} ${line.varianceBp > 0 ? 'over' : 'under'} plan · `}
              {over ? `${formatEur(-line.remainingCents)} over` : `${formatEur(line.remainingCents)} left`}
            </p>
          </>
        )}
      <progress className="meter" max={barMax(line.allocatedCents)} value={barValue(line.spentCents, line.allocatedCents)}
                data-over={!isGoal && over ? 'true' : undefined}
                aria-label={`${line.label}: ${formatEur(line.spentCents)} of ${formatEur(line.allocatedCents)}`} />
      <p className="budget-fig bg-plan muted">
        {line.fixed ? 'Fixed' : 'Planned'}: {formatEur(line.allocatedCents)}
        <Share bp={share} note={basisNote(income)} />
        {share === null && !line.fixed && basisNote(income) ? ` (${basisNote(income)})` : null}
      </p>
    </li>
  )
}

/** Essentials against wants as one bar. Integer coordinates in a 0..1000 box; the widths come from integer division. */
function SplitBar({ essential, discretionary }: { essential: number; discretionary: number }): ReactNode {
  const total = essential + discretionary
  const essentialWidth = total > 0 ? divRound(essential * 1000, total) : 0
  const label = `Essentials ${formatEur(essential)}, discretionary ${formatEur(discretionary)}`
  return (
    <div className="bg-split">
      <svg viewBox="0 0 1000 40" className="bg-split-svg" role="img" aria-label={label} preserveAspectRatio="none">
        <rect x="0" y="0" width="1000" height="40" className="bg-split-track" />
        {total > 0 && <rect x="0" y="0" width={essentialWidth} height="40" className="bg-split-essential" />}
        {total > 0 && <rect x={essentialWidth} y="0" width={1000 - essentialWidth} height="40" className="bg-split-want" />}
      </svg>
      <ul className="bg-legend">
        <li><span className="bg-swatch bg-swatch-essential" />Essentials <strong>{formatEur(essential)}</strong></li>
        <li><span className="bg-swatch bg-swatch-want" />Discretionary <strong>{formatEur(discretionary)}</strong></li>
      </ul>
    </div>
  )
}
/** `today` is injected so the tests own time. `initialMonth` defaults to the month `today` falls in. */
export default function Budget({ today, initialMonth }: { today: string; initialMonth?: string }): ReactNode {
  const [month, chooseMonth] = useState(initialMonth ?? today.slice(0, 7))
  const [data, setData] = useState<Loaded | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [editing, setEditing] = useState<EditorTarget | null>(null)
  const [busy, setBusy] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const opener = useRef<HTMLElement | null>(null)
  const openerKey = useRef<string | null>(null)
  const latest = useRef(0)

  /** `afterWrite`: a change has just been written, so a failure to read it back must not claim nothing was changed. */
  const reload = useCallback(async (afterWrite = false) => {
    const mine = ++latest.current
    try {
      const next = await load(month, today)
      if (mine === latest.current) { setData(next); setLoadError(null) }
    } catch (e) {
      if (mine === latest.current) setLoadError(`${afterWrite ? 'Your change was saved, but the budget' : 'Your budget'} could not be read${e instanceof Error && e.message ? ` (${e.message})` : ''}. ${afterWrite ? 'Reload the page to see it.' : 'Nothing was changed.'}`)
    }
  }, [month, today])
  useEffect(() => { setData(null); void reload() }, [reload])

  const open = (t: EditorTarget, el: HTMLElement | null) => {
    opener.current = el
    openerKey.current = el?.dataset.budgetOpen ?? null
    setSaveError(null); setStatus(null); setEditing(t)
  }
  const close = () => {
    const el = opener.current
    const key = openerKey.current
    setEditing(null); setSaveError(null)
    queueMicrotask(() => {
      // The opener may have been re-rendered by the reload; find it again by its key, else fall back to the heading.
      const again = key ? document.querySelector<HTMLElement>(`[data-budget-open="${key}"]`) : null
      const target = el && el.isConnected ? el : again
      ;(target ?? headingRef.current)?.focus()
    })
  }

  async function save(row: Omit<BudgetAllocationRow, 'id'>) {
    setBusy(true); setSaveError(null)
    try {
      await saveAllocation(row)
      await reload(true)
      setStatus('Saved.')
      close()
    } catch (e) {
      // The data layer's refusals are already written for the owner, so they are shown exactly as thrown.
      setSaveError(e instanceof AllocationError ? e.message
        : `The allocation could not be saved${e instanceof Error && e.message ? ` (${e.message})` : ''}. Your records are as they were.`)
    } finally { setBusy(false) }
  }

  async function remove(existing: BudgetAllocationRow) {
    setBusy(true); setSaveError(null)
    let removed = false
    try {
      await deleteAllocation(existing.id)
      removed = true
      const key = allocationKey(existing)
      const earlier = (await allocationsFor(month)).find((a) => allocationKey(a) === key)
      await reload(true)
      // Deleting one row can bring back the figure it replaced; say so rather than leave the line apparently undeleted.
      setStatus(earlier ? `Removed the allocation that applied from ${formatSpanishDate(existing.effectiveFrom)}. The earlier one from ${formatSpanishDate(earlier.effectiveFrom)} applies again.` : 'Removed.')
      close()
    } catch (e) {
      setSaveError(removed
        ? 'The allocation was removed, but the screen could not refresh itself. Reload the page to see it.'
        : `The allocation could not be removed${e instanceof Error && e.message ? ` (${e.message})` : ''}. Your records are as they were.`)
    } finally { setBusy(false) }
  }

  const heading = <h1 ref={headingRef} tabIndex={-1}>Budget</h1>
  if (loadError) return <section className="budget bg-screen">{heading}<div role="alert" className="notice notice-refusal"><p>{loadError}</p></div></section>

  const nav = (
    <div className="budget-nav bg-nav">
      <button type="button" className="btn bg-step" aria-label="Previous month" onClick={() => { setStatus(null); chooseMonth(previousMonth(month)) }}><span aria-hidden="true">‹</span></button>
      <h2 aria-live="polite">{monthTitle(month)}</h2>
      <button type="button" className="btn bg-step" aria-label="Next month" onClick={() => { setStatus(null); chooseMonth(nextMonth(month)) }}><span aria-hidden="true">›</span></button>
    </div>
  )
  if (!data) return <section className="budget bg-screen">{heading}{nav}<p role="status">Loading your budget…</p></section>

  const { budget } = data
  const { income, totals } = budget
  const note = basisNote(income)
  const budgeted = budget.lines.filter((l) => !l.unbudgeted)
  const outside = budget.lines.filter((l) => l.unbudgeted)
  const allocatedTotal = income.cents - budget.unallocatedCents
  const ofIncome = (cents: number) => (income.cents > 0 ? percentBpOf(cents, income.cents) : null)

  const openLine = (l: BudgetLine, el: HTMLElement) =>
    open({ preset: keyOf(l.targetKind, l.targetId), existing: data.allocations.get(keyOf(l.targetKind, l.targetId)) ?? null }, el)
  const editingRow = editing?.existing ?? null

  return (
    <section className="budget bg-screen">
      {heading}
      {nav}
      {status && <div role="status" className="notice"><p>{status}</p></div>}

      <details className="tip">
        <summary>Where the income figure comes from</summary>
        <p>{incomeSentence(income)}</p>
      </details>
      {budget.partial && (
        <details className="tip">
          <summary>About spending so far</summary>
          <p>This month is still running. Spending shows what you have spent so far, up to {formatSpanishDate(today)}, against the full month&apos;s plan.</p>
        </details>
      )}
      {budget.unallocatedCents < 0 && (
        <div role="note" className="notice">
          <p>
            Your planned amounts total {formatEur(allocatedTotal)}, which is {formatEur(-budget.unallocatedCents)} more than
            {income.basis === 'trailing-average' ? ' your estimated income of ' : income.basis === 'none' ? ' the income recorded so far, ' : ' your income of '}{formatEur(income.cents)}
            {budget.overcommittedBp !== null ? ` (${formatBp(budget.overcommittedBp)} over)` : ' (there is no income to measure a percentage against)'}. That is allowed. It is shown so you can see it, and nothing is changed.
          </p>
        </div>
      )}

      <div className="actions">
        <button type="button" className="btn btn-primary" data-budget-open="add" onClick={(e) => open({ preset: '', existing: null }, e.currentTarget)}>Add an allocation</button>
      </div>

      {budget.lines.length === 0 ? (
        <p>
          Nothing to show for {monthTitle(month)} yet. To begin, import your ING statements so your income and spending appear here,
          then use Add an allocation to give a category or savings goal a share of your income or a fixed amount.
        </p>
      ) : (
        <>
          <div className="stat-grid">
            <div className="stat"><span className="stat-label">Income</span><span className="stat-value">{formatEur(income.cents)}</span>{note && <span className="stat-note">{note}</span>}</div>
            <div className="stat"><span className="stat-label">Spent</span><span className="stat-value">{formatEur(totals.spentCents)}</span>{ofIncome(totals.spentCents) !== null && <span className="stat-note">{formatBp(ofIncome(totals.spentCents) ?? 0)} of income</span>}</div>
            <div className="stat"><span className="stat-label">Left over</span><span className="stat-value">{income.basis === 'none' ? 'Not known yet' : formatEur(income.cents - totals.spentCents - totals.savingsCents)}</span><span className="stat-note">income less spending and saving</span></div>
            <div className="stat"><span className="stat-label">Saved</span><span className="stat-value">{formatEur(totals.savingsCents)}</span>{totals.savingsRateBp !== null && <span className="stat-note">{formatBp(totals.savingsRateBp)} of income</span>}</div>
          </div>
          <h2>Your plan</h2>
          {budgeted.length === 0
            ? <p>No amounts are planned for this month yet. Use Add an allocation to plan one.</p>
            : <ul className="budget-lines bg-lines">{budgeted.map((l) => <BudgetedRow key={keyOf(l.targetKind, l.targetId)} line={l} budget={budget} onOpen={openLine} />)}</ul>}

          {income.basis !== 'none' && budget.unallocatedCents > 0 && (
            <p className="muted">
              Not yet allocated: {formatEur(budget.unallocatedCents)}
              <Share bp={ofIncome(budget.unallocatedCents)} note={note} />
            </p>
          )}

          {outside.length > 0 && (
            <>
              <h2>Spending outside your budget</h2>
              <details className="tip">
                <summary>What is counted here</summary>
                <p>These had spending {budget.partial ? 'so far this month' : 'this month'} but no planned amount. Together with your plan above, they account for everything spent.</p>
              </details>
              <ul className="budget-lines bg-lines">
                {outside.map((l) => (
                  <li key={`out:${l.targetId}`} className="budget-line bg-card" data-budget-outside={l.targetId}>
                    <span className="budget-label">{l.label}</span>
                    <p className="budget-fig">{budget.partial ? 'Spent so far' : 'Spent'}: {formatEur(l.spentCents)}</p>
                    {l.targetId !== '' && data.categories.some((c) => c.id === l.targetId) && (
                      <button type="button" className="btn" data-budget-open={`out:${l.targetId}`}
                              aria-label={`Plan an amount for ${l.label}`}
                              onClick={(e) => open({ preset: keyOf('category', l.targetId), existing: null }, e.currentTarget)}>
                        Plan an amount
                      </button>
                    )}
                    <CategoryPayments categoryId={l.targetId} label={l.label} month={month} categories={data.categories} onChanged={() => { void reload(true) }} />
                  </li>
                ))}
              </ul>
            </>
          )}

          <h2>{budget.partial ? 'So far this month' : 'This month'}</h2>
          <SplitBar essential={totals.essentialCents} discretionary={totals.discretionaryCents} />
          <details className="tip">
            <summary>The month in words</summary>
          <ul className="budget-totals">
            <li>Total spent: {formatEur(totals.spentCents)}<Share bp={ofIncome(totals.spentCents)} note={note} /></li>
            <li>Essentials: {formatEur(totals.essentialCents)}<Share bp={ofIncome(totals.essentialCents)} note={note} /></li>
            <li>Discretionary: {formatEur(totals.discretionaryCents)}<Share bp={ofIncome(totals.discretionaryCents)} note={note} /></li>
            {/* savingsRateBp is null when the income basis is zero; Share then draws nothing. */}
            <li>Saved: {formatEur(totals.savingsCents)}<Share bp={totals.savingsRateBp} note={note} /></li>
          </ul>
          </details>
        </>
      )}

      {editing && (
        <AllocationEditor
          key={editing.preset + (editingRow?.id ?? 'new')}
          month={month} target={editing} categories={data.categories} goals={data.goals}
          busy={busy} error={saveError}
          onSave={(row) => { void save(row) }}
          onRemove={editingRow ? () => { void remove(editingRow) } : null}
          onClose={close}
        />
      )}
    </section>
  )
}
