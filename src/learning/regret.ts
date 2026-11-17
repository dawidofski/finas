import { db } from '../db/db'
import { resolveMany } from '../db/annotations'
import type { TransactionRow } from '../db/schema'
import { isoWeekday, spanishWeekdayName } from '../lib/dates'
import { liveTransactionsBetween } from '../analysis/transactionsInRange'

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
 * §41, whole module: which month a spend belongs to, its weekday, its amount and its kind are the BANK's. A
 * `dateOverride` or `amountCentsOverride` never moves or resizes a cluster. The ONLY owner-corrected values used are
 * the classifications (category, merchant, mood, reason, worthwhile), which resolveMany supplies.
 *
 * The denominator counts spends the owner answered either way; `worthwhile === null` (not answered) is neither regret
 * nor part of the total. `cents` is money out: the negated bank amount, so a spend of -12.50 EUR counts 1250.
 * Only clusters with at least one regret are returned; whether n of m is a pattern is the caller's judgement.
 */
export async function regretClusters(month: string | null): Promise<RegretCluster[]> {
  if (month !== null && !MONTH_RE.test(month)) throw new Error(`Invalid month, expected YYYY-MM: ${month}`)
  const candidates: TransactionRow[] = month === null
    ? (await db.transactions.toArray()).filter((t) => t.deletedAt === null)
    : await liveTransactionsBetween(month, month)
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
    if (!t || t.kind !== 'spend' || r.worthwhile === null) continue
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
    .filter((c) => c.regretted > 0)
    .sort((a, b) => b.regretted - a.regretted || b.cents - a.cents || cmp(a.key, b.key) || cmp(a.by, b.by))
}
