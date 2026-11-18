import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { db } from '../../db/db'
import type { SavingsGoalRow } from '../../db/schema'
import { goalContributions } from '../../goals/contributions'
import { progressOf, type GoalProgress } from '../../goals/progress'
import { archiveGoal, completeGoal, createGoal, updateGoal } from '../../goals/store'
import { GOAL_MONTHS, goalWindow } from '../../goals/window'
import { addMonths, formatMonthTitle, formatSpanishDate } from '../../lib/dates'
import { centsToTypedString, formatBp, formatEur, parseTypedAmount } from '../../lib/money'
import { allocationsFor } from '../../budget/allocations'

interface Figures { goal: SavingsGoalRow; progress: GoalProgress }
interface Loaded { figures: Figures[]; capped: boolean; shares: Map<string, string> }

async function load(today: string, computedAt: number): Promise<Loaded> {
  const goals = (await db.savingsGoals.toArray()).sort((a, b) => (a.createdAt - b.createdAt) || (a.id < b.id ? -1 : 1))
  if (goals.length === 0) return { figures: [], capped: false, shares: new Map() }
  const last = addMonths(today.slice(0, 7), -1)
  const { from, capped } = goalWindow(goals, last)
  const months = from > last ? [] : await goalContributions(from, last, today, computedAt)
  // The share the arithmetic uses is the allocation in force this month, which a Budget-screen edit can change; the goal row's
  // own percentage is only what the goal was created or last edited here with.
  const shares = new Map<string, string>()
  for (const a of await allocationsFor(today.slice(0, 7))) {
    if (a.savingsGoalId === null) continue
    shares.set(a.savingsGoalId, a.fixedCents !== null ? `a fixed ${formatEur(a.fixedCents)} a month` : formatBp(a.percentBp ?? 0))
  }
  return { figures: goals.map((goal) => ({ goal, progress: progressOf(goal, months, last) })), capped, shares }
}

const monthName = (m: string): string => formatMonthTitle(m).replace(/ \d{4}$/, '')

/** The estimate as words: always a range, never one date offered as a prediction. */
export function estimateWords(p: GoalProgress): { sentence: string; note: string | null } {
  if (p.estimate === null) return { sentence: p.estimateWhy ?? 'There is no estimate yet.', note: null }
  const { earliestMonth: a, latestMonth: b } = p.estimate
  if (b === null) {
    return { sentence: `Going by your record so far, it could be reached from ${formatMonthTitle(a)} on.`, note: p.estimateNote }
  }
  if (a === b) return { sentence: `Going by your record so far, your faster and slower months both point to ${formatMonthTitle(a)}.`, note: p.estimateNote }
  const sameYear = a.slice(0, 4) === b.slice(0, 4)
  return {
    sentence: `Going by your record so far, between ${sameYear ? monthName(a) : formatMonthTitle(a)} and ${formatMonthTitle(b)}.`,
    note: p.estimateNote,
  }
}

interface FormValues { name: string; target: string; deadline: string; percent: string }

/** Reads the form into the store's input, or says in plain words what to change. */
function readForm(v: FormValues): { ok: true; input: { name: string; targetCents: number; deadline: string | null; contributionPercentBp: number } } | { ok: false; problem: string } {
  if (v.name.trim() === '') return { ok: false, problem: 'Give the goal a name.' }
  let targetCents: number
  try { targetCents = parseTypedAmount(v.target) } catch { return { ok: false, problem: 'Type the target as an amount in euros, for example 1500 or 1.500,00.' } }
  if (targetCents <= 0) return { ok: false, problem: 'The target must be an amount of money above zero.' }
  let contributionPercentBp: number
  try { contributionPercentBp = parseTypedAmount(v.percent) } catch { return { ok: false, problem: 'Type the share of income as a number, for example 10 or 12,5.' } }
  if (contributionPercentBp < 0 || contributionPercentBp > 10000) return { ok: false, problem: 'The share of income must be between 0 % and 100 %.' }
  return { ok: true, input: { name: v.name.trim(), targetCents, deadline: v.deadline === '' ? null : v.deadline, contributionPercentBp } }
}

function GoalForm({ initial, submitLabel, busy, error, onSubmit, onCancel, nameRef }: {
  initial: FormValues; submitLabel: string; busy: boolean; error: string | null
  onSubmit: (v: FormValues) => void; onCancel: (() => void) | null; nameRef?: (el: HTMLInputElement | null) => void
}): ReactNode {
  const [v, setV] = useState(initial)
  const [problem, setProblem] = useState<string | null>(null)
  const set = (k: keyof FormValues) => (e: { target: { value: string } }) => setV((cur) => ({ ...cur, [k]: e.target.value }))
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const read = readForm(v)
    if (!read.ok) { setProblem(read.problem); return }
    setProblem(null)
    onSubmit(v)
  }
  const shown = problem ?? error
  return (
    <form onSubmit={submit} aria-label={submitLabel === 'Add goal' ? 'Add a savings goal' : 'Edit savings goal'}>
      {shown && <div role="alert" className="notice notice-refusal"><p>{shown}</p></div>}
      <label>Name of the goal<input type="text" value={v.name} onChange={set('name')} ref={nameRef} /></label>
      <label>Target amount, in euros<input type="text" inputMode="decimal" value={v.target} onChange={set('target')} /></label>
      <label>Share of income to put toward it, in percent<input type="text" inputMode="decimal" value={v.percent} onChange={set('percent')} /></label>
      <label>Deadline, if you have one (optional)<input type="date" value={v.deadline} onChange={set('deadline')} /></label>
      <div className="actions">
        <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : submitLabel}</button>
        {onCancel && <button type="button" className="btn" disabled={busy} onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  )
}

const EMPTY: FormValues = { name: '', target: '', deadline: '', percent: '' }

function GoalCard({ f, share, onEdit, onArchive, onComplete, headingRef, busy }: {
  f: Figures; share: string; onEdit: () => void; onArchive: () => void; onComplete: () => void
  headingRef: (el: HTMLHeadingElement | null) => void; busy: boolean
}): ReactNode {
  const { goal, progress: p } = f
  const done = goal.completedAt !== null
  const words = estimateWords(p)
  return (
    <article className="goal-item" aria-labelledby={`goal-${goal.id}`}>
      <h3 id={`goal-${goal.id}`} tabIndex={-1} ref={headingRef}><q>{goal.name}</q></h3>
      <dl>
        <dt>Target</dt>
        <dd>{formatEur(goal.targetCents)}</dd>
        <dt>Put toward it so far</dt>
        <dd>{formatEur(p.contributedCents)}</dd>
        <dt>Still to go</dt>
        <dd>{formatEur(p.remainingCents)}</dd>
        <dt>Share of income planned</dt>
        <dd>{share}</dd>
        {goal.deadline !== null && (<><dt>Deadline</dt><dd>{formatSpanishDate(goal.deadline)}</dd></>)}
        <dt>When it might be reached</dt>
        <dd>
          {done ? 'You marked this goal as completed.'
            : p.reached ? 'The money put toward it has reached the target.'
              : words.sentence}
          {!done && !p.reached && words.note !== null && <> {words.note}</>}
        </dd>
      </dl>
      {p.reached && !done && <p>This goal keeps receiving a share of your savings until you mark it as completed.</p>}
      <div className="goal-actions">
        <button type="button" disabled={busy} aria-label={`Edit goal: ${goal.name}`} onClick={onEdit}>Edit</button>
        {p.reached && !done && <button type="button" disabled={busy} aria-label={`Mark as completed: ${goal.name}`} onClick={onComplete}>Mark as completed</button>}
        <button type="button" disabled={busy} aria-label={`Archive goal: ${goal.name}`} onClick={onArchive}>Archive</button>
      </div>
    </article>
  )
}

/** `today` and `computedAt` come from the route, the one place the clock is read; every change is dated by `computedAt`. */
export default function Goals({ today, computedAt }: { today: string; computedAt: number }): ReactNode {
  const [data, setData] = useState<Loaded | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const latest = useRef(0)
  const working = useRef(false)
  const headings = useRef(new Map<string, HTMLHeadingElement>())
  const regionHeading = useRef<HTMLHeadingElement | null>(null)
  const addName = useRef<HTMLInputElement | null>(null)
  const editName = useRef<HTMLInputElement | null>(null)
  /** Where focus goes once the page has changed under the owner's action: a goal's id, 'region', or 'add' / 'edit' for a form. */
  const focusNext = useRef<string | null>(null)

  useEffect(() => {
    const mine = ++latest.current
    setData(null); setError(null); setActionError(null)
    load(today, computedAt).then(
      (d) => { if (mine === latest.current) setData(d) },
      (e: unknown) => {
        if (mine === latest.current) setError(`Your savings goals could not be worked out${e instanceof Error && e.message ? ` (${e.message})` : ''}.`)
      },
    )
  }, [today, computedAt])

  useLayoutEffect(() => {
    const target = focusNext.current
    if (target === null) return
    focusNext.current = null
    if (target === 'region') regionHeading.current?.focus()
    else if (target === 'add') addName.current?.focus()
    else if (target === 'edit') editName.current?.focus()
    else headings.current.get(target)?.focus()
  }, [data, adding, editing])

  /** Runs one change, then reloads. A refusal from the store is shown as the store words it, and nothing else moves. */
  const act = async (run: () => Promise<string | null>, afterFocus: (id: string | null) => string): Promise<boolean> => {
    if (working.current) return false
    working.current = true
    setBusy(true); setActionError(null)
    try {
      const id = await run()
      const next = await load(today, computedAt)
      focusNext.current = afterFocus(id)
      setData(next); setEditing(null); setAdding(false)
      return true
    } catch (e) {
      setActionError(e instanceof Error && e.message ? e.message : 'The change could not be saved. Nothing was changed.')
      return false
    } finally {
      working.current = false
      setBusy(false)
    }
  }

  const heading = <h1>Goals</h1>
  if (error) return <section className="goals">{heading}<div role="alert" className="notice notice-refusal"><p>{error}</p></div></section>
  if (data === null) return <section className="goals">{heading}<p role="status">Loading your savings goals…</p></section>

  const active = data.figures.filter((f) => !f.goal.archived)
  const archived = data.figures.filter((f) => f.goal.archived)
  const toValues = (g: SavingsGoalRow): FormValues => ({
    name: g.name, target: centsToTypedString(g.targetCents), deadline: g.deadline ?? '', percent: centsToTypedString(g.contributionPercentBp),
  })
  const create = (v: FormValues): void => {
    const read = readForm(v)
    if (!read.ok) return
    void act(async () => (await createGoal(read.input, computedAt)).id, (id) => id ?? 'region')
  }
  const showForm = adding || active.length === 0

  return (
    <section className="goals">
      {heading}
      <p>Savings goals: an amount you are putting money toward, with the share of your income you plan to set aside for it.</p>
      <h2>How the contribution is worked out</h2>
      <p>
        Each completed month, the money you moved into savings is shared between your goals in proportion to the share of income you set for each,
        and no goal receives more than its planned amount for that month. Savings beyond what your goals plan belong to no goal.
        A goal counts the savings of the whole month it was created in, including days before you created it.
        The current month is not counted until it is over. The estimate is a range taken from your own months so far, and it moves as new months are added.
        {data.capped && ` Only the last ${GOAL_MONTHS} completed months are read.`}
      </p>
      <h2 tabIndex={-1} ref={regionHeading}>Your goals</h2>
      {actionError && <div role="alert" className="notice notice-refusal"><p>{actionError}</p></div>}
      {active.length === 0 && (
        <p>You have not set a savings goal yet. That is a normal place to start, not something missed. You can add one below whenever you like.</p>
      )}
      {active.length > 0 && (
        <ul aria-label="Savings goals" className="goal-list">
          {active.map((f) => (
            <li key={f.goal.id}>
              {editing === f.goal.id
                ? (
                  <GoalForm
                    initial={toValues(f.goal)} submitLabel="Save changes" busy={busy} error={null} nameRef={(el) => { editName.current = el }}
                    onCancel={() => { focusNext.current = f.goal.id; setEditing(null) }}
                    onSubmit={(v) => {
                      const read = readForm(v)
                      if (!read.ok) return
                      void act(async () => { await updateGoal(f.goal.id, read.input, computedAt); return f.goal.id }, (id) => id ?? 'region')
                    }}
                  />
                )
                : (
                  <GoalCard
                    f={f} share={data.shares.get(f.goal.id) ?? 'None in force this month'} busy={busy}
                    headingRef={(el) => { if (el) headings.current.set(f.goal.id, el); else headings.current.delete(f.goal.id) }}
                    onEdit={() => { focusNext.current = 'edit'; setAdding(false); setEditing(f.goal.id) }}
                    onComplete={() => void act(async () => { await completeGoal(f.goal.id, computedAt); return f.goal.id }, (id) => id ?? 'region')}
                    onArchive={() => {
                      const at = active.findIndex((x) => x.goal.id === f.goal.id)
                      const rest = active.filter((x) => x.goal.id !== f.goal.id)
                      const next = rest[at]?.goal.id ?? rest[at - 1]?.goal.id ?? 'region'
                      void act(async () => { await archiveGoal(f.goal.id, computedAt); return null }, () => next)
                    }}
                  />
                )}
            </li>
          ))}
        </ul>
      )}
      <h2>{active.length === 0 ? 'Add your first goal' : 'Add a goal'}</h2>
      {showForm
        ? (
          <GoalForm
            initial={EMPTY} submitLabel="Add goal" busy={busy} error={null} nameRef={(el) => { addName.current = el }}
            onCancel={active.length > 0 ? () => { focusNext.current = 'region'; setAdding(false) } : null}
            onSubmit={create}
          />
        )
        : <button type="button" disabled={busy} onClick={() => { focusNext.current = 'add'; setAdding(true); setEditing(null) }}>Add a goal</button>}
      <p>
        Archiving or completing a goal applies to this whole month and every month after, so the goal receives nothing from this month on. What it received in earlier months is kept.
        {' '}An archived goal moves to the list below and cannot be changed. A goal whose contributions have reached its target can be marked as completed.
        {' '}Changing the share of income applies to the whole of the current month, and earlier months keep the share they had.
      </p>
      {archived.length > 0 && (
        <>
          <h2>Archived goals</h2>
          <ul aria-label="Archived savings goals" className="goal-list goal-archived">
            {archived.map((f) => (
              <li key={f.goal.id}>
                <q>{f.goal.name}</q>: {formatEur(f.progress.contributedCents)} put toward a target of {formatEur(f.goal.targetCents)}
                {f.goal.completedAt !== null && ', marked as completed'}.
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}
