import { db } from '../db/db'
import { resolveMany } from '../db/annotations'
import type { AnnotationRow, TransactionRow } from '../db/schema'
import { liveTransactionsBetween } from '../analysis/transactionsInRange'
import { loadCategoryKinds } from '../analysis/queues'
import { treatmentOf } from '../analysis/income'

/**
 * Spending described by what the owner said about it: its mood, its purchase reason, and whether they later judged it
 * worth it. COUNTS AND SUMS ONLY. No correlation, no significance, no effect size: that is the fixed battery of spec §12,
 * a separate plan, and §7.2 says it never feeds anything else. Nothing here says why a purchase happened; a row states
 * how many purchases carried a label and what they added up to.
 *
 * Every row carries its denominator, `answeredOf`: how many spends in the same scope carried an answer to THIS question at
 * all. Most spends carry no mood, so a share over an unstated base would be a lie by omission; the consumer is handed
 * "3 of 5 answered" and can see the base. The denominator is the same on every row of one breakdown.
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
  /** Spends in this scope that carried an answer to the question at all. */
  answeredOf: number
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/

type Field = 'moodId' | 'purchaseReasonId' | 'worthwhile'

interface Spend { cents: number; moodId: string | null; reasonId: string | null; worthwhile: boolean | null }

/**
 * Candidate rows. A month is bounded by its date range; all history is driven from `annotations` and not the ledger
 * (§39.4), because mood, reason and worthwhile exist only on a row the owner touched. The same bound regret.ts uses.
 */
async function candidates(month: string | null, field: Field): Promise<TransactionRow[]> {
  if (month !== null) return liveTransactionsBetween(month, month)
  const set = (await db.annotations.toArray()).filter((a: AnnotationRow) => a[field] !== null)
  if (set.length === 0) return []
  const rows = await db.transactions.bulkGet(set.map((a) => a.transactionId))
  return rows.filter((t): t is TransactionRow => t !== undefined && t.deletedAt === null)
}

async function spends(month: string | null, field: Field): Promise<Spend[]> {
  if (month !== null && !MONTH_RE.test(month)) throw new Error(`Invalid month, expected YYYY-MM: ${month}`)
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
  return out
}

function tally(
  items: Spend[], keyOf: (s: Spend) => string | null, labelOf: (key: string) => string,
): AnnotatedRow[] {
  const rows = new Map<string, AnnotatedRow>()
  let answeredOf = 0
  for (const s of items) {
    const key = keyOf(s)
    if (key === null) continue
    answeredOf += 1
    let row = rows.get(key)
    if (row === undefined) { row = { key, label: labelOf(key), transactions: 0, totalCents: 0, answeredOf: 0 }; rows.set(key, row) }
    row.transactions += 1
    row.totalCents += s.cents
  }
  const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
  return [...rows.values()]
    .map((r) => ({ ...r, answeredOf }))
    .sort((a, b) => b.transactions - a.transactions || b.totalCents - a.totalCents || cmp(a.key, b.key))
}

/** Spending by mood. `month` is YYYY-MM, or null for all history. Unknown ids are labelled "Removed mood". */
export async function moodBreakdown(month: string | null): Promise<AnnotatedRow[]> {
  const [items, moods] = await Promise.all([spends(month, 'moodId'), db.moods.toArray()])
  const labels = new Map(moods.map((m) => [m.id, m.label]))
  return tally(items, (s) => s.moodId, (k) => labels.get(k) ?? 'Removed mood')
}

/** Spending by purchase reason. Unknown ids are labelled "Removed reason". */
export async function reasonBreakdown(month: string | null): Promise<AnnotatedRow[]> {
  const [items, reasons] = await Promise.all([spends(month, 'purchaseReasonId'), db.purchaseReasons.toArray()])
  const labels = new Map(reasons.map((r) => [r.id, r.label]))
  return tally(items, (s) => s.reasonId, (k) => labels.get(k) ?? 'Removed reason')
}

/**
 * Worth it against not worth it, over the purchases the owner answered. A purchase with no answer is in neither row and
 * not in `answeredOf`. Rows are `worth-it` and `not-worth-it`; a side nobody chose is absent, the other still carries the
 * base.
 */
export async function worthwhileBreakdown(month: string | null): Promise<AnnotatedRow[]> {
  const items = await spends(month, 'worthwhile')
  return tally(
    items,
    (s) => (s.worthwhile === null ? null : s.worthwhile ? 'worth-it' : 'not-worth-it'),
    (k) => (k === 'worth-it' ? 'Worth it' : 'Not worth it'),
  )
}
