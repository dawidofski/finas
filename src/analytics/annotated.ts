import { db } from '../db/db'
import { resolveMany } from '../db/annotations'
import type { TransactionRow } from '../db/schema'
import { liveTransactionsBetween } from '../analysis/transactionsInRange'
import { loadCategoryKinds } from '../analysis/queues'
import { treatmentOf } from '../analysis/income'
import { annotatedTransactions } from '../learning/regret'
import { cached } from './cache'

/**
 * Spending described by what the owner said about it: its mood, its purchase reason, and whether they later judged it
 * worth it. COUNTS AND SUMS ONLY. No correlation, no significance, no effect size: that is the fixed battery of spec §12,
 * a separate plan, and §7.2 says it never feeds anything else. Nothing here says why a purchase happened; a row states
 * how many purchases carried a label and what they added up to.
 *
 * Every row carries its denominator, `answeredOf`: how many spends in the same scope carried an answer to THIS question at
 * all, and `spendsInScope`: how many spends there were at all. Most spends carry no mood, so a share over an unstated
 * base would be a lie by omission; the consumer is handed "moods on 12 of 200 purchases". Both are the same on every row.
 * Figures are cached (§7.1) under a key naming the breakdown and the scope; the clock arrives as `computedAt`.
 *
 * §41: the amount, the sign and the month are the BANK's. An `amountCentsOverride` or `dateOverride` never moves or resizes
 * a row. The owner's are the classifications: mood, reason, worthwhile, category, and `kind` (via `treatmentOf`, as the
 * budget does). Income, transfers, savings and round-ups are not choices the owner made, so they are left out, and so is
 * any bank arrival (money in). Same shape and same Removed-label convention as `src/learning/regret.ts`.
 */
export interface AnnotatedRow {
  key: string
  label: string
  transactions: number
  /** Money out, in integer cents, from the bank amounts. */
  totalCents: number
  /** Spends in this scope that carried an answer to this question at all. */
  answeredOf: number
  /**
   * Every spend in this scope that the filters admit, answered or not: the base of "recorded on 12 of 200 purchases".
   * The same on every row of a breakdown. NULL for all history: that scope is read from the owner's annotations alone
   * (§39.4 forbids reading the whole ledger), so the number of unannotated spends is not known there.
   */
  spendsInScope: number | null
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/
function assertMonth(month: string | null): void {
  if (month !== null && !MONTH_RE.test(month)) throw new Error(`Invalid month, expected YYYY-MM: ${month}`)
}

type Field = 'moodId' | 'purchaseReasonId' | 'worthwhile'

interface Spend { cents: number; moodId: string | null; reasonId: string | null; worthwhile: boolean | null }

async function candidates(month: string | null, field: Field): Promise<TransactionRow[]> {
  // All history is bounded by the owner's own annotations (§39.4); the shared helper explains how.
  if (month === null) return annotatedTransactions((a) => a[field] !== null)
  return liveTransactionsBetween(month, month)
}

async function spends(month: string | null, field: Field): Promise<{ items: Spend[]; base: number | null }> {
  const bank = await candidates(month, field)
  const byId = new Map(bank.map((t) => [t.id, t]))
  const [resolved, kinds] = await Promise.all([resolveMany(bank), loadCategoryKinds()])
  const out: Spend[] = []
  for (const r of resolved) {
    const t = byId.get(r.id)
    // Kind and category are the owner's; the sign and the amount are the bank's.
    if (!t || t.amountCents >= 0) continue
    const categoryKind = r.categoryId === null ? null : (kinds.get(r.categoryId) ?? null)
    if (treatmentOf(r.kind, categoryKind) !== 'spending') continue
    out.push({ cents: -t.amountCents, moodId: r.moodId, reasonId: r.purchaseReasonId, worthwhile: r.worthwhile })
  }
  return { items: out, base: month === null ? null : out.length }
}

function tally(
  items: Spend[], spendsInScope: number | null, keyOf: (s: Spend) => string | null, labelOf: (key: string) => string,
): AnnotatedRow[] {
  const rows = new Map<string, AnnotatedRow>()
  let answeredOf = 0
  for (const s of items) {
    const key = keyOf(s)
    if (key === null) continue
    answeredOf += 1
    let row = rows.get(key)
    if (row === undefined) { row = { key, label: labelOf(key), transactions: 0, totalCents: 0, answeredOf: 0, spendsInScope: null }; rows.set(key, row) }
    row.transactions += 1
    row.totalCents += s.cents
  }
  const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
  return [...rows.values()]
    .map((r) => ({ ...r, answeredOf, spendsInScope }))
    .sort((a, b) => b.transactions - a.transactions || b.totalCents - a.totalCents || cmp(a.key, b.key))
}

const scope = (month: string | null): string => month ?? 'all'

/** Spending by mood. `month` is YYYY-MM, or null for all history. Unknown ids are labelled "Removed mood". */
export async function moodBreakdown(month: string | null, computedAt: number): Promise<AnnotatedRow[]> {
  assertMonth(month)
  return cached(`moodBreakdown:${scope(month)}`, async () => {
    const [{ items, base }, moods] = await Promise.all([spends(month, 'moodId'), db.moods.toArray()])
    const labels = new Map(moods.map((m) => [m.id, m.label]))
    return tally(items, base, (s) => s.moodId, (k) => labels.get(k) ?? 'Removed mood')
  }, computedAt)
}

/** Spending by purchase reason. Unknown ids are labelled "Removed reason". */
export async function reasonBreakdown(month: string | null, computedAt: number): Promise<AnnotatedRow[]> {
  assertMonth(month)
  return cached(`reasonBreakdown:${scope(month)}`, async () => {
    const [{ items, base }, reasons] = await Promise.all([spends(month, 'purchaseReasonId'), db.purchaseReasons.toArray()])
    const labels = new Map(reasons.map((r) => [r.id, r.label]))
    return tally(items, base, (s) => s.reasonId, (k) => labels.get(k) ?? 'Removed reason')
  }, computedAt)
}

/**
 * Worth it against not worth it, over the purchases the owner answered. A purchase with no answer is in neither row and
 * not in `answeredOf`. Rows are `worth-it` and `not-worth-it`; a side nobody chose is absent, the other still carries the
 * base.
 */
export async function worthwhileBreakdown(month: string | null, computedAt: number): Promise<AnnotatedRow[]> {
  assertMonth(month)
  return cached(`worthwhileBreakdown:${scope(month)}`, async () => {
    const { items, base } = await spends(month, 'worthwhile')
    return tally(
      items, base,
      (s) => (s.worthwhile === null ? null : s.worthwhile ? 'worth-it' : 'not-worth-it'),
      (k) => (k === 'worth-it' ? 'Worth it' : 'Not worth it'),
    )
  }, computedAt)
}
