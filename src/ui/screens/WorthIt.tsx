import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { writeAnnotation, type ResolvedTransaction } from '../../db/annotations'
import { setWorthwhileDelayDays, worthwhileDelayDays, worthwhileQueue } from '../../analysis/queues'
import { formatSpanishDate } from '../../lib/dates'
import { formatEur } from '../../lib/money'
import WorthwhileButtons from '../annotations/WorthwhileButtons'

interface Answered { tx: ResolvedTransaction; worthwhile: boolean | null }

/** Always mounted, in the same slot in every state (loading, failed, ready), so the first card is announced too. */
const Live = ({ text }: { text: string }) => <div aria-live="polite" className="sr-only">{text}</div>

type Load = { state: 'loading' } | { state: 'failed' } | { state: 'ready'; days: number; queue: ResolvedTransaction[] }

/**
 * The "Worth it?" hindsight queue (§21.4): spending the owner already engaged with (a mood or a reason), at least a
 * few days old, with no judgement yet. One at a time, oldest first. Skipping writes nothing, so a skipped transaction
 * stays unanswered and is offered again. `today` is injected by the route.
 */
/**
 * `embedded` is the form the Dashboard shows: a card under the month's figures, with a second-level heading, that takes no
 * room at all while nothing is waiting (or while it loads, or cannot be read). The full screen keeps its own route.
 */
export default function WorthIt({ today, embedded = false }: { today: string; embedded?: boolean }): ReactNode {
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<Answered[]>([])
  const [cursor, setCursor] = useState<number | null>(null)
  // Focus: an answer disables the focused button (busy) and may unmount the card, which would drop focus to the body.
  // After an answer lands, focus the first judgement button of whatever is now shown, or the empty state.
  const cardRef = useRef<HTMLElement>(null)
  const emptyRef = useRef<HTMLDivElement>(null)
  const refocus = useRef(false)
  const [daysText, setDaysText] = useState('')

  const reload = useCallback(async () => {
    try {
      const days = await worthwhileDelayDays()
      setLoad({ state: 'ready', days, queue: await worthwhileQueue({ olderThanDays: days, today }) })
      setDaysText(String(days))
    } catch { setLoad({ state: 'failed' }) }
  }, [today])
  useEffect(() => { void reload() }, [reload])
  useEffect(() => {
    if (!refocus.current || busy) return
    refocus.current = false
    const target = cardRef.current?.querySelector<HTMLElement>('.mood-row button:not(:disabled), .worth-row button:not(:disabled)')
    // MoodRow loads its moods after a remount, so its buttons may not exist yet: the card itself is the next best place.
    ;(target ?? cardRef.current ?? emptyRef.current)?.focus()
  }, [busy, done, cursor, load, skipped])

  const run = async (work: () => Promise<void>) => {
    setBusy(true); setError(null)
    try { await work() } catch {
      setError('That could not be saved, so nothing was changed. You can try again.')
      await reload()
    } finally { setBusy(false) }
  }

  if (embedded && load.state !== 'ready') return null
  if (load.state === 'loading') return <section><h1>Worth it?</h1><Live text="" /><p role="status">Loading…</p></section>
  if (load.state === 'failed') return <section><h1>Worth it?</h1><Live text="" /><p role="alert">Your transactions could not be read just now. Nothing has been changed.</p></section>

  const answeredIds = new Set(done.map((d) => d.tx.id))
  const pending = load.queue.filter((t) => !answeredIds.has(t.id))
  const waiting = pending.filter((t) => !skipped.has(t.id))
  const revisiting = cursor !== null ? done[cursor] : undefined
  const current = revisiting?.tx ?? waiting[0]
  const canGoBack = done.length > 0 && cursor !== 0
  // The position makes every announcement unique (two identical transactions in a row would otherwise read the same,
  // and an unchanged string is not re-announced) and says how much is left.
  const position = revisiting !== undefined && cursor !== null ? cursor + 1 : done.length + 1 + (current !== undefined ? pending.indexOf(current) : 0)
  const liveText = current !== undefined
    ? `${position} of ${done.length + pending.length}: ${current.description}, ${formatSpanishDate(current.valueDate)}, ${formatEur(current.amountCents)}`
    : ''

  const answer = (worthwhile: boolean | null) => {
    if (current === undefined) return
    // Going forward a tap must choose; a revisited transaction may also be cleared (null).
    if (worthwhile === null && revisiting === undefined) return
    void run(async () => {
      await writeAnnotation(current.id, { worthwhile }, 'owner')
      refocus.current = true
      if (revisiting !== undefined && cursor !== null) {
        setDone(done.map((d, i) => (i === cursor ? { ...d, worthwhile } : d)))
        setCursor(null)
      } else {
        setDone([...done, { tx: current, worthwhile }])
      }
    })
  }
  const goBack = () => setCursor(cursor === null ? done.length - 1 : cursor - 1)
  const skip = () => { if (current !== undefined) { refocus.current = true; setSkipped(new Set([...skipped, current.id])) } }

  const saveDays = () => {
    const n = Number(daysText)
    if (daysText.trim() === '' || !Number.isInteger(n) || n < 0) { setError('Enter a whole number of days, 0 or more.'); return }
    void run(async () => {
      await setWorthwhileDelayDays(n)
      setDone([]); setCursor(null); setSkipped(new Set())
      await reload()
    })
  }

  if (embedded && current === undefined && pending.length === 0) return null
  return (
    <section className={embedded ? 'mood-queue card' : 'mood-queue'}>
      {embedded ? <h2>Worth it?</h2> : <h1>Worth it?</h1>}
      <Live text={liveText} />
      <p>A look back at spending from at least {load.days} {load.days === 1 ? 'day' : 'days'} ago that you had already noted a feeling or reason for.</p>
      {error !== null && <p role="alert">{error}</p>}
      {current === undefined ? (
        <div ref={emptyRef} tabIndex={-1} className="queue-empty">
          <p role="status">
            {pending.length === 0
              ? 'There is nothing waiting here right now. Spending shows up once it is old enough and you have noted a mood or a reason for it.'
              : `You have set aside ${pending.length} for later. They will be here next time.`}
          </p>
          {pending.length > 0 && (
            <button type="button" className="btn" onClick={() => { refocus.current = true; setSkipped(new Set()) }}>Look at them again</button>
          )}
          <button type="button" className="btn" disabled={busy || !canGoBack} onClick={goBack}>Back</button>
        </div>
      ) : (
        <article ref={cardRef} tabIndex={-1} aria-label="Transaction to review" className="mood-card">
          <p className="mood-count">{revisiting !== undefined ? 'Going back to an earlier one' : `${waiting.length} waiting`}</p>
          <p className="mood-desc">{current.description}</p>
          <p className="mood-meta"><time dateTime={current.valueDate}>{formatSpanishDate(current.valueDate)}</time> · {formatEur(current.amountCents)}</p>
          <WorthwhileButtons value={revisiting?.worthwhile ?? null} onChange={answer} disabled={busy} allowClear={revisiting !== undefined} />
          <div className="mood-actions">
            <button type="button" className="btn" disabled={busy || !canGoBack} onClick={goBack}>Back</button>
            {revisiting !== undefined
              ? <button type="button" className="btn" disabled={busy} onClick={() => setCursor(null)}>Keep it and continue</button>
              : <button type="button" className="btn" disabled={busy} onClick={skip}>Skip for now</button>}
          </div>
        </article>
      )}
      {!embedded && <div className="worth-delay">
        <label htmlFor="worth-delay-days">Ask about spending at least this many days old</label>
        <input id="worth-delay-days" inputMode="numeric" value={daysText} onChange={(e) => setDaysText(e.target.value)} disabled={busy} />
        <button type="button" className="btn" disabled={busy} onClick={saveDays}>Save</button>
      </div>}
    </section>
  )
}
