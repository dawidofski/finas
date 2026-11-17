import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { db } from '../../db/db'
import { writeAnnotation, type ResolvedTransaction } from '../../db/annotations'
import { dayMood, moodPromptingEnabled, moodQueue } from '../../analysis/queues'
import { formatSpanishDate } from '../../lib/dates'
import { formatEur } from '../../lib/money'
import MoodRow from '../annotations/MoodRow'

interface Answered { tx: ResolvedTransaction; moodId: string | null }

/** Always mounted, in the same slot in every state (loading, failed, ready), so the first card is announced too. */
const Live = ({ text }: { text: string }) => <div aria-live="polite" className="sr-only">{text}</div>

type Load = { state: 'loading' } | { state: 'failed' } | { state: 'ready'; enabled: boolean; queue: ResolvedTransaction[] }

/**
 * The mood triage queue (§15): one transaction at a time, oldest first, one tap to answer. Only the transactions that
 * warrant a question are here (the rule is in analysis/queues). Skipping writes nothing, so a skipped transaction is
 * unanswered, not "skipped", and is offered again next visit. No gesture library: buttons and the keyboard.
 */
export default function Mood(): ReactNode {
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dayOpen, setDayOpen] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  // Answered this visit, oldest first, so Back can return to one and change or clear its mood. `cursor` is the index
  // being revisited, or null when working forward through the queue.
  const [done, setDone] = useState<Answered[]>([])
  const [cursor, setCursor] = useState<number | null>(null)
  // Focus: an answer disables the focused button (busy) and may unmount the card, which would drop focus to the body.
  // After an answer lands, focus the first judgement button of whatever is now shown, or the empty state.
  const cardRef = useRef<HTMLElement>(null)
  const emptyRef = useRef<HTMLDivElement>(null)
  const refocus = useRef(false)

  const reload = useCallback(async () => {
    try {
      const enabled = await moodPromptingEnabled()
      setLoad({ state: 'ready', enabled, queue: await moodQueue() })
    } catch { setLoad({ state: 'failed' }) }
  }, [])
  useEffect(() => { void reload() }, [reload])
  useEffect(() => {
    if (!refocus.current || busy) return
    refocus.current = false
    const target = cardRef.current?.querySelector<HTMLElement>('.mood-row button:not(:disabled), .worth-row button:not(:disabled)')
    // MoodRow loads its moods after a remount, so its buttons may not exist yet: the card itself is the next best place.
    ;(target ?? cardRef.current ?? emptyRef.current)?.focus()
  }, [busy, done, cursor, load, skipped])

  const run = async (work: () => Promise<void>) => {
    setBusy(true); setError(null); setNotice(null)
    try { await work() } catch {
      setError('That could not be saved, so nothing was changed. You can try again.')
      await reload() // show what is actually stored, not what the screen last believed
    }
    finally { setBusy(false) }
  }

  if (load.state === 'loading') return <section><h1>Mood</h1><Live text="" /><p role="status">Loading…</p></section>
  if (load.state === 'failed') return <section><h1>Mood</h1><Live text="" /><p role="alert">Your transactions could not be read just now. Nothing has been changed.</p></section>

  const setPrompting = (enabled: boolean) => run(async () => {
    await db.settings.update('singleton', { moodPrompting: { enabled } })
    await reload()
  })

  if (!load.enabled) {
    return (
      <section>
        <h1>Mood</h1>
        <Live text="" />
        <p>Mood prompts are turned off, so nothing will be asked here.</p>
        {error !== null && <p role="alert">{error}</p>}
        <button type="button" className="btn" disabled={busy} onClick={() => void setPrompting(true)}>Turn mood prompts on</button>
      </section>
    )
  }

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

  const answer = (moodId: string | null) => {
    if (current === undefined) return
    // Going forward a tap must choose a mood; a revisited transaction may also be cleared (null).
    if (moodId === null && revisiting === undefined) return
    void run(async () => {
      await writeAnnotation(current.id, { moodId }, 'owner')
      refocus.current = true
      if (revisiting !== undefined && cursor !== null) {
        setDone(done.map((d, i) => (i === cursor ? { ...d, moodId } : d)))
        setCursor(null)
      } else {
        setDone([...done, { tx: current, moodId }])
      }
      setDayOpen(false)
    })
  }
  const goBack = () => { setCursor(cursor === null ? done.length - 1 : cursor - 1); setDayOpen(false); setNotice(null) }
  const skip = () => { if (current !== undefined) { refocus.current = true; setSkipped(new Set([...skipped, current.id])); setDayOpen(false) } }
  const answerDay = (moodId: string | null) => {
    if (current === undefined || moodId === null) return
    void run(async () => {
      const n = await dayMood(current.valueDate, moodId)
      refocus.current = true
      await reload()
      setDayOpen(false)
      setNotice(`Set for ${n} ${n === 1 ? 'transaction' : 'transactions'} from ${formatSpanishDate(current.valueDate)}. Moods you had already chosen were left alone.`)
    })
  }

  return (
    <section className="mood-queue">
      <h1>Mood</h1>
      <Live text={liveText} />
      {notice !== null && <p role="status">{notice}</p>}
      {error !== null && <p role="alert">{error}</p>}
      {current === undefined ? (
        <div ref={emptyRef} tabIndex={-1} className="queue-empty">
          <p role="status">
            {pending.length === 0
              ? 'There is nothing waiting here right now. New transactions that are worth a thought will show up after your next import.'
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
          <MoodRow value={revisiting?.moodId ?? null} onChange={answer} disabled={busy} />
          <div className="mood-actions">
            <button type="button" className="btn" disabled={busy || !canGoBack} onClick={goBack}>Back</button>
            {revisiting !== undefined
              ? <button type="button" className="btn" disabled={busy} onClick={() => setCursor(null)}>Keep it and continue</button>
              : <button type="button" className="btn" disabled={busy} onClick={skip}>Skip for now</button>}
            {revisiting === undefined && (
              <button type="button" className="btn" aria-expanded={dayOpen} disabled={busy} onClick={() => setDayOpen(!dayOpen)}>
                Same feeling for the whole day
              </button>
            )}
          </div>
          {dayOpen && (
            <section aria-label="Whole day" className="mood-day">
              <p>Applies to this and the other transactions from {formatSpanishDate(current.valueDate)} that have no mood yet. Moods you already chose stay as they are.</p>
              <MoodRow value={null} onChange={answerDay} disabled={busy} />
            </section>
          )}
        </article>
      )}
      <p className="mood-footer">
        <button type="button" className="btn" disabled={busy} onClick={() => void setPrompting(false)}>Turn mood prompts off</button>
      </p>
    </section>
  )
}
