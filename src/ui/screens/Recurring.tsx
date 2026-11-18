import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { db } from '../../db/db'
import { formatSpanishDate } from '../../lib/dates'
import { formatEur } from '../../lib/money'
import { MIN_OCCURRENCES, type Frequency } from '../../recurring/detect'
import { confirmRecurring, dismissRecurring, markCancelled, recurringPayments, type RecurringView } from '../../recurring/store'

/**
 * How the evidence is put in words. The stored figure (basis points, 0 to 10000) says how well the payments pin the pattern:
 * a steady run of three scores 5000, of four 6000, of six 7143, and a ragged or irregular cluster less. The figure itself is
 * never shown; these two thresholds only choose between three phrases.
 */
export const VERY_REGULAR_BP = 7000
export const REGULAR_BP = 5000

const COUNT_WORD: Record<number, string> = { 3: 'three', 4: 'four', 5: 'five' }

export function regularityIn(scoreBp: number): string {
  if (scoreBp >= VERY_REGULAR_BP) return 'The payments have come at very even intervals, and there have been plenty of them.'
  if (scoreBp >= REGULAR_BP) return 'The payments have come at even intervals, over a few payments.'
  return 'There are few payments, or the gaps between them vary, so this is a tentative reading.'
}

const FREQUENCY: Record<Frequency, string> = {
  weekly: 'Every week',
  monthly: 'Every month',
  quarterly: 'Every three months',
  annual: 'Every year',
  irregular: 'No regular interval',
}

interface Loaded { views: RecurringView[]; names: Map<string, string>; dismissed: number }

async function load(today: string, computedAt: number): Promise<Loaded> {
  const views = await recurringPayments(today, computedAt)
  const ids = [...new Set(views.map((v) => v.merchantId))]
  const merchants = await db.merchants.bulkGet(ids)
  const names = new Map<string, string>()
  ids.forEach((id, i) => names.set(id, merchants[i]?.canonicalName ?? id))
  const dismissed = await db.recurring.filter((r) => r.dismissed === true).count()
  return { views, names, dismissed }
}

/** What the total counts: not cancelled, not stopped, and with a monthly figure of its own (an irregular payment has none). */
function counted(v: RecurringView): v is RecurringView & { monthlyCostCents: number } {
  return !v.cancelled && !v.lapsed && v.monthlyCostCents !== null
}

type Choice = 'confirm' | 'dismiss' | 'cancel'

function Row({ v, name, onChoose, headingRef }: { v: RecurringView; name: string; onChoose: (c: Choice) => void; headingRef: (el: HTMLHeadingElement | null) => void }): ReactNode {
  return (
    <article className="recurring-item" aria-labelledby={`recurring-${v.id}`}>
      <h3 id={`recurring-${v.id}`} tabIndex={-1} ref={headingRef}><q>{name}</q></h3>
      <dl>
        <dt>Amount</dt>
        <dd>{formatEur(v.amountCents)}</dd>
        {v.amountChanged !== null && (
          <>
            <dt>Price change</dt>
            <dd>It was {formatEur(v.amountChanged.fromCents)}, and the last two payments have been {formatEur(v.amountChanged.toCents)}.</dd>
          </>
        )}
        <dt>How often</dt>
        <dd>{FREQUENCY[v.frequency]}</dd>
        <dt>Last payment</dt>
        <dd>{formatSpanishDate(v.lastSeenDate)}</dd>
        {!v.cancelled && !v.lapsed && v.expectedNextDate !== null && (
          <>
            <dt>Expected next payment</dt>
            <dd>{formatSpanishDate(v.expectedNextDate)}</dd>
          </>
        )}
        <dt>Cost per month</dt>
        <dd>
          {v.cancelled
            ? 'Not counted: you marked it as cancelled.'
            : v.lapsed
              ? 'Not counted while it seems to have stopped.'
              : v.monthlyCostCents === null
                ? 'No monthly figure: the payments do not come at a regular interval.'
                : formatEur(v.monthlyCostCents)}
        </dd>
        <dt>How regular it has been</dt>
        <dd>{regularityIn(v.matchScoreBp)} It has been paid {v.occurrences} times in your records.</dd>
      </dl>
      {v.cancelled
        ? <p>You marked this as cancelled. It is kept here so you can see what it was.</p>
        : (
          <>
            {v.lapsed && (
              <p>
                This seems to have stopped: more than a whole interval has passed since the next payment was expected, and none has come.
                If you cancelled it, you can mark it below.
              </p>
            )}
            {v.confirmedByUser && <p>You confirmed that this recurs.</p>}
            <div className="recurring-actions">
              {!v.confirmedByUser && <button type="button" aria-label={`Yes, this recurs: ${name}`} onClick={() => onChoose('confirm')}>Yes, this recurs</button>}
              <button type="button" aria-label={`This is not recurring: ${name}`} onClick={() => onChoose('dismiss')}>This is not recurring</button>
              <button type="button" aria-label={`I cancelled it: ${name}`} onClick={() => onChoose('cancel')}>I cancelled it</button>
            </div>
          </>
        )}
    </article>
  )
}

/** `today` and `computedAt` come from the route, the one place the clock is read. */
export default function Recurring({ today, computedAt }: { today: string; computedAt: number }): ReactNode {
  const [data, setData] = useState<Loaded | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const latest = useRef(0)
  const busy = useRef(false)
  const headings = useRef(new Map<string, HTMLHeadingElement>())
  const regionHeading = useRef<HTMLHeadingElement | null>(null)
  /** Where focus goes once the list has changed under the owner's action: a payment's id, or the region heading. */
  const focusNext = useRef<string | 'region' | null>(null)

  useEffect(() => {
    const mine = ++latest.current
    setData(null); setError(null); setActionError(null)
    load(today, computedAt).then(
      (d) => { if (mine === latest.current) setData(d) },
      (e: unknown) => {
        if (mine === latest.current) setError(`Your recurring payments could not be worked out${e instanceof Error && e.message ? ` (${e.message})` : ''}.`)
      },
    )
  }, [today, computedAt])

  useLayoutEffect(() => {
    const target = focusNext.current
    if (target === null) return
    focusNext.current = null
    ;(target === 'region' ? regionHeading.current : headings.current.get(target))?.focus()
  }, [data])

  const choose = async (id: string, choice: Choice): Promise<void> => {
    if (busy.current || data === null) return
    busy.current = true
    setActionError(null)
    try {
      if (choice === 'confirm') await confirmRecurring(id)
      else if (choice === 'dismiss') await dismissRecurring(id)
      else await markCancelled(id)
      const active = data.views.filter((v) => !v.cancelled)
      const at = active.findIndex((v) => v.id === id)
      const rest = active.filter((v) => v.id !== id)
      // A confirmed or cancelled payment stays on the page, so its own heading keeps focus; a removed one hands it on to the next, else the one before, else the heading.
      focusNext.current = choice === 'dismiss' ? (rest[at]?.id ?? rest[at - 1]?.id ?? 'region') : id
      const next = await load(today, computedAt)
      setData(next)
    } catch (e) {
      setActionError(`Your choice could not be saved${e instanceof Error && e.message ? ` (${e.message})` : ''}. Nothing was changed.`)
    } finally {
      busy.current = false
    }
  }

  const heading = <h1>Recurring</h1>
  if (error) return <section className="recurring">{heading}<div role="alert" className="notice notice-refusal"><p>{error}</p></div></section>
  if (data === null) return <section className="recurring">{heading}<p role="status">Loading your recurring payments…</p></section>

  const { views, names, dismissed } = data
  const open = views.filter((v) => !v.cancelled)
  const cancelled = views.filter((v) => v.cancelled)
  const inTotal = views.filter(counted)
  const total = inTotal.reduce((sum, v) => sum + v.monthlyCostCents, 0)
  const row = (v: RecurringView): ReactNode => (
    <li key={v.id}>
      <Row
        v={v}
        name={names.get(v.merchantId) ?? v.merchantId}
        onChoose={(c) => void choose(v.id, c)}
        headingRef={(el) => { if (el) headings.current.set(v.id, el); else headings.current.delete(v.id) }}
      />
    </li>
  )

  return (
    <section className="recurring">
      {heading}
      <p>
        Payments that come again and again, found from the gaps between payments to the same merchant. You can confirm one, say it is not recurring, or say you cancelled it.
      </p>
      <h2 tabIndex={-1} ref={regionHeading}>Monthly cost</h2>
      {actionError && <div role="alert" className="notice notice-refusal"><p>{actionError}</p></div>}
      {inTotal.length > 0
        ? <p>Together, the payments counted come to {formatEur(total)} a month.</p>
        : <p>There is no monthly total yet: none of the payments below has a monthly figure to count.</p>}
      <p>
        The total counts each payment that comes at a regular interval, has not seemed to stop, and that you have not marked as cancelled. It includes payments you have not yet confirmed.
        It leaves out payments with no regular interval, payments that seem to have stopped, cancelled ones, and any you said are not recurring.
        A weekly, three-monthly or yearly payment is worked out as a cost per month.
      </p>
      {views.length === 0
        ? (
          <>
            <h2>Payments found</h2>
            {dismissed > 0
              ? <p>Nothing is listed now. {dismissed === 1 ? 'You said one payment is not recurring, and it stays out of this list.' : `You said ${dismissed} payments are not recurring, and they stay out of this list.`}</p>
              : (
                <>
                  <p>No recurring payments have been found yet. This is the normal starting point, not a problem with your records.</p>
                  <p>
                    A payment is found when your records show at least {COUNT_WORD[MIN_OCCURRENCES] ?? String(MIN_OCCURRENCES)} payments to the same merchant at a steady interval, such as every week, every month,
                    every three months or every year. Payments that have no merchant cannot be grouped. If you have not yet, <a href="#/import">import your bank statements</a>.
                  </p>
                </>
              )}
          </>
        )
        : (
          <>
            <h2>Payments found</h2>
            {open.length > 0
              ? <ul aria-label="Recurring payments" className="recurring-list">{open.map(row)}</ul>
              : <p>Every payment found is marked as cancelled, below.</p>}
            {cancelled.length > 0 && (
              <>
                <h2>Marked as cancelled</h2>
                <ul aria-label="Cancelled payments" className="recurring-list">{cancelled.map(row)}</ul>
              </>
            )}
          </>
        )}
    </section>
  )
}
