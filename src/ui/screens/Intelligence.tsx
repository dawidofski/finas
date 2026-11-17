import { useEffect, useRef, useState, type ReactNode } from 'react'
import { db } from '../../db/db'
import { CORRECTIONS_NEEDED, categoryMemory } from '../../learning/memory'
import { regretClusters, type RegretCluster } from '../../learning/regret'
import { epochMsToIso, formatMonthTitle, formatSpanishDate } from '../../lib/dates'
import { formatEur } from '../../lib/money'

/**
 * When a group of purchases is shown as a finding. regretClusters deliberately returns a group even when it is one
 * regretted purchase out of one and leaves the judgement to this screen; this is that judgement.
 *
 * A finding needs at least 2 purchases marked not worth it AND at least 3 answered in the group. One of one, one of
 * two and one of three are each a single purchase, and a "pattern" drawn from a single purchase is false confidence
 * (spec A2). Two of two is held back too: with so few answers the group says as much about the group's size as about
 * the owner. Below the bar the screen says what is missing instead of showing the figure.
 */
export const MIN_REGRETTED = 2
export const MIN_ANSWERED = 3

export const isFinding = (c: RegretCluster): boolean => c.regretted >= MIN_REGRETTED && c.total >= MIN_ANSWERED

const DIMENSION: Record<RegretCluster['by'], string> = {
  reason: 'Reason for buying', merchant: 'Merchant', category: 'Category', mood: 'Mood', weekday: 'Day of the week',
}

const times = (n: number) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`)
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

interface Taught { merchantId: string; merchant: string; category: string; corrections: number; lastAt: number }

async function loadTaught(): Promise<Taught[]> {
  // The merchants are read once and handed to the memory, which would otherwise read the table itself.
  const merchants = await db.merchants.toArray()
  const [memory, categories] = await Promise.all([categoryMemory(merchants), db.categories.toArray()])
  const merchantName = new Map(merchants.map((m) => [m.id, m.canonicalName]))
  const categoryName = new Map(categories.map((c) => [c.id, c.name]))
  return [...memory].map(([merchantId, m]) => ({
    merchantId,
    merchant: merchantName.get(merchantId) ?? 'Removed merchant',
    category: categoryName.get(m.categoryId) ?? 'Removed category',
    corrections: m.corrections,
    lastAt: m.lastAt,
  })).sort((a, b) => b.corrections - a.corrections || a.merchant.localeCompare(b.merchant))
}

type Period = 'month' | 'all'

/** `today` is injected so the tests own time. */
export default function Intelligence({ today }: { today: string }): ReactNode {
  const [taught, setTaught] = useState<Taught[] | null>(null)
  const [period, setPeriod] = useState<Period>('all')
  const [clusters, setClusters] = useState<RegretCluster[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const latest = useRef(0)
  const month = today.slice(0, 7)

  useEffect(() => {
    let live = true
    loadTaught().then((t) => { if (live) setTaught(t) }, (e: unknown) => {
      if (live) setError(`What the app has learned could not be read${e instanceof Error && e.message ? ` (${e.message})` : ''}. Nothing was changed.`)
    })
    return () => { live = false }
  }, [])

  useEffect(() => {
    const mine = ++latest.current
    setClusters(null)
    regretClusters(period === 'month' ? month : null).then((c) => { if (mine === latest.current) setClusters(c) }, (e: unknown) => {
      if (mine === latest.current) setError(`Your answers to "Worth it?" could not be read${e instanceof Error && e.message ? ` (${e.message})` : ''}. Nothing was changed.`)
    })
  }, [period, month])

  const heading = <h1>Intelligence</h1>
  if (error) return <section className="intelligence">{heading}<div role="alert" className="notice notice-refusal"><p>{error}</p></div></section>

  const periodName = period === 'month' ? formatMonthTitle(month) : 'all your records'
  const learned = (taught ?? []).filter((t) => t.corrections >= CORRECTIONS_NEEDED)
  const learning = (taught ?? []).filter((t) => t.corrections < CORRECTIONS_NEEDED)
  const findings = (clusters ?? []).filter(isFinding)
  const heldBack = (clusters ?? []).length - findings.length

  return (
    <section className="intelligence">
      {heading}

      <h2>What I have learned about your merchants</h2>
      {taught === null ? <p role="status">Loading what has been learned…</p> : (
        <>
          {learned.length === 0 && (
            <div role="note" className="notice">
              <p>
                Nothing learned yet. A merchant&apos;s category becomes the default once you have corrected it the same way {times(CORRECTIONS_NEEDED)}.
                {learning.length === 0
                  ? ' So far you have not corrected any merchant, so there is nothing to go on.'
                  : ` ${plural(learning.length, 'merchant has', 'merchants have')} one correction so far.`}
              </p>
              <p>
                To start: in <a href="#/transactions">Transactions</a>, name the merchant on a purchase and set its category, then do the same
                on a second purchase from that merchant.
              </p>
            </div>
          )}
          {learned.length > 0 && (
            <ul className="intelligence-list" aria-label="Learned merchants">
              {learned.map((t) => (
                <li key={t.merchantId}>
                  {t.merchant}: {t.category}. Corrected {times(t.corrections)}, most recently on {formatSpanishDate(epochMsToIso(t.lastAt))}.
                </li>
              ))}
            </ul>
          )}
          {learning.length > 0 && (
            <>
              <h3>Not enough corrections yet</h3>
              <ul className="intelligence-list" aria-label="Merchants still being learned">
                {learning.map((t) => (
                  <li key={t.merchantId}>
                    {t.merchant}: {t.category}. Corrected {times(t.corrections)}; {CORRECTIONS_NEEDED - t.corrections} more of the same
                    correction and it becomes the default.
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}

      <h2>Purchases you marked as not worth it</h2>
      <div className="actions" role="group" aria-label="Period">
        <button type="button" className="btn" aria-pressed={period === 'all'} onClick={() => setPeriod('all')}>All time</button>
        <button type="button" className="btn" aria-pressed={period === 'month'} onClick={() => setPeriod('month')}>{formatMonthTitle(month)}</button>
      </div>
      {clusters === null ? <p role="status">Loading your answers…</p> : (
        <>
          {clusters.length === 0 && (
            <div role="note" className="notice">
              <p>
                Nothing to show for {periodName}: no purchase is marked as not worth it. Counts appear here once you have answered
                &quot;Worth it?&quot; on a few purchases; each group needs at least {MIN_REGRETTED} marked not worth it out of at least {MIN_ANSWERED} you
                answered.
              </p>
            </div>
          )}
          {clusters.length > 0 && findings.length === 0 && (
            <div role="note" className="notice">
              <p>
                Not enough to say anything yet for {periodName}. A group is shown once at least {MIN_REGRETTED} of its purchases are marked
                not worth it, out of at least {MIN_ANSWERED} you answered.
              </p>
            </div>
          )}
          {findings.length > 0 && (
            <ul className="intelligence-list" aria-label={`Not worth it, ${periodName}`}>
              {findings.map((c) => (
                <li key={`${c.by}:${c.key}`}>
                  {DIMENSION[c.by]}: {c.label}. {c.regretted} of {c.total} answered purchases marked not worth it, {formatEur(c.cents)} in total
                  ({periodName}).
                </li>
              ))}
            </ul>
          )}
          {findings.length > 0 && heldBack > 0 && (
            <p>{plural(heldBack, 'other group is', 'other groups are')} not shown: each has fewer than {MIN_REGRETTED} marked not worth it, or fewer than {MIN_ANSWERED} answered.</p>
          )}
        </>
      )}
    </section>
  )
}
