import { db } from '../db/db'
import { resolveMany } from '../db/annotations'
import type { CategoryRow, TransactionRow } from '../db/schema'
import type { ResolvedTransaction } from '../db/annotations'
import { addDays, formatMonthTitle, isoWeekday, monthKeyOf } from '../lib/dates'
import { formatEur, sumCents } from '../lib/money'
import { excludedTransactionIds, treatmentOf } from '../analysis/income'
import { liveTransactionsBetween } from '../analysis/transactionsInRange'
import { monthlyBudget } from '../budget/month'
import { SMALL_PURCHASE_CEILING_CENTS } from '../analytics/habits'
import { monthSeries } from '../analytics/series'
import { unusualIn } from '../analytics/unusual'
import { regretClusters, type RegretCluster } from '../learning/regret'
import { correct, enteredBrackets, readBattery } from '../battery/run'
import type { TrendFinding } from '../battery/trend'
import { findingFor, type Bracket } from '../battery/finding'
import { withheldKeys } from './state'

/**
 * Advice: the point where the app stops describing and starts suggesting. Every recommendation carries §13.2's six
 * fields (what was noticed, the evidence, why it matters, what to do differently, the estimated impact, the confidence)
 * and, beside them, the key and the fingerprint the state module needs. Nothing here writes: it reads, and it says.
 *
 * THE RULE THIS FILE EXISTS TO KEEP. A battery finding that did not survive the Benjamini-Hochberg correction produces
 * NOTHING. The battery runs ten comparisons at once and corrects across them precisely because an uncorrected finding is
 * not something to act on, and advice is action. The correction here is computed exactly as the Intelligence screen
 * computes it (same ten readers, same window, same rule for which results count as tested), because a different m would
 * give the owner advice the screen beside it calls "not a finding". Today only one relationship becomes advice
 * (salary-lifestyle, as 'discretionary-rising'); the other nine appear on the Intelligence screen as findings to read,
 * and each that is wired in later must pass through the same `survives` gate in `fromSurvivors`.
 *
 * THE KEY IS BUILT FROM WHAT THE ADVICE IS ABOUT: the category, the relationship, the kind of problem. Never from a figure
 * and never from a date. A key holding an amount would change every month, so a dismissal the owner already made would
 * silently never take effect.
 *
 * THE FINGERPRINT is a digest of the evidence transaction ids and nothing else. The state module compares it to decide
 * whether advice the owner already accepted is a genuinely fresh occurrence. It is consumed here (handed to
 * `withheldKeys`), so it is not decoration.
 *
 * CONTRACT FOR THE SCREEN (inherited from src/advice/state.ts, and easy to miss): accepted advice stays withheld unless
 * `recordShown(key, evidenceFingerprint, at)` ran FIRST, with the recommendation's own fingerprint. A row accepted
 * before it was ever shown has no stored fingerprint, and the state module deliberately cannot tell whether a later
 * occurrence is fresh, so it keeps it away. The screen must therefore record the showing BEFORE the owner can accept.
 *
 * EVIDENCE GOES STALE. A transaction behind a recommendation may be soft-deleted between generation and display, so the
 * screen renders evidence through `liveEvidence`, which drops what is gone rather than leaving a blank row.
 *
 * `impactCents` is NULL, never 0, where no honest estimate exists: a confident "0 EUR" is a claim, and a number for its
 * own sake is not allowed (A7). It is a figure only where the bank rows give one without a guess about what the owner
 * would do: the overage on a line the owner set, the amount above their own usual, the amount they marked not worth it.
 *
 * Money is integer cents and shares are basis points. Every amount, sign and date is the BANK's; the owner's choices
 * decide only classifications (§41/§43). `today` and `computedAt` are arguments, the clock is never read, and every read
 * of transactions is bounded by a date range or by the owner's own answers (§39.4). Two small tables, categories and
 * transfers, are read whole, as the Budget reads them.
 */
export type RecommendationId =
  | 'overspent-category' | 'small-purchases-add-up' | 'savings-inconsistent'
  | 'unusual-spend' | 'discretionary-rising' | 'regret-cluster'

export interface Evidence { transactionIds: string[]; summary: string }

export interface Recommendation {
  id: RecommendationId
  /** Stable across cycles; the suppression key of the state module. */
  key: string
  noticed: string
  evidence: Evidence
  why: string
  todo: string
  /** Null when it cannot honestly be estimated. */
  impactCents: number | null
  confidence: 'high' | 'medium' | 'low'
  /** Digest of `evidence.transactionIds`. The state module decides with it whether accepted advice is a fresh occurrence. */
  evidenceFingerprint: string
}

/** A line is "over" when it ran at least 10 % past what the owner set; a few cents past is not advice. */
const OVERSPEND_MIN_BP = 1000
/** Fewer small purchases than this is a handful, not a habit. */
const MIN_SMALL_PURCHASES = 10
/** Months of history for "unusual", and how many purchases a category needs before its usual means anything. */
const HISTORY_MONTHS = 6
const MIN_UNUSUAL_SAMPLE = 5
/** Months with records needed before "some months, not others" is a pattern. */
const MIN_SAVINGS_MONTHS = 4
/** The Intelligence screen's own bar for showing a group of purchases as a finding (src/ui/screens/Intelligence.tsx). */
const MIN_REGRETTED = 2
const MIN_ANSWERED = 3

const previousMonth = (month: string): string => monthKeyOf(addDays(`${month}-01`, -1))
function monthsEndingAt(last: string, count: number): string[] {
  const months = [last]
  while (months.length < count) months.unshift(previousMonth(months[0] ?? last))
  return months
}
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/**
 * A digest of a SET of transaction ids: order and repeats do not matter, and ids that merely join to the same text
 * (`a`,`bc` against `ab`,`c`) do not collide, because each id is written with its length. Two independent 32-bit FNV-1a
 * runs, so a fingerprint is 64 bits wide; it detects "different evidence", it is not a security hash.
 */
export function fingerprintOf(ids: readonly string[]): string {
  const canonical = [...new Set(ids)].sort(cmp).map((id) => `${id.length}:${id}`).join('|')
  let a = 0x811c9dc5
  let b = 0x9e3779b9
  for (let i = 0; i < canonical.length; i++) {
    const c = canonical.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193) >>> 0
    b = Math.imul(b ^ c, 0x85ebca6b) >>> 0
  }
  return `${new Set(ids).size}.${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading the month's rows, once
// ---------------------------------------------------------------------------------------------------------------------

interface Row { bank: TransactionRow; r: ResolvedTransaction }

interface Ledger {
  rows: Row[]
  spending: Row[]
  savings: Row[]
  categoryById: Map<string, CategoryRow>
}

/**
 * The live bank rows of `months`, with the same classification the Budget screen uses: the owner's resolved kind and
 * category decide whether a row is spending or savings (treatmentOf), the bank's sign decides which side of the ledger it
 * can be on, and the transfers the budget leaves out stay out. Every amount and date used afterwards is read off `bank`.
 */
async function ledgerOf(months: readonly string[]): Promise<Ledger> {
  const first = months[0]
  const last = months[months.length - 1]
  if (first === undefined || last === undefined) return { rows: [], spending: [], savings: [], categoryById: new Map() }
  const [bankRows, categories, transfers, excludedPerMonth] = await Promise.all([
    liveTransactionsBetween(first, last),
    db.categories.toArray(),
    db.transfers.toArray(),
    Promise.all(months.map((m) => excludedTransactionIds(m))),
  ])
  const resolved = await resolveMany(bankRows)
  const excluded = new Set(excludedPerMonth.flatMap((s) => [...s]))
  const roundupOut = new Set(transfers.filter((t) => t.linkKind === 'roundup').map((t) => t.outTransactionId))
  const categoryById = new Map(categories.map((c) => [c.id, c]))
  const kindOf = (id: string | null) => (id === null ? null : categoryById.get(id)?.kind ?? null)
  const byId = new Map(bankRows.map((t) => [t.id, t]))

  const rows: Row[] = []
  const spending: Row[] = []
  const savings: Row[] = []
  for (const r of resolved) {
    const bank = byId.get(r.id)
    if (!bank) continue
    const row = { bank, r }
    rows.push(row)
    if (bank.amountCents >= 0) continue // money in is never spending or a saving, whatever kind the owner gave it
    const treatment = treatmentOf(r.kind, kindOf(r.categoryId))
    const left = excluded.has(bank.id) && !(bank.kind === 'roundup' && roundupOut.has(bank.id))
    if (left) continue
    if (treatment === 'spending' && !excluded.has(bank.id)) spending.push(row)
    else if (treatment === 'savings') savings.push(row)
  }
  return { rows, spending, savings, categoryById }
}

const idsOf = (rows: readonly Row[]): string[] => rows.map((x) => x.bank.id).sort(cmp)
const centsOut = (row: Row): number => -row.bank.amountCents
const monthOf = (row: Row): string => row.bank.valueDate.slice(0, 7)

function build(
  id: RecommendationId, key: string,
  fields: { noticed: string; summary: string; why: string; todo: string; impactCents: number | null; confidence: Recommendation['confidence'] },
  transactionIds: string[],
): Recommendation {
  return {
    id, key, noticed: fields.noticed,
    evidence: { transactionIds, summary: fields.summary },
    why: fields.why, todo: fields.todo, impactCents: fields.impactCents, confidence: fields.confidence,
    evidenceFingerprint: fingerprintOf(transactionIds),
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The five descriptive situations
// ---------------------------------------------------------------------------------------------------------------------

/** The allocated category that owns a purchase: its own, else the nearest parent that has a line (the Budget's rule). */
function owningLine(categoryId: string | null, lines: ReadonlySet<string>, categoryById: ReadonlyMap<string, CategoryRow>): string | null {
  let at = categoryId
  for (let step = 0; at !== null && step < 10; step++) {
    if (lines.has(at)) return at
    at = categoryById.get(at)?.parentId ?? null
  }
  return null
}

async function overspent(month: string, today: string, ledger: Ledger): Promise<Recommendation[]> {
  const budget = await monthlyBudget(month, today)
  const lines = budget.lines.filter((l) => l.targetKind === 'category' && !l.unbudgeted && ledger.categoryById.has(l.targetId))
  const owned = new Set(lines.map((l) => l.targetId))
  const when = budget.partial ? `so far in ${formatMonthTitle(month)}` : `in ${formatMonthTitle(month)}`
  const out: Recommendation[] = []
  for (const line of lines) {
    if (line.allocatedCents <= 0 || line.varianceBp === null || line.varianceBp < OVERSPEND_MIN_BP) continue
    const rows = ledger.spending.filter((x) => monthOf(x) === month && owningLine(x.r.categoryId, owned, ledger.categoryById) === line.targetId)
    if (rows.length === 0) continue
    const gross = sumCents(rows.map(centsOut))
    const refunded = gross === line.spentCents ? '' : ' The amount above is worked out with any refunds taken off, so it can differ from the sum of the purchases listed.'
    out.push(build('overspent-category', `overspent-category:${line.targetId}`, {
      noticed: `${line.label} has come to ${formatEur(line.spentCents)} ${when}, against the ${formatEur(line.allocatedCents)} you set for it.`,
      summary: `${count(rows.length, 'purchase', 'purchases')} in ${line.label}, ${formatEur(gross)} between them.${refunded}`,
      why: budget.partial
        ? 'A line that has passed its figure is easiest to adjust while the month is still running, and one that keeps passing it may mean the figure no longer fits the way you spend.'
        : 'A line that passes its figure month after month may mean the figure no longer fits the way you spend.',
      todo: 'Open the Budget screen and either move this line to match what you really spend, or keep it where it is and look through the purchases listed here for the ones you would do differently.',
      impactCents: line.spentCents - line.allocatedCents,
      confidence: 'high',
    }, idsOf(rows)))
  }
  return out
}

/**
 * ONE source for the figure and the evidence: the rows themselves, so the count and the total beside the list can never
 * disagree with the list. They are the rows smallPurchases (src/analytics/habits.ts) counts, by the same classification;
 * the test compares the two figures.
 */
function smallOnes(month: string, ledger: Ledger): Recommendation[] {
  const rows = ledger.spending.filter((x) => monthOf(x) === month && centsOut(x) < SMALL_PURCHASE_CEILING_CENTS)
  if (rows.length < MIN_SMALL_PURCHASES) return []
  const small = { count: rows.length, totalCents: sumCents(rows.map(centsOut)) }
  const line = formatEur(SMALL_PURCHASE_CEILING_CENTS)
  return [build('small-purchases-add-up', 'small-purchases-add-up', {
    noticed: `${small.count} purchases under ${line} came to ${formatEur(small.totalCents)} in ${formatMonthTitle(month)}.`,
    summary: `${count(rows.length, 'purchase', 'purchases')} under ${line} that month, ${formatEur(small.totalCents)} between them.`,
    why: 'Small purchases are easy to lose track of one at a time, and together they can come to a sum you would notice if it left your account in one go. Some of them are essentials that happen to be cheap.',
    todo: 'Pick the kind of small purchase you make most often and see whether buying it in a weekly batch would suit you. If they are all things you are glad of, nothing needs to change.',
    impactCents: null, // what the owner would do about them is theirs; their total is not a saving
    confidence: 'medium',
  }, idsOf(rows))]
}

async function savingsRhythm(month: string, today: string, computedAt: number): Promise<Recommendation[]> {
  const todayMonth = today.slice(0, 7)
  const last = month < todayMonth ? month : previousMonth(todayMonth) // a month still running is not a month without savings
  const months = monthsEndingAt(last, HISTORY_MONTHS)
  const points = (await monthSeries(months[0] ?? last, last, today, computedAt)).filter((p) => p.hasData)
  const saved = points.filter((p) => p.savedCents > 0)
  if (points.length < MIN_SAVINGS_MONTHS || saved.length === 0 || saved.length === points.length) return []
  const ledger = await ledgerOf(months)
  const rows = ledger.savings
  if (rows.length === 0) return []
  return [build('savings-inconsistent', 'savings-inconsistent', {
    noticed: `Between ${formatMonthTitle(months[0] ?? last)} and ${formatMonthTitle(last)}, you put money aside in ${saved.length} of the ${count(points.length, 'month', 'months')} that have records, and in the other ${points.length - saved.length} nothing went to savings.`,
    summary: `${count(rows.length, 'movement', 'movements')} into savings across ${count(saved.length, 'month', 'months')}, from ${formatMonthTitle(months[0] ?? last)} to ${formatMonthTitle(last)}.`,
    why: 'Savings that arrive in some months and not in others are harder to plan around when you want a cushion or a larger purchase.',
    todo: 'If a steadier rhythm would suit you, choose a day shortly after your income arrives and move the same amount then. The amount is yours to choose, and a small one still counts.',
    impactCents: null, // no honest figure: what they could set aside depends on what they can afford, which this does not know
    confidence: 'medium',
  }, idsOf(rows))]
}

function unusual(month: string, ledger: Ledger): Recommendation[] {
  const rows = ledger.spending.filter((x) => x.r.categoryId !== null)
  const found = unusualIn(
    rows.map((x) => ({ id: x.bank.id, categoryId: x.r.categoryId, cents: centsOut(x), month: monthOf(x) })),
    MIN_UNUSUAL_SAMPLE,
  ).filter((u) => u.month === month && u.categoryId !== null)
  const byCategory = new Map<string, typeof found>()
  for (const u of found) byCategory.set(u.categoryId ?? '', [...(byCategory.get(u.categoryId ?? '') ?? []), u])
  const out: Recommendation[] = []
  for (const [categoryId, group] of [...byCategory].sort(([a], [b]) => cmp(a, b))) {
    const name = ledger.categoryById.get(categoryId)?.name
    const first = group[0]
    if (name === undefined || first === undefined) continue
    const sample = rows.filter((x) => x.r.categoryId === categoryId).length
    const above = sumCents(group.map((u) => u.cents - u.medianCents))
    const usual = formatEur(first.medianCents)
    out.push(build('unusual-spend', `unusual-spend:${categoryId}`, {
      noticed: group.length === 1
        ? `One purchase in ${name} came to ${formatEur(first.cents)} in ${formatMonthTitle(month)}, where your usual there is about ${usual}.`
        : `${group.length} purchases in ${name} each came to well above your usual of about ${usual} in ${formatMonthTitle(month)}, the largest at ${formatEur(Math.max(...group.map((u) => u.cents)))}.`,
      summary: `${count(group.length, 'purchase', 'purchases')} out of the ${sample} you made in ${name} over the last ${HISTORY_MONTHS} months, ${formatEur(above)} above your usual between them.`,
      why: 'A one-off can be exactly what you meant to spend, and it is also the kind of purchase that can slip out of view in a month.',
      todo: 'Look at the purchase and see whether it was planned. If it was a one-off you chose, there is nothing to change; if it came as a surprise, you may want to leave room for it in next month\'s plan.',
      impactCents: above,
      confidence: 'medium',
    }, group.map((u) => u.transactionId).sort(cmp)))
  }
  return out
}

/** A phrase for each way purchases are grouped, completed by the month. */
function groupPhrase(c: RegretCluster): string {
  switch (c.by) {
    case 'category': return `in ${c.label}`
    case 'merchant': return `at ${c.label}`
    case 'reason': return `bought for the reason "${c.label}"`
    case 'mood': return `made when you recorded feeling ${c.label}`
    case 'weekday': return `made on a ${c.label}`
  }
}

function matches(c: RegretCluster, row: Row): boolean {
  switch (c.by) {
    case 'category': return row.r.categoryId === c.key
    case 'merchant': return row.r.merchantId === c.key
    case 'reason': return row.r.purchaseReasonId === c.key
    case 'mood': return row.r.moodId === c.key
    case 'weekday': return String(isoWeekday(row.bank.valueDate)) === c.key
  }
}

async function regrets(month: string, ledger: Ledger): Promise<Recommendation[]> {
  const clusters = (await regretClusters(month)).filter((c) => c.regretted >= MIN_REGRETTED && c.total >= MIN_ANSWERED)
  // The same rows regretClusters counted, in the month it counted: a resolved spend the owner answered "no" on, money out by the bank's sign.
  const answeredNo = ledger.rows.filter((x) => monthOf(x) === month && x.r.kind === 'spend' && x.bank.amountCents <= 0 && x.r.worthwhile === false)
  const out: Recommendation[] = []
  for (const c of clusters) {
    const rows = answeredNo.filter((x) => matches(c, x))
    if (rows.length === 0) continue
    out.push(build('regret-cluster', `regret-cluster:${c.by}:${c.key}`, {
      noticed: `You marked ${c.regretted} of the ${c.total} purchases you rated ${groupPhrase(c)} in ${formatMonthTitle(month)} as not worth it.`,
      summary: `${count(rows.length, 'purchase', 'purchases')} you marked as not worth it, ${formatEur(c.cents)} between them.`,
      why: 'These are your own answers, so they point at money that went somewhere you were not glad about afterwards.',
      todo: 'Before the next purchase of this kind, ask whether you expect to rate it as worth it a week later. If the answer is usually yes, nothing needs to change.',
      impactCents: null, // what was spent on them is a fact (it is in the summary), not an estimate of what acting differently would save
      confidence: c.regretted >= 3 && c.total >= 5 ? 'medium' : 'low',
    }, idsOf(rows)))
  }
  return out
}

// ---------------------------------------------------------------------------------------------------------------------
// The statistical situation, and the correction that gates it
// ---------------------------------------------------------------------------------------------------------------------

interface Tested { bracket: Bracket; survives: boolean }

/**
 * Salary-lifestyle's corrected verdict, and its result, or null when it was not validly tested. Which comparisons count
 * toward the correction is decided in src/battery/run.ts, the same code the Intelligence screen uses, so advice and
 * screen cannot disagree about what survived.
 */
async function salaryVerdict(today: string, computedAt: number): Promise<{ result: TrendFinding; verdict: Tested } | null> {
  const reads = await readBattery(today, computedAt)
  if (Array.isArray(reads.salary)) return null
  const mine = correct(enteredBrackets(reads)).verdicts.get('salary-lifestyle')
  return mine === undefined ? null : { result: reads.salary, verdict: { bracket: mine.bracket, survives: mine.survives } }
}

const CONFIDENCE: Record<Bracket, Recommendation['confidence']> = { 'p<0.001': 'high', 'p<0.01': 'medium', 'p<0.05': 'low', none: 'low' }

/**
 * THE GATE. A finding becomes advice only through here, and only when it survived the correction. `survives` is the
 * corrected verdict, never the finding's own bracket: a bracket is the uncorrected claim.
 */
function fromSurvivors(month: string, tested: { result: TrendFinding; verdict: Tested } | null, ledger: Ledger): Recommendation[] {
  if (tested === null || !tested.verdict.survives || tested.result.effectBp <= 0) return []
  const wants = ledger.spending.filter((x) => monthOf(x) === month && ledger.categoryById.get(x.r.categoryId ?? '')?.kind === 'discretionary')
  if (wants.length === 0) return []
  const finding = findingFor('salary-lifestyle', tested.result, tested.verdict)
  return [build('discretionary-rising', 'discretionary-rising', {
    noticed: finding.pattern,
    summary: `${count(wants.length, 'purchase', 'purchases')} in categories you have marked as wants in ${formatMonthTitle(month)}, ${formatEur(sumCents(wants.map(centsOut)))} between them. The comparison itself covers ${count(finding.transactions, 'whole month', 'whole months')}, ${finding.period}.`,
    why: 'In your own records, the months with more coming in were also the months with a larger share going to wants. That only matters if it is not where you meant the extra to go.',
    todo: finding.action,
    impactCents: null, // a pattern across months says nothing about how much would change, so no figure is offered
    confidence: CONFIDENCE[tested.verdict.bracket],
  }, idsOf(wants))]
}

// ---------------------------------------------------------------------------------------------------------------------

/**
 * The advice for `month`, most concrete first, minus whatever the state module withholds (rejected twice, snoozed, or
 * accepted on the same evidence). `computedAt` is the instant "now" for snoozes and for the cache rows beneath.
 */
export async function recommendationsFor(month: string, today: string, computedAt: number): Promise<Recommendation[]> {
  const months = monthsEndingAt(month, HISTORY_MONTHS)
  const [ledger, tested] = await Promise.all([ledgerOf(months), salaryVerdict(today, computedAt)])
  const [over, rhythm, regretful] = await Promise.all([
    overspent(month, today, ledger), savingsRhythm(month, today, computedAt), regrets(month, ledger),
  ])
  const all = [...over, ...smallOnes(month, ledger), ...rhythm, ...unusual(month, ledger), ...fromSurvivors(month, tested, ledger), ...regretful]
  const withheld = await withheldKeys(new Map(all.map((r) => [r.key, r.evidenceFingerprint])), computedAt)
  return all.filter((r) => !withheld.has(r.key))
}

export interface EvidenceRow { id: string; valueDate: string; amountCents: number; description: string }

/**
 * The evidence as it stands NOW. A transaction behind a recommendation may have been soft-deleted (or removed) since the
 * advice was generated; it is dropped, and `dropped` says how many, so the screen can say so rather than render a blank
 * row. Date and amount are the bank's; the description is the owner's own where they wrote one.
 */
export async function liveEvidence(evidence: Evidence): Promise<{ rows: EvidenceRow[]; dropped: number }> {
  const found = await db.transactions.bulkGet(evidence.transactionIds)
  const live = found.filter((t): t is TransactionRow => t !== undefined && t.deletedAt === null)
  const resolved = new Map((await resolveMany(live)).map((r) => [r.id, r]))
  const rows = live.map((t): EvidenceRow => ({
    id: t.id, valueDate: t.valueDate, amountCents: t.amountCents,
    description: (resolved.get(t.id)?.description ?? t.description).trim() || 'No description',
  }))
  return { rows, dropped: evidence.transactionIds.length - rows.length }
}
