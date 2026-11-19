import { db } from '../db/db'
import { resolveMany } from '../db/annotations'
import type { AnnotationRow, TransactionRow } from '../db/schema'
import { isoWeekday, spanishWeekdayName } from '../lib/dates'
import { liveTransactionsBetween } from '../analysis/transactionsInRange'
import { dayMoods } from '../mood/day'

export interface RegretCluster {
  by: 'reason' | 'merchant' | 'category' | 'mood' | 'weekday'
  key: string        // the id, or the ISO weekday number as a string
  label: string      // owner-facing, Spanish for weekdays
  regretted: number  // spends marked worthwhile = No
  total: number      // spends in this cluster with worthwhile set either way: the denominator
  cents: number      // the bank amount of the regretted ones
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/

/**
 * Every live transaction whose annotation satisfies `keep`, for a whole-history branch. The regret screen passes "worth-it answered";
 * the mood, reason and worth-it breakdowns in src/analytics/annotated.ts pass their own field. One bounded read, shared.
 * orDayMood also admits every purchase dated on a day with a day mood (src/mood/day.ts), for the readers of a MOOD.
 *
 * Driven from `annotations`, never from `transactions`: §39.4 forbids a screen reading the whole ledger, and this
 * branch is the Intelligence screen's default view on a route that sits in the mobile tab bar, re-run on every period
 * toggle. `worthwhile` cannot be indexed (IndexedDB has no boolean keys), so the rows still have to be filtered in
 * memory — but an annotation exists only for a row the owner has TOUCHED, so what is read is bounded by the owner's own
 * activity rather than by the length of their history: three more years of imports add nothing to it. That is the sense
 * in which this read is bounded, and it is the same trick `src/import/pipeline.ts` uses for the classifier's training
 * set. `bulkGet` can return undefined for an annotation whose transaction was hard-deleted; soft-deleted rows are
 * dropped here exactly as the month branch's `liveTransactionsBetween` drops them.
 */
export async function annotatedTransactions(
  keep: (a: AnnotationRow) => boolean,
  opts: { orDayMood?: boolean } = {},
): Promise<TransactionRow[]> {
  const answered = (await db.annotations.toArray()).filter(keep)
  const rows = answered.length === 0 ? [] : await db.transactions.bulkGet(answered.map((a) => a.transactionId))
  const live = rows.filter((t): t is TransactionRow => t !== undefined && t.deletedAt === null)
  if (opts.orDayMood !== true) return live
  // orDayMood: a purchase on a day the owner gave a mood has a mood with no annotation at all. Only the dates that
  // have a day mood are read (one bounded key lookup per account), never the whole ledger.
  const dates = [...(await dayMoods()).keys()]
  if (dates.length === 0) return live
  const accountIds = await db.transactions.orderBy('accountId').uniqueKeys()
  const onThoseDays = (await Promise.all(accountIds.map((accountId) =>
    db.transactions.where('[accountId+valueDate]').anyOf(dates.map((d) => [accountId, d])).toArray()))).flat()
  const byId = new Map(live.map((t) => [t.id, t]))
  for (const t of onThoseDays) if (t.deletedAt === null) byId.set(t.id, t)
  return [...byId.values()]
}

/**
 * §41, whole module: which month a spend belongs to, its weekday and its amount are the BANK's. A `dateOverride` or
 * `amountCentsOverride` never moves or resizes a cluster. The owner-corrected values used are the classifications
 * (kind, category, merchant, mood, reason, worthwhile), which resolveMany supplies.
 *
 * §43: whether a row is a spend at all is the RESOLVED kind, which is the same question `worthAnnotating` asks of the
 * queue that offered the row. A bank `internal` the owner re-kinded to `spend` IS offered in the worth-it queue, so
 * its answer has to land here too: the app must not ask a question, get an answer and count it nowhere. The bank's
 * SIGN still decides which side of the ledger a row can be on (§43.1): `cents` below is money OUT, so a bank arrival
 * is never a regret however it is re-kinded.
 *
 * The denominator counts spends the owner answered either way; `worthwhile === null` (not answered) is neither regret
 * nor part of the total. `cents` is money out: the negated bank amount, so a spend of -12.50 EUR counts 1250.
 * Only clusters with at least one regret are returned; whether n of m is a pattern is the caller's judgement.
 */
export async function regretClusters(month: string | null): Promise<RegretCluster[]> {
  if (month !== null && !MONTH_RE.test(month)) throw new Error(`Invalid month, expected YYYY-MM: ${month}`)
  // Both branches are bounded (§39.4): the month by its date range, all history by the owner's own answers. Resolving
  // goes through resolveMany either way, so there is one resolution path and the loop below cannot tell them apart —
  // an unanswered row would be dropped by `worthwhile === null` anyway, so no cluster depends on which branch ran.
  const candidates: TransactionRow[] = month === null
    ? await annotatedTransactions((a) => a.worthwhile !== null)
    : await liveTransactionsBetween(month, month)
  return (await clustersOf(candidates)).filter((c) => c.regretted > 0)
}

/**
 * The same clusters over a whole window of months, `first` to `last` inclusive, counted ONCE over the window's spends, and
 * with the clusters that have no regret KEPT. `regretClusters` drops a cluster with no regret, answered spends and all, so
 * summing its monthly results undercounts: 5 answered and none regretted in one month, then 1 answered and 1 regretted in
 * the next, sums to 1 of 1 where the truth is 1 of 6. A caller that compares rates over a window (the Money Score) needs
 * the true denominator, and needs a pattern that fell to no regret to be present rather than absent. The Intelligence
 * screen's own reading is `regretClusters`, unchanged. Bounded by the window's date range (§39.4).
 */
export async function regretClustersBetween(first: string, last: string): Promise<RegretCluster[]> {
  if (!MONTH_RE.test(first)) throw new Error(`Invalid month, expected YYYY-MM: ${first}`)
  if (!MONTH_RE.test(last)) throw new Error(`Invalid month, expected YYYY-MM: ${last}`)
  return clustersOf(await liveTransactionsBetween(first, last))
}

async function clustersOf(candidates: TransactionRow[]): Promise<RegretCluster[]> {
  const bank = new Map(candidates.map((t) => [t.id, t]))
  const rows = await resolveMany(candidates)

  const [moods, reasons, categories, merchants] = await Promise.all([
    db.moods.toArray(), db.purchaseReasons.toArray(), db.categories.toArray(), db.merchants.toArray(),
  ])
  const labels: Record<Exclude<RegretCluster['by'], 'weekday'>, Map<string, string>> = {
    mood: new Map(moods.map((m) => [m.id, m.label])),
    reason: new Map(reasons.map((r) => [r.id, r.label])),
    category: new Map(categories.map((c) => [c.id, c.name])),
    merchant: new Map(merchants.map((m) => [m.id, m.canonicalName])),
  }

  const clusters = new Map<string, RegretCluster>()
  const add = (by: RegretCluster['by'], key: string | null, label: string | undefined, regret: boolean, cents: number): void => {
    if (key === null) return
    const id = `${by}\u0000${key}`
    let c = clusters.get(id)
    if (c === undefined) {
      c = { by, key, label: label ?? `Removed ${by}`, regretted: 0, total: 0, cents: 0 }
      clusters.set(id, c)
    }
    c.total += 1
    if (regret) { c.regretted += 1; c.cents += cents }
  }

  for (const r of rows) {
    const t = bank.get(r.id)
    // The kind is the owner's (§43), so this agrees with the queue that asked; the sign and the amount are the bank's.
    if (!t || r.kind !== 'spend' || t.amountCents > 0 || r.worthwhile === null) continue
    const regret = r.worthwhile === false
    const cents = -t.amountCents
    const weekday = isoWeekday(t.valueDate)
    add('reason', r.purchaseReasonId, r.purchaseReasonId === null ? undefined : labels.reason.get(r.purchaseReasonId), regret, cents)
    add('merchant', r.merchantId, r.merchantId === null ? undefined : labels.merchant.get(r.merchantId), regret, cents)
    add('category', r.categoryId, r.categoryId === null ? undefined : labels.category.get(r.categoryId), regret, cents)
    add('mood', r.moodId, r.moodId === null ? undefined : labels.mood.get(r.moodId), regret, cents)
    add('weekday', String(weekday), spanishWeekdayName(weekday), regret, cents)
  }

  const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
  return [...clusters.values()]
    .sort((a, b) => b.regretted - a.regretted || b.cents - a.cents || cmp(a.key, b.key) || cmp(a.by, b.by))
}
