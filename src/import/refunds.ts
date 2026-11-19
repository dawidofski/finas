import { db } from '../db/db'
import { resolveMany, type ResolvedTransaction } from '../db/annotations'
import type { TransactionRow, TransferRow } from '../db/schema'
import { addDays, daysBetween, formatSpanishDate, monthKeyOf } from '../lib/dates'
import { refundSubtractions, treatmentOf } from '../analysis/income'
import { linkedAmong, transfersTouching } from '../db/transfers'
import { liveTransactionsBetween, nextMonthStart } from '../analysis/transactionsInRange'

/** How far back a refund can reach (§10). A refund after more than this is almost certainly something else. */
export const REFUND_WINDOW_DAYS = 90

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/

/** Every table either path reads or writes, so a check and the write it guards happen in one transaction. */
const stores = () => [db.transactions, db.annotations, db.categories, db.settings, db.transfers]

/** The kind of the category a purchase is filed under (the owner's correction included), or null when it has none. */
async function categoryKindFor(categoryId: string | null): Promise<string | null> {
  return categoryId === null ? null : (await db.categories.get(categoryId))?.kind ?? null
}

const newestFirst = (a: ResolvedTransaction, b: ResolvedTransaction): number =>
  a.valueDate < b.valueDate ? 1 : a.valueDate > b.valueDate ? -1 : a.id < b.id ? -1 : 1

const BANK_DATES = ' These are the dates the bank recorded, which can differ from any date you have corrected.'

/** The owner's classifications `whyNot` consults: the resolved kind of each leg (§43) and the purchase's category kind. */
interface Classified {
  /** The resolved kind of the positive: what income.ts counts it as. */
  positiveKind: TransactionRow['kind']
  /** The resolved kind of the purchase: what month.ts counts it as. */
  spendKind: TransactionRow['kind']
  /** The kind of the purchase's resolved category. */
  categoryKind: string | null
}

/**
 * The one place that decides whether `spend` can be what `positive` refunds. Returns a sentence for the owner when it
 * cannot, else null. Both the write (`linkRefund`) and the list of choices offered on screen (`refundCandidates`) go
 * through it, so the screen can never offer a link the write would refuse.
 *
 * A link is a statement about two bank events, so dates, amounts and signs are the BANK's (§9.10), like everything that
 * computes: an owner's correction must not be able to move money between months or make a link valid. The owner's
 * classifications — each leg's kind (§43) and the purchase's category — are what the readers count by, so they are what
 * this rule consults, through the very same `treatmentOf` month.ts and income.ts use. A link is therefore accepted
 * exactly when it will subtract something, and the owner is never allowed to make one that silently does nothing.
 */
function whyNot(positive: TransactionRow, spend: TransactionRow, c: Classified): string | null {
  if (positive.deletedAt !== null) return 'That payment has been deleted, so it cannot be linked. Restore it first if you want to.'
  if (spend.deletedAt !== null) return 'That purchase has been deleted, so a refund cannot be linked to it. Restore it first if you want to.'
  if (positive.amountCents <= 0) return 'Only money that arrived in your account can be a refund.'
  // income.ts counts a row as income by its resolved kind. A positive it never counted cannot be taken out of it, and
  // linking one would still subtract from the purchase's category: money removed from spending that was never income.
  if (c.positiveKind !== 'income') return 'This is money moving between your own accounts, not money earned, so it is not counted as income and cannot be a refund.'
  if (spend.amountCents >= 0) return 'A refund can only be linked to a purchase, which is money that went out.'
  if (treatmentOf(c.spendKind, c.categoryKind) !== 'spending') {
    return 'A refund can only be linked to a purchase the budget counts as spending. That one is a transfer, a round-up or money in, or it is in a category for transfers, income or savings, so linking this payment to it would change nothing.'
  }
  const days = daysBetween(spend.valueDate, positive.valueDate)
  if (days < 0) {
    return `The bank dates that purchase (${formatSpanishDate(spend.valueDate)}) after this payment (${formatSpanishDate(positive.valueDate)}), and a refund cannot come before the purchase it returns. Choose a purchase from the same day or earlier.${BANK_DATES}`
  }
  if (days > REFUND_WINDOW_DAYS) {
    return `The bank dates that purchase (${formatSpanishDate(spend.valueDate)}) ${days} days before this payment (${formatSpanishDate(positive.valueDate)}). Refunds are linked only to purchases from the previous ${REFUND_WINDOW_DAYS} days.${BANK_DATES}`
  }
  return null
}

/**
 * Money that arrived in `month` and is counted as income: live, money in, resolved kind 'income', and not withheld from income by
 * a transfer row. A leg of an internal or round-up row is withheld; a refund link withholds its positive only when
 * refundSubtraction (income.ts) says it subtracts, so a link that is live yet inert still lists the payment, because
 * income still counts it. Offered so any refunds among it can be linked; an ordinary salary is in it every month.
 * Read-only: it must never change a figure, and such a payment stays income (§10) until the owner links it.
 */
export async function unconfirmedPositives(month: string): Promise<ResolvedTransaction[]> {
  if (!MONTH_RE.test(month)) throw new Error(`Invalid month, expected YYYY-MM: ${month}`)
  // Bounded (spec 39.4): two index-only key reads, intersected, so a row is read only if it IS a candidate. The month
  // and the sign are the bank's, the same facts income.ts counts on; the kind is then taken from the resolved row
  // below, as income.ts takes it (§43). Links are read only for the candidates, and the subtraction rule is
  // income.ts's own, so this lists what is in the income figure, bar the gap noted below.
  // Soft-deleted rows are dropped after the read, as liveTransactionsBetween does.
  const [incomeKeys, monthKeys] = await Promise.all([
    db.transactions.where('kind').equals('income').primaryKeys(),
    db.transactions.where('valueDate').between(`${month}-01`, nextMonthStart(month), true, false).primaryKeys(),
  ])
  const [small, large] = incomeKeys.length <= monthKeys.length ? [incomeKeys, new Set(monthKeys)] : [monthKeys, new Set(incomeKeys)]
  const candidates = (await db.transactions.bulkGet(small.filter((k) => large.has(k)) as string[]))
    .filter((t): t is TransactionRow => t !== undefined && t.deletedAt === null && t.amountCents > 0 && t.kind === 'income')
  const touching = await transfersTouching(candidates.map((t) => t.id))
  const withheld = new Set(touching.filter((t) => t.linkKind !== 'refund').flatMap((t) => [t.outTransactionId, t.inTransactionId]))
  const legs = new Map(candidates.map((t) => [t.id, t]))
  const otherLegs = [...new Set(touching.flatMap((t) => [t.outTransactionId, t.inTransactionId]))].filter((id) => !legs.has(id))
  for (const t of await db.transactions.bulkGet(otherLegs)) if (t) legs.set(t.id, t)
  for (const s of await refundSubtractions(touching, legs)) withheld.add(s.refundId)
  const live = candidates.filter((t) => !withheld.has(t.id))
  // §43: income is the RESOLVED kind, so a positive the owner re-kinded has left the income figure and must not be
  // offered here — whyNot would refuse it anyway, and listing it would invite a link that moves nothing.
  // The known gap, stated rather than hidden: the reverse case, a row the bank filed as something else and the owner
  // re-kinded TO income, is counted by income.ts but is not listed here, because the bounded read above is an index
  // read on the BANK's kind (spec 39.4) and `annotations.typeOverride` has no index to intersect with (§29 is shut).
  // Such a payment can still be linked from its own editor, which goes through refundCandidates and asks the resolved
  // kind like everything else; only this queue misses it.
  return (await resolveMany(live)).filter((r) => r.kind === 'income').sort(newestFirst)
}

/**
 * Link money received to the purchase it returned. Writes the row the rest of the app already reads: the spend in
 * `outTransactionId` (money out) and the refund in `inTransactionId` (money in), as pairAcrossAccounts does.
 * The check and the write share one transaction, so two quick taps cannot both link the same payment.
 */
export async function linkRefund(positiveId: string, spendId: string): Promise<TransferRow> {
  return db.transaction('rw', stores(), async () => {
    const [positive, spend, linked] = await Promise.all([db.transactions.get(positiveId), db.transactions.get(spendId), linkedAmong([positiveId, spendId])])
    if (!positive || !spend) throw new Error('One of those transactions could not be found. Nothing was linked.')
    if (linked.has(positive.id)) {
      throw new Error(linked.get(positive.id)?.linkKind === 'refund'
        ? 'This payment is already linked to a purchase. Unlink it first if you want to link it to a different one.'
        : 'This payment is already part of a transfer between your accounts, so it cannot also be a refund.')
    }
    // One resolve for both legs: the kinds the readers count by, and the purchase's category. Dates, amounts and signs
    // stay on `positive` and `spend`, the bank's own rows.
    const [rPositive, rSpend] = await resolveMany([positive, spend])
    const problem = whyNot(positive, spend, {
      positiveKind: rPositive?.kind ?? positive.kind,
      spendKind: rSpend?.kind ?? spend.kind,
      categoryKind: await categoryKindFor(rSpend?.categoryId ?? null),
    })
    if (problem) throw new Error(problem)
    if (linked.has(spend.id) && linked.get(spend.id)?.linkKind !== 'refund') {
      throw new Error('That purchase is already part of a transfer, so a refund cannot be linked to it.')
    }
    const row: TransferRow = {
      id: crypto.randomUUID(), outTransactionId: spend.id, inTransactionId: positive.id,
      amountCents: positive.amountCents, matchScore: 100, confirmedByUser: true, matchedAt: Date.now(), linkKind: 'refund',
    }
    await db.transfers.add(row)
    return row
  })
}

/** Remove a refund link. The payment goes back to counting as income; nothing else is touched. */
export async function unlinkRefund(transferId: string): Promise<void> {
  await db.transaction('rw', db.transfers, async () => {
    const row = await db.transfers.get(transferId)
    if (!row) throw new Error('That link no longer exists. Nothing was changed.')
    // Never delete an internal transfer or a round-up through here: those are matched by the importer.
    if (row.linkKind !== 'refund') throw new Error('That is a transfer between your accounts, not a refund link, so it was left alone.')
    await db.transfers.delete(transferId)
  })
}

/**
 * Purchases the owner can choose from for `positiveId`, newest first. Exactly those `linkRefund` would accept: the
 * positive's own eligibility (kind, sign) lives only in `whyNot`, which refuses every purchase for an ineligible one.
 */
export async function refundCandidates(positiveId: string): Promise<ResolvedTransaction[]> {
  const positive = await db.transactions.get(positiveId)
  if (!positive || positive.deletedAt !== null || positive.amountCents <= 0) return []
  if ((await linkedAmong([positive.id])).has(positive.id)) return []
  // Only the 90 days before the payment can qualify, so read just those months; whyNot then applies the exact day rule.
  const near = await liveTransactionsBetween(monthKeyOf(addDays(positive.valueDate, -REFUND_WINDOW_DAYS)), monthKeyOf(positive.valueDate))
  const linked = await linkedAmong(near.map((t) => t.id))
  const rawSpends = new Map(near.filter((t) => t.amountCents < 0).map((t) => [t.id, t]))
  const spends = await resolveMany([...rawSpends.values()])
  const kinds = new Map((await db.categories.toArray()).map((c) => [c.id, c.kind]))
  // The positive's own resolved kind: the owner may have said this arrival is not income, and then it is not a refund.
  const positiveKind = (await resolveMany([positive]))[0]?.kind ?? positive.kind
  return spends
    .filter((s) => {
      const raw = rawSpends.get(s.id)
      return raw !== undefined && !(linked.has(s.id) && linked.get(s.id)?.linkKind !== 'refund') && whyNot(positive, raw, {
        positiveKind, spendKind: s.kind, categoryKind: s.categoryId === null ? null : kinds.get(s.categoryId) ?? null,
      }) === null
    })
    .sort(newestFirst)
}

export interface RefundContext {
  /** Set when this transaction is a refund: the link and the purchase it returned. */
  refundOf: { transferId: string; spend: ResolvedTransaction } | null
  /** Set when this transaction is a purchase that has been refunded, once per refund. */
  refundedBy: { transferId: string; refund: ResolvedTransaction }[]
  /** Purchases this payment could be linked to; empty unless it is an unlinked payment received. */
  candidates: ResolvedTransaction[]
}

/** What the editor needs to show for one transaction. Read-only. */
export async function refundContext(id: string): Promise<RefundContext> {
  const links = (await transfersTouching([id])).filter((t) => t.linkKind === 'refund')
  const otherIds = links.map((t) => (t.outTransactionId === id ? t.inTransactionId : t.outTransactionId))
  // Deleted legs are kept: the link is paused while one is deleted, and the owner must still be able to see and undo it.
  const found = (await db.transactions.bulkGet(otherIds)).filter((r): r is TransactionRow => r !== undefined)
  const others = new Map((await resolveMany(found)).map((r) => [r.id, r]))
  let refundOf: RefundContext['refundOf'] = null
  const refundedBy: RefundContext['refundedBy'] = []
  for (const t of links) {
    if (t.inTransactionId === id) {
      const spend = others.get(t.outTransactionId)
      if (spend) refundOf = { transferId: t.id, spend }
    } else {
      const refund = others.get(t.inTransactionId)
      if (refund) refundedBy.push({ transferId: t.id, refund })
    }
  }
  return { refundOf, refundedBy, candidates: await refundCandidates(id) }
}
