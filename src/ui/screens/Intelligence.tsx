import { useEffect, useRef, useState, type ReactNode } from 'react'
import { db } from '../../db/db'
import { CORRECTIONS_NEEDED, categoryMemory } from '../../learning/memory'
import { regretClusters, type RegretCluster } from '../../learning/regret'
import { smallPurchases } from '../../analytics/habits'
import { monthSeries } from '../../analytics/series'
import { BATTERY, isMet, type BatteryData, type Gate, type RelationshipId } from '../../battery/battery'
import { FDR_BP, benjaminiHochberg, type Corrected } from '../../battery/correction'
import { boredomImpulse, reasonWorthwhile, type ContingencyOutcome, type ContingencyResult } from '../../battery/contingency'
import { moodAmount, stressDiscretionary, weekend } from '../../battery/rank'
import { categorySavings, moodFrequency, paydayTrend, salaryLifestyle } from '../../battery/trend'
import {
  findingFor,
  type Bracket, type CorrectionVerdict, type Finding, type Observation, type SmallPurchasesContext,
} from '../../battery/finding'
import { addDays, daysBetween, epochMsToIso, formatMonthTitle, formatSpanishDate, monthKeyOf } from '../../lib/dates'
import { formatBp, formatEur } from '../../lib/money'

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

// ===========================================================================
// THE BATTERY (design §12), the third region of this screen.
//
// Ten declared relationships, each read through the analytics cache exactly as every other figure on this screen is:
// the four result modules call `cached` themselves, so nothing here reads the transactions table and nothing here
// reads a clock. This screen is also the battery's ONLY consumer (§7.2: the battery feeds nothing else), which
// src/sourceRules.test.ts enforces over the whole tree.
//
// THE FOUR THINGS A RELATIONSHIP CAN SAY, and the reason they are four and not two:
//   gated      its gate is unmet. Nothing was tested, so nothing is claimed and nothing enters the correction. This
//              is what a new set of records shows for every one of the ten, for weeks, and it is a list of what is
//              still needed rather than ten failures.
//   nothing    the table had enough rows to try but cannot carry the statistic at all (an empty row or column).
//   untested   a sparse or oversized table, and the small purchases, which §12 gives no test. A real strength figure
//              with no certainty behind it. These must NOT enter the correction: Benjamini-Hochberg's m is the number
//              of hypotheses TESTED, and an untested one in m makes every real finding harder to believe for no
//              reason — it would punish the owner for data they do not have yet.
//   looked     a valid comparison with a real bracket. 'none' belongs here: it was genuinely tested and came back
//              unremarkable, so it counts in m and is worded "not certain yet", never "no effect".
// ===========================================================================

/**
 * The months the battery reads over. Twelve is the shortest window that can hold what the longest gates ask for —
 * four months of spending for the category comparison, two income levels of two months each — while still being a
 * bounded read (§39.4) rather than the whole ledger.
 */
const WINDOW_MONTHS = 12
/** A purchase is small when it is under this. The Reports screen prints the same figure; the two must move together. */
const SMALL_CEILING_CENTS = 1000
const MS_PER_DAY = 86_400_000
const EPOCH_DAY = '1970-01-01'

/**
 * The instant the cache rows are STAMPED with. `cached` takes it from the caller and never compares it — a row is
 * current when its engine version and its inputs hash match — so this value is a record of when a figure was built
 * and nothing reasons about it. routes.tsx is the one place the app reads the clock, and what it hands this screen is
 * the day; the day's own UTC midnight is therefore the most this screen can honestly stamp, and it reads no clock to
 * arrive at it.
 */
const instantOf = (today: string): number => daysBetween(EPOCH_DAY, today) * MS_PER_DAY

const previousMonth = (month: string): string => monthKeyOf(addDays(`${month}-01`, -1))

function windowOf(month: string): { from: string; to: string } {
  let from = month
  for (let i = 1; i < WINDOW_MONTHS; i++) from = previousMonth(from)
  return { from, to: month }
}

type Body =
  | { kind: 'gated'; gates: Gate[] }
  | { kind: 'nothing'; why: string; n: number; period: { from: string; to: string } | null }
  | { kind: 'untested'; state: string; finding: Finding; own: readonly string[] }
  | { kind: 'looked'; bracket: Bracket; finding: (verdict: CorrectionVerdict) => Finding; own: readonly string[] }

const gated = (gates: Gate[]): Body => ({ kind: 'gated', gates })
const looked = (bracket: Bracket, finding: (verdict: CorrectionVerdict) => Finding, own: readonly string[] = []): Body =>
  ({ kind: 'looked', bracket, finding, own })

/**
 * The verdict handed to findingFor where NO TEST WAS RUN. The template overrides the sentence in every such case (a
 * sparse table, an oversized one, the small purchases), so nothing here is read; it is spelled out as unbracketed and
 * not surviving because inventing a bracket for something untested is the one direction this screen must never lean.
 */
const UNJUDGED: CorrectionVerdict = { bracket: 'none', survives: false }

/** One sentence per withheld state. Neither may be the sentence a real but uncertain result gets. */
const WITHHELD: Record<'sparse' | 'too-many-categories', string> = {
  sparse: 'Not looked at: too few of your answers in some corners',
  'too-many-categories': 'Not looked at: more different answers than it can weigh at once',
}

const ALL_ZERO: BatteryData = {
  discretionarySpendsWithMood: 0, moodGroupsOfTen: 0, weeksOfMoodCoverage: 0, stressedSpends: 0, unstressedSpends: 0,
  impulseTaggedSpends: 0, spendsWithReasonAndWorthwhile: 0, weekendsObserved: 0, incomeEvents: 0, fullMonths: 0,
  incomeLevelsWithTwoMonths: 0, monthsObserved: 0,
}

/**
 * The unmet gates of the one relationship no module owns: the small purchases are a plain count, so this screen reads
 * their gate off the battery itself rather than wording a shortfall of its own.
 */
function unmetGates(id: RelationshipId, data: Partial<BatteryData>): Gate[] {
  const relationship = BATTERY.find((r) => r.id === id)
  if (relationship === undefined) throw new Error(`no relationship ${id} in the battery`)
  return relationship.gates({ ...ALL_ZERO, ...data }).filter((g) => !isMet(g))
}

/**
 * A contingency outcome in the three shapes it comes in. `verdict` is read, NEVER the bracket: 'sparse' and
 * 'too-many-categories' both carry a placeholder 'none', and letting either produce the sentence a real 'none'
 * produces would tell the owner their answers do not go together when the truth is that the app declined to look.
 */
function contingencyBody(
  outcome: ContingencyOutcome,
  own: (result: ContingencyResult) => string[],
  make: (result: ContingencyResult, verdict: CorrectionVerdict) => Finding,
): Body {
  if (Array.isArray(outcome)) return gated(outcome)
  if ('withheld' in outcome) return { kind: 'nothing', why: outcome.why, n: outcome.n, period: outcome.period }
  if (outcome.verdict !== 'tested') {
    return { kind: 'untested', state: WITHHELD[outcome.verdict], finding: make(outcome, UNJUDGED), own: own(outcome) }
  }
  return looked(outcome.bracket, (verdict) => make(outcome, verdict), own(outcome))
}

/**
 * Every relationship's result, gathered once. The ten reads run together and each goes through the cache, so a
 * second visit to this screen recomputes nothing.
 *
 * The window is the one thing this screen decides and hands down; the PERIOD shown beside a figure is always the
 * result's own, which is the span of the records that really entered it and can be narrower than the window asked for.
 */
async function loadBattery(today: string, computedAt: number): Promise<Record<RelationshipId, Body>> {
  const { from, to } = windowOf(today.slice(0, 7))
  const [points, mood, frequency, stress, boredom, reasons, week, payday, salary, savings] = await Promise.all([
    monthSeries(from, to, today, computedAt),
    moodAmount(computedAt),
    moodFrequency(computedAt),
    stressDiscretionary(computedAt),
    boredomImpulse(computedAt),
    reasonWorthwhile(computedAt),
    weekend(from, to, computedAt),
    paydayTrend(from, to, today, computedAt),
    salaryLifestyle(from, to, today, computedAt),
    categorySavings(from, to, today, computedAt),
  ])
  // A complete month is one with records that has ENDED: the running month's small purchases are a part of a month,
  // and a part of a month compared with whole ones would read as a fall in spending that is only the calendar.
  const complete = points.filter((p) => p.hasData && p.month < to)
  const latest = complete[complete.length - 1]
  const small = latest === undefined ? null : await smallPurchases(latest.month, SMALL_CEILING_CENTS, computedAt)
  const counted: Body = latest === undefined || small === null
    ? gated(unmetGates('small-purchases', { fullMonths: complete.length }))
    : {
      kind: 'untested',
      state: 'A count of your own purchases, not a comparison',
      finding: findingFor('small-purchases', {
        small, month: latest.month, ceilingCents: SMALL_CEILING_CENTS, monthSpendCents: latest.spentCents,
      } satisfies SmallPurchasesContext, UNJUDGED),
      own: [],
    }

  return {
    'mood-amount': Array.isArray(mood) ? gated(mood) : looked(mood.bracket, (v) => findingFor('mood-amount', mood, v)),
    'mood-frequency': Array.isArray(frequency) ? gated(frequency) : looked(frequency.bracket, (v) => findingFor('mood-frequency', frequency, v)),
    'stress-discretionary': Array.isArray(stress) ? gated(stress) : looked(stress.bracket, (v) => findingFor('stress-discretionary', stress, v)),
    // The owner's own words that reach this one's sentences: the label of the reason tag the table is built on.
    'boredom-impulse': contingencyBody(boredom, (r) => [r.columns[0]], (r, v) => findingFor('boredom-impulse', r, v)),
    // Every row here is a reason the owner answered with, so every row label is theirs.
    'reason-worthwhile': contingencyBody(reasons, (r) => r.rows.map((row) => row.label), (r, v) => findingFor('reason-worthwhile', r, v)),
    weekend: Array.isArray(week) ? gated(week) : looked(week.bracket, (v) => findingFor('weekend', week, v)),
    payday: Array.isArray(payday) ? gated(payday) : looked(payday.bracket, (v) => findingFor('payday', payday, v)),
    'small-purchases': counted,
    'salary-lifestyle': Array.isArray(salary) ? gated(salary) : looked(salary.bracket, (v) => findingFor('salary-lifestyle', salary, v)),
    // The figure shown is the STRONGEST category's, so the certainty shown has to be that same category's bracket, and
    // the one owner-named label that reaches the sentences is that category's name.
    'category-savings': Array.isArray(savings)
      ? gated(savings)
      : looked(savings.categories[0]?.bracket ?? 'none', (v) => findingFor('category-savings', savings, v),
        savings.categories[0] === undefined ? [] : [savings.categories[0].label]),
  }
}

const LETTER = /[\p{L}\p{N}]/u

/** The first whole-word occurrence of any of `labels` at or after `from`, compared in lower case. */
function nextOwnWord(lower: string, from: number, labels: readonly string[]): { at: number; length: number } | null {
  let best: { at: number; length: number } | null = null
  for (const label of labels) {
    const needle = label.toLowerCase()
    if (needle.length === 0) continue
    let at = lower.indexOf(needle, from)
    while (at !== -1) {
      const before = at === 0 ? '' : lower[at - 1] ?? ''
      const after = lower[at + needle.length] ?? ''
      if (!LETTER.test(before) && !LETTER.test(after)) break
      at = lower.indexOf(needle, at + 1)
    }
    if (at !== -1 && (best === null || at < best.at || (at === best.at && needle.length > best.length))) {
      best = { at, length: needle.length }
    }
  }
  return best
}

/**
 * A sentence with the owner's own words quoted inside it.
 *
 * A purchase reason or a category the owner named themselves reaches a finding's pattern, its effect label and its
 * action. The app may repeat "Because I was tired" — it is the owner's answer and the finding is about it — but it
 * must not read as though the app wrote it, so the owner's words are marked as a quotation and the app's sentence is
 * left as the app's. The comparison is case-insensitive because a template may lower-case a label mid-sentence, and
 * it is whole-word so a short label cannot be found inside an unrelated word.
 */
function ownWords(text: string, labels: readonly string[]): ReactNode {
  if (labels.length === 0) return text
  const lower = text.toLowerCase()
  const out: ReactNode[] = []
  let at = 0
  for (let found = nextOwnWord(lower, at, labels); found !== null; found = nextOwnWord(lower, at, labels)) {
    if (found.at > at) out.push(text.slice(at, found.at))
    out.push(<q className="own-words" key={found.at}>{text.slice(found.at, found.at + found.length)}</q>)
    at = found.at + found.length
  }
  if (out.length === 0) return text
  if (at < text.length) out.push(text.slice(at))
  return out
}

/** §12 names the count field "transactions analysed"; for four of the ten it is weeks, days or whole months. */
const UNIT: Record<Observation, [string, string]> = {
  purchases: ['purchase', 'purchases'], weeks: ['week', 'weeks'], days: ['day', 'days'], months: ['month', 'months'],
}
const observations = (f: Finding): string => plural(f.transactions, ...UNIT[f.unit])

/**
 * The eight fields, each on its own line. The SIZE of an effect and HOW SURE the app is of it are two lines and never
 * one: a result can be certain and tiny, and one merged score or bar would destroy the only distinction that makes
 * this region honest.
 */
function Fields({ finding, own }: { finding: Finding; own: readonly string[] }): ReactNode {
  return (
    <>
      <p><strong>What your records show:</strong> {ownWords(finding.pattern, own)}</p>
      <p className="battery-effect"><strong>How large it is:</strong> {ownWords(finding.effect.label, own)}: {formatBp(finding.effect.bp)}</p>
      <p className="battery-sure"><strong>How sure the app is:</strong> {finding.confidence}</p>
      <p><strong>Read from:</strong> {observations(finding)}, {finding.period}</p>
      <p><strong>What it cannot tell you:</strong> {finding.limitation}</p>
      <p><strong>Another way to read it:</strong> {finding.meaning}</p>
      <p><strong>What you could do:</strong> {ownWords(finding.action, own)}</p>
    </>
  )
}

/**
 * What the correction did, in the owner's words and with the bar it actually applied. The figure matters: a result the
 * owner can see on the screen and is not being called a finding needs the bar it was held to shown beside it, or the
 * region is asking to be taken on trust.
 */
function correctionText(tested: number, survived: number, thresholdBp: number | null): string {
  if (tested === 0) {
    return 'Nothing was looked at this time, so no answer here is being weighed against any other. The questions above start answering one by one as your records build up.'
  }
  const together = `The app looked at ${tested} of these questions this time. The more it looks at in one go, the easier it is for one of them to look clear by luck alone, so each had to be clearer than it would have had to be on its own:`
  if (thresholdBp === null) {
    return `${together} ${formatBp(FDR_BP)} on its own. None of the ${tested} was clear enough once they were all counted together.`
  }
  return `${together} ${formatBp(FDR_BP)} on its own, ${formatBp(thresholdBp)} here. ${survived} of the ${tested} cleared that.`
}

function stateText(body: Body, verdict: CorrectionVerdict): string {
  if (body.kind === 'gated') return 'Not enough recorded yet'
  if (body.kind === 'nothing') return 'Nothing to compare yet'
  if (body.kind === 'untested') return body.state
  if (verdict.bracket === 'none') return 'Looked at, and not certain yet'
  return verdict.survives ? 'A finding' : 'Shown, and not called a finding'
}

function Battery({ rows }: { rows: Record<RelationshipId, Body> }): ReactNode {
  // ONLY a validly tested relationship enters the correction. An unmet gate was never tested; a sparse or oversized
  // table was not validly tested either, since the assumption its certainty rests on failed; the small purchases are
  // a count and §12 gives them no test. A result that WAS tested and came back 'none' does count: it was looked at
  // and came back unremarkable, which is an answer.
  const judged = BATTERY.flatMap((r) => {
    const body = rows[r.id]
    return body.kind === 'looked' ? [{ item: r.id, bracket: body.bracket }] : []
  })
  const { results, thresholdBp } = benjaminiHochberg(judged)
  const verdicts = new Map<RelationshipId, Corrected<RelationshipId>>(results.map((c) => [c.item, c]))

  return (
    <>
      <p>{correctionText(judged.length, results.filter((c) => c.survives).length, thresholdBp)}</p>
      <ul className="intelligence-list battery-list" aria-label="Each question and what it can say">
        {BATTERY.map((relationship) => {
          const body = rows[relationship.id]
          const verdict: CorrectionVerdict = body.kind === 'looked'
            ? verdicts.get(relationship.id) ?? { bracket: body.bracket, survives: false }
            : UNJUDGED
          return (
            <li key={relationship.id}>
              <p className="battery-question"><strong>{relationship.question}</strong></p>
              <p className="battery-state">{stateText(body, verdict)}</p>
              {body.kind === 'gated' && (
                <>
                  <p>What this one still needs:</p>
                  <ul className="intelligence-list" aria-label={`What is still needed: ${relationship.question}`}>
                    {body.gates.map((g) => <li key={g.what}>{g.what}</li>)}
                  </ul>
                </>
              )}
              {body.kind === 'nothing' && (
                <>
                  <p>{body.why}</p>
                  {body.period !== null && (
                    <p><strong>Read from:</strong> {plural(body.n, 'purchase', 'purchases')}, {formatSpanishDate(body.period.from)} to {formatSpanishDate(body.period.to)}</p>
                  )}
                </>
              )}
              {body.kind === 'untested' && <Fields finding={body.finding} own={body.own} />}
              {body.kind === 'looked' && <Fields finding={body.finding(verdict)} own={body.own} />}
            </li>
          )
        })}
      </ul>
    </>
  )
}

type Period = 'month' | 'all'

/** `today` is injected so the tests own time. */
export default function Intelligence({ today }: { today: string }): ReactNode {
  const [taught, setTaught] = useState<Taught[] | null>(null)
  const [period, setPeriod] = useState<Period>('all')
  const [clusters, setClusters] = useState<RegretCluster[] | null>(null)
  const [battery, setBattery] = useState<Record<RelationshipId, Body> | null>(null)
  const [batteryError, setBatteryError] = useState<string | null>(null)
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

  // The battery is read once for the day it was given: the ten questions do not change with the period buttons below,
  // which narrow only the answers to "Worth it?".
  useEffect(() => {
    let live = true
    loadBattery(today, instantOf(today)).then((rows) => { if (live) setBattery(rows) }, (e: unknown) => {
      if (live) setBatteryError(`The questions about your spending could not be worked out${e instanceof Error && e.message ? ` (${e.message})` : ''}. Nothing was changed.`)
    })
    return () => { live = false }
  }, [today])

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

      <section className="battery" aria-labelledby="battery-heading">
        <h2 id="battery-heading">{BATTERY.length} questions about your spending</h2>
        <p>
          These are the questions the app asks of your own records, and the only ones. Each needs a certain amount
          recorded before it can be looked at, and until then it lists what it is still short of in place of a figure.
          Ten questions with nothing behind them yet is the ordinary state of a new set of records.
        </p>
        <p>
          Nothing is held back from you: as soon as one of them has enough behind it, it appears below with its figure,
          how sure the app is of it, and what it cannot tell you — three separate things.
        </p>
        {batteryError !== null && <div role="alert" className="notice notice-refusal"><p>{batteryError}</p></div>}
        {batteryError === null && (battery === null
          ? <p role="status">Loading what your records can answer…</p>
          : <Battery rows={battery} />)}
      </section>
    </section>
  )
}
