import { db } from '../db/db'
import { buildCategoryIndex, resolve, resolveMany, type ResolvedTransaction } from '../db/annotations'
import type { TransactionRow, TransferRow } from '../db/schema'
import { addDays, monthKeyOf } from '../lib/dates'
import { sumCents } from '../lib/money'
import { liveTransactionsBetween, nextMonthStart } from './transactionsInRange'

export interface NetIncome {
  cents: number
  /**
   * Invariant: provisional === (basis !== 'actual'). A figure is provisional whenever it is not an observation of
   * the month itself: an average is not, and a zero standing in for "nothing recorded yet" is not either.
   * Basis 'none' stays distinguishable from 'trailing-average' so a screen can say "no income recorded yet"
   * instead of presenting an estimate of zero.
   */
  provisional: boolean
  basis: 'actual' | 'trailing-average' | 'none'
  /** How many prior months the average was taken over; 0 unless basis is 'trailing-average'. */
  monthsAveraged: number
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/
const TRAILING_MONTHS = 3

function assertMonth(month: string): void {
  if (!MONTH_RE.test(month)) throw new Error(`Invalid month, expected YYYY-MM: ${month}`)
}

/** The calendar month before `month`. Goes through the first day so year boundaries come from dates.ts, not from us. */
function previousMonth(month: string): string {
  return monthKeyOf(addDays(`${month}-01`, -1))
}

/** round(n / d), halves away from zero, integer-only. d > 0. */
function divRound(n: number, d: number): number {
  const q = Math.floor(Math.abs(n) / d)
  const r = Math.abs(n) - q * d
  const rounded = r * 2 >= d ? q + 1 : q
  return n < 0 ? -rounded : rounded
}

/**
 * Whether a refund link currently has any effect. A link is a relationship between two live rows, so it holds only
 * while both exist: if either leg is soft-deleted (or missing) the link is inert, the positive counts as income again
 * and nothing is subtracted from any category. Restoring the leg reactivates the link exactly as it was, so deleting
 * stays reversible and the money is never counted nowhere. Income and the budget both use this one predicate, so they
 * cannot disagree about which links are in force.
 */
export function isEffectiveRefundLink(out: TransactionRow | undefined, inn: TransactionRow | undefined): boolean {
  return out !== undefined && inn !== undefined && out.deletedAt === null && inn.deletedAt === null
}

/**
 * How a transaction is treated by the budget, from its RESOLVED kind and the kind of the category the owner (or ING)
 * filed it under. The one place this is decided, so the spending loop, the income sum and the refund rule below cannot
 * disagree about what "counted as spending" means.
 *
 * §43, as this plan ruled it: `kind` is a CLASSIFICATION, the same species as `categoryId`, so a `typeOverride` is
 * honoured here and therefore by every figure. §41 is untouched: it exists to stop a correction moving money between
 * MONTHS, and a kind correction moves no row between months — it moves a row between figures, which is what the owner
 * means. The amount, the sign and the date stay the BANK's everywhere, absolutely. The safety condition is that this
 * function is the ONLY place the question is answered and that every reader passes the resolved kind: if one reader
 * honoured the override and another did not, a euro would be counted twice or counted nowhere.
 *
 * A null kind means "no such row" (a leg that has gone missing) and is treated as nothing, never as spending.
 */
export function treatmentOf(
  kind: TransactionRow['kind'] | null, categoryKind: string | null,
): 'savings' | 'spending' | 'none' {
  if (kind === 'roundup' || categoryKind === 'savings') return 'savings'
  if (kind !== 'spend' || categoryKind === 'internal' || categoryKind === 'income') return 'none'
  return 'spending'
}

/** What a refund link takes off a category, and which positive row leaves income because of it. */
export interface RefundSubtraction {
  refundId: string
  originalId: string
  /** The owner's category for the purchase (an annotation may correct it); null means uncategorised. */
  categoryId: string | null
  /** The BANK's amount of the refund leg. */
  cents: number
  /** The BANK's date of the refund leg: the month the subtraction lands in. */
  refundValueDate: string
}

/**
 * THE rule for whether a refund link does anything, and if so what and where. A link produces a subtraction only when
 * every one of these holds, and income and the budget both act on exactly this answer, so the euros leaving income are
 * always the euros leaving a category:
 *  - both legs are live (see isEffectiveRefundLink);
 *  - the positive leg counts as income, by the RESOLVED kind the income sum itself uses (§43): a positive income.ts
 *    does not count was never in income to remove, and subtracting for it would take money off a category that no
 *    money ever left;
 *  - the purchase is one the budget counts as spending, by treatmentOf on the RESOLVED kind and the resolved category.
 * When it holds, the positive leaves income and `cents` leaves the purchase's category. When it does not, the link is
 * inert: the positive stays income and no category changes, so no money is ever counted nowhere.
 *
 * `out`/`inn` are the BANK's rows: which leg is the refund, how much it is and which month it lands in are read from
 * them and never from an override (§41). `kindOf` supplies the resolved kind of a leg by id, null when it is missing.
 */
export function refundSubtraction(
  out: TransactionRow | undefined, inn: TransactionRow | undefined,
  kindOf: (id: string) => TransactionRow['kind'] | null,
  categoryOf: (originalId: string) => string | null, categoryKindOf: (categoryId: string | null) => string | null,
): RefundSubtraction | null {
  if (!isEffectiveRefundLink(out, inn)) return null
  const refund = [out, inn].find((l) => l !== undefined && l.amountCents > 0)
  const original = [out, inn].find((l) => l !== undefined && l.amountCents < 0)
  if (!refund || !original || kindOf(refund.id) !== 'income') return null
  const categoryId = categoryOf(original.id)
  if (treatmentOf(kindOf(original.id), categoryKindOf(categoryId)) !== 'spending') return null
  return { refundId: refund.id, originalId: original.id, categoryId, cents: refund.amountCents, refundValueDate: refund.valueDate }
}

/** Every refund link that produces a subtraction, given the transfers and the raw legs they point at. */
export async function refundSubtractions(
  transfers: TransferRow[], legs: Map<string, TransactionRow>,
): Promise<RefundSubtraction[]> {
  const links = transfers.filter((t) => t.linkKind === 'refund')
  if (links.length === 0) return []
  const [categories, index] = await Promise.all([db.categories.toArray(), buildCategoryIndex()])
  const kindById = new Map(categories.map((c) => [c.id, c.kind]))
  // BOTH legs are resolved, not just the purchase: §43 makes the kind of each leg the owner's, and the rule above asks
  // for the kind of the positive as well as of the purchase. Only `categoryId` and `kind` are ever read off these
  // resolved rows; the amount, the sign and the date come from the bank rows in `legs`.
  const legIds = [...new Set(links.flatMap((l) => [l.outTransactionId, l.inTransactionId]))]
  const annotations = new Map(
    (await db.annotations.bulkGet(legIds)).flatMap((a) => (a ? [[a.transactionId, a] as const] : [])),
  )
  const resolved = new Map<string, ResolvedTransaction>()
  for (const id of legIds) {
    const row = legs.get(id)
    if (row) resolved.set(id, resolve(row, annotations.get(id), index))
  }
  const kindOf = (id: string): TransactionRow['kind'] | null => resolved.get(id)?.kind ?? null
  const categoryOf = (id: string): string | null => resolved.get(id)?.categoryId ?? null
  const categoryKindOf = (id: string | null): string | null => (id === null ? null : kindById.get(id) ?? null)
  const found: RefundSubtraction[] = []
  for (const l of links) {
    const s = refundSubtraction(legs.get(l.outTransactionId), legs.get(l.inTransactionId), kindOf, categoryOf, categoryKindOf)
    if (s) found.push(s)
  }
  return found
}

/**
 * Ids that are not real income or spending: both legs of every matched transfer (internal or round-up), and the
 * positive leg of a refund link, but ONLY when refundSubtraction says the link subtracts something from a category (the
 * spend leg stays). A link that subtracts nothing leaves its positive in income.
 *
 * `touches` decides which transfers count. A pair is excluded as a whole if EITHER leg qualifies, so a pair whose
 * legs ING dated in different months nets to zero in both months rather than leaving phantom income in one and
 * phantom spending in the other.
 */
async function exclusions(touches: (valueDate: string) => boolean): Promise<Set<string>> {
  const transfers = await db.transfers.toArray()
  const legIds = [...new Set(transfers.flatMap((t) => [t.outTransactionId, t.inTransactionId]))]
  const legs = new Map<string, TransactionRow>()
  for (const row of await db.transactions.bulkGet(legIds)) if (row) legs.set(row.id, row)

  const refunding = new Set((await refundSubtractions(transfers, legs)).map((s) => s.refundId))
  const excluded = new Set<string>()
  for (const t of transfers) {
    const out = legs.get(t.outTransactionId)
    const inn = legs.get(t.inTransactionId)
    if (![out, inn].some((l) => l !== undefined && touches(l.valueDate))) continue
    if (t.linkKind === 'refund') {
      for (const l of [out, inn]) if (l && refunding.has(l.id)) excluded.add(l.id)
    } else {
      excluded.add(t.outTransactionId)
      excluded.add(t.inTransactionId)
    }
  }
  return excluded
}

/**
 * The transfer legs and linked refunds netted out of `month`. Shared with the budget module so it cannot re-derive it differently.
 *
 * Use it for membership tests only (`set.has(row.id)`). A pair whose legs straddle a month boundary is excluded in
 * full from both months, so the set deliberately holds ids of legs dated OUTSIDE `month`. Its size is therefore not
 * a count of anything meaningful, and intersecting it with the month's rows by size or length gives quietly wrong numbers.
 */
export async function excludedTransactionIds(month: string): Promise<Set<string>> {
  assertMonth(month)
  return exclusions((d) => d.startsWith(month))
}

export interface MonthIncome { rows: number; cents: number }

/** Per-month income over a window. A month appears in the map only if it holds at least one live transaction. */
export async function incomeByMonth(firstMonth: string, lastMonth: string): Promise<Map<string, MonthIncome>> {
  const [txs, excluded] = await Promise.all([
    liveTransactionsBetween(firstMonth, lastMonth),
    exclusions((d) => d >= `${firstMonth}-01` && d < nextMonthStart(lastMonth)),
  ])
  // §43: whether a row is income is its RESOLVED kind, the owner's classification to correct, and treatmentOf (the
  // budget's side of the same question) reads the same value, so a re-kinded row leaves one figure exactly as it
  // enters the other. §41 is untouched and the trap here is precise: the month below is the BANK's valueDate and the
  // cents are the BANK's amountCents, both read off `t`; only the kind is read off the resolved row.
  const resolvedKind = new Map((await resolveMany(txs)).map((r) => [r.id, r.kind]))
  const amounts = new Map<string, number[]>()
  for (const t of txs) {
    const key = t.valueDate.slice(0, 7)
    const slot = amounts.get(key) ?? []
    // Money IN, by the bank's sign: income is what arrived. A correction can say a row is not income, and it can say an
    // arrival is; it can never put money that left the account into the income sum, which would subtract from income a
    // sum the budget is counting as spending at the same time.
    if (resolvedKind.get(t.id) === 'income' && t.amountCents > 0 && !excluded.has(t.id)) slot.push(t.amountCents)
    amounts.set(key, slot)
  }
  const out = new Map<string, MonthIncome>()
  for (const [key, list] of amounts) out.set(key, { rows: list.length, cents: sumCents(list) })
  return out
}

export async function netIncome(month: string): Promise<NetIncome> {
  assertMonth(month)
  const priors: string[] = []
  for (let m = month, i = 0; i < TRAILING_MONTHS; i++) { m = previousMonth(m); priors.push(m) }
  const oldest = priors[priors.length - 1] ?? month

  const all = await incomeByMonth(oldest, month)
  const current = all.get(month)
  // Real income wins the moment any lands, even mid-month: the actual figure beats an average the owner may already have beaten.
  if (current && current.rows > 0) return { cents: current.cents, provisional: false, basis: 'actual', monthsAveraged: 0 }

  // A month with transactions but no income is a real zero and is averaged in; a month with no data at all is skipped.
  const seen = priors.map((m) => all.get(m)).filter((x): x is MonthIncome => x !== undefined)
  if (!seen.some((m) => m.rows > 0)) return { cents: 0, provisional: true, basis: 'none', monthsAveraged: 0 }

  // Integer mean, rounded half away from zero to the nearest cent: no float drift, and it matches money.ts's rounding
  // everywhere else. Half a cent either way is immaterial for an estimate.
  const cents = divRound(sumCents(seen.map((m) => m.cents)), seen.length)
  return { cents, provisional: true, basis: 'trailing-average', monthsAveraged: seen.length }
}

/** The figure allocations are computed against: actual income if any has landed, else the provisional average, else 0. */
export async function incomeBasisFor(month: string): Promise<number> {
  return (await netIncome(month)).cents
}
