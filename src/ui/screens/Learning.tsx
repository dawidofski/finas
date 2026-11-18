import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { challengesFor, noteFor, type Challenge, type Note } from '../../advice/education'
import { liveEvidence, recommendationsFor, type EvidenceRow, type Recommendation, type RecommendationId } from '../../advice/recommendations'
import { recordAccepted, recordRejected, recordShown, recordSnoozed, SNOOZE_DAYS, SUPPRESS_AFTER_REJECTIONS } from '../../advice/state'
import { db } from '../../db/db'
import { formatMonthTitle, formatSpanishDate } from '../../lib/dates'
import { formatEur } from '../../lib/money'
import { recurringPreview } from '../../recurring/store'

/** What each kind of advice is called, in the app's own words. */
const TITLE: Record<RecommendationId, string> = {
  'overspent-category': 'A line has passed its figure',
  'small-purchases-add-up': 'Small purchases add up',
  'savings-inconsistent': 'Saving comes in some months and not in others',
  'unusual-spend': 'A purchase above your usual',
  'discretionary-rising': 'A larger share on wants in higher-income months',
  'regret-cluster': 'Purchases you marked as not worth it',
}
const CONFIDENCE = { high: 'High', medium: 'Medium', low: 'Low' } as const
const COUNT_WORD = ['no', 'one', 'two', 'three', 'four', 'five']

interface Shown {
  rec: Recommendation
  rows: EvidenceRow[]
  dropped: number
  note: Note | null
  challenges: Challenge[]
}

/** What the loader has done so far: once `wrote` is set, showings are being stored, so a failure after it cannot claim that nothing changed. */
interface Progress { wrote: boolean }

/**
 * Works out the advice and records each showing BEFORE it is put on screen, so the owner cannot act on advice whose
 * showing is not yet stored (src/advice/recommendations.ts: accepted advice stays withheld forever without it, and a
 * rejection only counts once per showing). Everything is read first. `isCurrent` is asked after the reads and before the
 * first write: a load superseded by then (a prop change, or React running the effect twice in development) records
 * nothing. Once the writes begin they run to the end, each of them the showing of advice that was really read.
 */
// Whether anything recurs comes from recurringPreview, which writes no row: visiting this screen cannot change what the Recurring screen shows.
async function load(month: string, today: string, computedAt: number, isCurrent: () => boolean, progress: Progress): Promise<{ items: Shown[]; decided: boolean } | null> {
  const [recs, hasRecurring] = await Promise.all([recommendationsFor(month, today, computedAt), recurringPreview(today).then((r) => r.length > 0)])
  if (!isCurrent()) return null
  const items = await Promise.all(recs.map(async (rec): Promise<Shown> => {
    const { rows, dropped } = await liveEvidence(rec.evidence)
    return { rec, rows, dropped, note: noteFor(rec.id), challenges: challengesFor(rec.id, hasRecurring) }
  }))
  if (!isCurrent()) return null
  progress.wrote = true
  await Promise.all(recs.map((r) => recordShown(r.key, r.evidenceFingerprint, computedAt)))
  // Any stored decision means the owner has already answered advice here: an empty list then is not the empty beginning.
  return { items, decided: (await db.recommendationState.count()) > 0 }
}

type Choice = 'accept' | 'snooze' | 'reject'

function Card({ item, onChoose, headingRef }: { item: Shown; onChoose: (c: Choice) => void; headingRef: (el: HTMLHeadingElement | null) => void }): ReactNode {
  const { rec, rows, dropped, note, challenges } = item
  return (
    <article className="advice-card" aria-labelledby={`advice-${rec.key}`}>
      <h3 id={`advice-${rec.key}`} tabIndex={-1} ref={headingRef}>{TITLE[rec.id]}</h3>
      <dl>
        <dt>What was noticed</dt>
        <dd>{rec.noticed}</dd>
        <dt>Evidence</dt>
        <dd>
          <p>{rec.evidence.summary}</p>
          <details>
            <summary>Show the purchases</summary>
            {dropped > 0 && (
              <p>{dropped === 1 ? '1 of the purchases behind this is' : `${dropped} of the purchases behind this are`} no longer in your records, so {dropped === 1 ? 'it is' : 'they are'} not listed.</p>
            )}
            <ul aria-label="Purchases behind this advice">
              {rows.map((r) => (
                <li key={r.id}>{formatSpanishDate(r.valueDate)}: {formatEur(r.amountCents)}, <q>{r.description}</q></li>
              ))}
            </ul>
          </details>
        </dd>
        <dt>What this means</dt>
        <dd>{rec.why}</dd>
        <dt>What to do differently</dt>
        <dd>{rec.todo}</dd>
        {rec.impactCents !== null && rec.impactLabel !== null && (
          <>
            <dt>{rec.impactLabel}</dt>
            <dd>{formatEur(rec.impactCents)}</dd>
          </>
        )}
        <dt>Confidence</dt>
        <dd>{CONFIDENCE[rec.confidence]}</dd>
      </dl>
      {note && (
        <aside aria-label="A note on this advice">
          <h4>{note.title}</h4>
          <p>{note.body}</p>
        </aside>
      )}
      {challenges.length > 0 && (
        <>
          <h4>Challenges you can try</h4>
          <ul aria-label="Challenges you can try">
            {challenges.map((c) => (
              <li key={c.id}>
                <h5>{c.title}</h5>
                <p>{c.body}</p>
                {!c.available && <p>Not available yet: {c.why}</p>}
                {c.id === 'subscription-review' && c.available && <p><a href="#/recurring">See your recurring payments</a></p>}
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="advice-actions">
        <button type="button" onClick={() => onChoose('accept')}>Accept</button>
        <button type="button" onClick={() => onChoose('snooze')}>Snooze for {SNOOZE_DAYS} days</button>
        <button type="button" onClick={() => onChoose('reject')}>Reject</button>
      </div>
    </article>
  )
}

/** `today` and `computedAt` come from the route, the one place the clock is read. */
export default function Learning({ today, computedAt }: { today: string; computedAt: number }): ReactNode {
  const month = today.slice(0, 7)
  const [items, setItems] = useState<Shown[] | null>(null)
  const [decided, setDecided] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const latest = useRef(0)
  const busy = useRef(false)
  const headings = useRef(new Map<string, HTMLHeadingElement>())
  const regionHeading = useRef<HTMLHeadingElement | null>(null)
  /** Where focus goes once the card the owner acted on has left: a key, or the region heading. */
  const focusNext = useRef<string | 'region' | null>(null)

  useEffect(() => {
    const mine = ++latest.current
    setItems(null); setError(null); setActionError(null)
    const progress: Progress = { wrote: false }
    load(month, today, computedAt, () => mine === latest.current, progress).then(
      (loaded) => { if (loaded !== null && mine === latest.current) { setDecided(loaded.decided); setItems(loaded.items) } },
      (e: unknown) => {
        if (mine !== latest.current) return
        const detail = e instanceof Error && e.message ? ` (${e.message})` : ''
        // Before the first write nothing was stored; after it, some showings may have been, and "nothing was changed" would not be true.
        setError(progress.wrote ? `Your advice could not be shown${detail}.` : `Your advice could not be worked out${detail}. Nothing was changed.`)
      },
    )
  }, [month, today, computedAt])

  useLayoutEffect(() => {
    const target = focusNext.current
    if (target === null) return
    focusNext.current = null
    ;(target === 'region' ? regionHeading.current : headings.current.get(target))?.focus()
  }, [items])

  const choose = async (key: string, choice: Choice): Promise<void> => {
    if (busy.current || items === null) return
    busy.current = true
    setActionError(null)
    try {
      if (choice === 'accept') await recordAccepted(key)
      else if (choice === 'snooze') await recordSnoozed(key, computedAt)
      else await recordRejected(key)
      const at = items.findIndex((i) => i.rec.key === key)
      const rest = items.filter((i) => i.rec.key !== key)
      // The advice that took its place in the list, else the one before, else the heading: focus is never left on a removed button.
      focusNext.current = rest[at]?.rec.key ?? rest[at - 1]?.rec.key ?? 'region'
      setDecided(true)
      setItems(rest)
    } catch (e) {
      setActionError(`Your choice could not be saved${e instanceof Error && e.message ? ` (${e.message})` : ''}. Nothing was changed.`)
    } finally {
      busy.current = false
    }
  }

  const heading = <h1>Learning</h1>
  if (error) return <section className="learning">{heading}<div role="alert" className="notice notice-refusal"><p>{error}</p></div></section>
  if (items === null) return <section className="learning">{heading}<p role="status">Loading your advice…</p></section>

  return (
    <section className="learning">
      {heading}
      <p>
        Advice about your own records, each piece with what was noticed, the purchases behind it, what it means and what you could do differently. You decide what happens to each one.
      </p>
      <h2 tabIndex={-1} ref={regionHeading}>Advice for {formatMonthTitle(month)}</h2>
      {actionError && <div role="alert" className="notice notice-refusal"><p>{actionError}</p></div>}
      {items.length === 0
        ? (
          <>
            {decided
              ? (
                <>
                  <p>There is nothing left to act on for now. You have answered the advice there was.</p>
                  <p>
                    Advice you accepted or rejected can come back if it appears again in a later month, advice you snoozed comes back after {SNOOZE_DAYS} days,
                    and new advice can appear as more of your records come in.
                  </p>
                </>
              )
              : (
                <>
                  <p>There is nothing to act on yet. This is the normal starting point, not a problem with your records.</p>
                  <p>
                    Advice appears when your records show something worth a look: a budget line that has passed the figure you set, a run of small purchases, savings that come in some months and not others,
                    a purchase well above your usual, or purchases you marked as not worth it. If you have not yet, <a href="#/import">import your bank statements</a>.
                  </p>
                </>
              )}
          </>
        )
        : (
          <>
            <p>
              Accept means you have taken it on; it stays out of the way for {formatMonthTitle(month)} and comes back only if the same kind of advice appears in a later month.
              Snooze hides it for {SNOOZE_DAYS} days. Reject hides it for {formatMonthTitle(month)}; if it comes back in a later month and you reject it again, it is gone for good.
              Advice rejected on {COUNT_WORD[SUPPRESS_AFTER_REJECTIONS]} separate occasions is not shown again.
            </p>
            <div role="list" aria-label="Advice" className="advice-list">
              {items.map((item) => (
                <div role="listitem" key={item.rec.key}>
                  <Card
                    item={item}
                    onChoose={(c) => void choose(item.rec.key, c)}
                    headingRef={(el) => { if (el) headings.current.set(item.rec.key, el); else headings.current.delete(item.rec.key) }}
                  />
                </div>
              ))}
            </div>
          </>
        )}
    </section>
  )
}
