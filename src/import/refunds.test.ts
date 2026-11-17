import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../db/db'
import { seedDatabase } from '../db/seed'
import type { TransactionRow, TransferRow } from '../db/schema'
import { excludedTransactionIds, netIncome } from '../analysis/income'
import { monthlyBudget } from '../budget/month'
import { transactionRowReads } from '../test/reads'
import { linkRefund, refundCandidates, refundContext, unconfirmedPositives, unlinkRefund } from './refunds'

let uid = 0
const GROCERIES: [string, string] = ['Alimentación', 'Supermercados y alimentación']
const NOV = '2026-11'

const tx = async (
  id: string, valueDate: string, amountCents: number, over: Partial<TransactionRow> = {},
): Promise<void> => {
  await db.transactions.add({
    id, accountId: 'acc.1', valueDate, amountCents, balanceCents: 0, description: `Invented ${id}`, comment: null,
    ingCategory: GROCERIES[0], ingSubcategory: GROCERIES[1], kind: amountCents > 0 ? 'income' : 'spend',
    dedupKey: `k.${++uid}`, importId: 'imp.1', fileSeq: uid, roundupParentId: null, createdAt: 1, deletedAt: null, ...over,
  })
}

const transferRows = (): Promise<TransferRow[]> => db.transfers.toArray()
const groceries = async (month = NOV) =>
  (await monthlyBudget(month, '2026-12-05')).lines.find((l) => l.targetId === 'cat.groceries')?.spentCents

beforeEach(async () => {
  uid = 0
  await db.delete(); await db.open(); await seedDatabase()
})

describe('linkRefund', () => {
  it('links a positive to an earlier spend as linkKind refund', async () => {
    await tx('pay', '2026-11-01', 200000)
    await tx('buy', '2026-11-05', -10000)
    await tx('ref', '2026-11-20', 2500)
    const row = await linkRefund('ref', 'buy')
    expect(await transferRows()).toEqual([row])
    expect(row).toMatchObject({
      linkKind: 'refund', confirmedByUser: true, matchScore: 100, amountCents: 2500,
      // The convention pairAcrossAccounts uses: money out, money in. Income.ts reads by sign and would not notice
      // a row written backwards, so it is pinned here, on the stored row and on the legs' signs.
      outTransactionId: 'buy', inTransactionId: 'ref',
    })
    expect((await db.transactions.get(row.outTransactionId))?.amountCents).toBeLessThan(0)
    expect((await db.transactions.get(row.inTransactionId))?.amountCents).toBeGreaterThan(0)
    expect(typeof row.id).toBe('string')
    expect(row.matchedAt).toBeGreaterThan(0)
  })

  it('writes the shape the income and budget readers already act on', async () => {
    await tx('pay', '2026-11-01', 200000)
    await tx('buy', '2026-11-05', -10000)
    await tx('ref', '2026-11-20', 2500)
    expect((await netIncome(NOV)).cents).toBe(202500)
    expect(await groceries()).toBe(10000)
    await linkRefund('ref', 'buy')
    expect((await netIncome(NOV)).cents).toBe(200000) // the refund is no longer income
    const excluded = await excludedTransactionIds(NOV)
    expect(excluded.has('ref')).toBe(true)
    expect(excluded.has('buy')).toBe(false) // the purchase stays a purchase
    expect(await groceries()).toBe(7500) // and its category bears only what was finally spent
  })

  it('allows the same day and exactly 90 days earlier', async () => {
    await tx('same', '2026-11-20', -1000)
    await tx('old', '2026-08-22', -1000) // 90 days before 2026-11-20
    await tx('r1', '2026-11-20', 500)
    await tx('r2', '2026-11-20', 500)
    await expect(linkRefund('r1', 'same')).resolves.toMatchObject({ outTransactionId: 'same' })
    await expect(linkRefund('r2', 'old')).resolves.toMatchObject({ outTransactionId: 'old' })
  })

  it('refuses a link to a later transaction', async () => {
    await tx('ref', '2026-11-10', 2500)
    await tx('later', '2026-11-12', -10000)
    await expect(linkRefund('ref', 'later')).rejects.toThrow(/after this payment.*cannot come before the purchase.*dates the bank recorded/)
    expect(await transferRows()).toEqual([])
  })

  it('refuses a link to a spend more than 90 days earlier', async () => {
    await tx('ref', '2026-11-20', 2500)
    await tx('old', '2026-08-21', -10000) // 91 days
    await expect(linkRefund('ref', 'old')).rejects.toThrow(/21\/08\/2026\) 91 days before this payment \(20\/11\/2026\).*dates the bank recorded/)
    expect(await transferRows()).toEqual([])
  })

  it('refuses a second link for an already-linked positive', async () => {
    await tx('ref', '2026-11-20', 2500)
    await tx('a', '2026-11-05', -10000)
    await tx('b', '2026-11-06', -4000)
    await linkRefund('ref', 'a')
    await expect(linkRefund('ref', 'b')).rejects.toThrow(/already linked to a purchase/)
    expect(await transferRows()).toHaveLength(1)
  })

  it('refuses a positive that is a leg of an internal transfer, and a spend that is one', async () => {
    await tx('in', '2026-11-10', 5000, { kind: 'internal', accountId: 'acc.2' })
    await tx('out', '2026-11-10', -5000, { kind: 'internal' })
    await tx('buy', '2026-11-05', -3000)
    await tx('ref', '2026-11-12', 1000)
    await db.transfers.add({ id: 't', outTransactionId: 'out', inTransactionId: 'in', amountCents: 5000, matchScore: 90, confirmedByUser: false, matchedAt: 1 })
    await expect(linkRefund('in', 'buy')).rejects.toThrow(/transfer between your accounts/)
    await expect(linkRefund('ref', 'out')).rejects.toThrow(/purchase/)
    expect(await transferRows()).toHaveLength(1)
  })

  it('refuses a soft-deleted transaction on either side', async () => {
    await tx('ref', '2026-11-20', 2500)
    await tx('gone-ref', '2026-11-20', 2500, { deletedAt: 5 })
    await tx('buy', '2026-11-05', -10000)
    await tx('gone-buy', '2026-11-05', -10000, { deletedAt: 5 })
    await expect(linkRefund('ref', 'gone-buy')).rejects.toThrow(/deleted/)
    await expect(linkRefund('gone-ref', 'buy')).rejects.toThrow(/deleted/)
    expect(await transferRows()).toEqual([])
  })

  it('refuses money going out as the refund, and money coming in as the purchase', async () => {
    await tx('a', '2026-11-05', -1000)
    await tx('b', '2026-11-06', -1000)
    await tx('p', '2026-11-04', 1000)
    await expect(linkRefund('b', 'a')).rejects.toThrow(/money that arrived/)
    await expect(linkRefund('p', 'p')).rejects.toThrow(/purchase/)
    await expect(linkRefund('p', 'nope')).rejects.toThrow(/could not be found/)
    expect(await transferRows()).toEqual([])
  })

  it("judges the bank's dates, never a correction the owner made", async () => {
    const override = (transactionId: string, dateOverride: string) => db.annotations.add({
      transactionId, categoryId: null, subcategoryId: null, merchantId: null, typeOverride: null, paymentMethod: null, note: null,
      moodId: null, purchaseReasonId: null, worthwhile: null, reviewed: false, dateOverride, amountCentsOverride: null,
      descriptionOverride: null, updatedAt: 1,
    })
    await tx('ref', '2026-11-10', 2500)
    await tx('buy', '2026-11-05', -10000)
    await tx('later', '2026-11-12', -10000)
    await tx('old', '2026-07-01', -10000)
    // Moving a purchase after the refund on screen does not make it a later purchase: the bank dated it earlier.
    await override('buy', '2026-11-15')
    await expect(linkRefund('ref', 'buy')).resolves.toMatchObject({ outTransactionId: 'buy' })
    await unlinkRefund((await transferRows())[0]?.id ?? '')
    // And correcting a later purchase to look earlier does not make it valid.
    await override('later', '2026-11-01')
    await expect(linkRefund('ref', 'later')).rejects.toThrow(/12\/11\/2026/)
    // The same for the 90 days: the bank's 132 days stand, whatever the screen says.
    await override('old', '2026-11-01')
    await expect(linkRefund('ref', 'old')).rejects.toThrow(/01\/07\/2026\) 132 days before/)
    expect((await refundCandidates('ref')).map((t) => t.id)).toEqual(['buy'])
  })

})

describe('only money income counted can be a refund', () => {
  it.each(['internal', 'roundup'] as const)('refuses a lone %s positive and never offers it', async (kind) => {
    await tx('buy', '2026-11-05', -10000)
    await tx('lone', '2026-11-10', 700, { kind })
    await expect(linkRefund('lone', 'buy')).rejects.toThrow(/between your own accounts.*not counted as income/)
    expect(await refundCandidates('lone')).toEqual([])
    expect((await refundContext('lone')).candidates).toEqual([])
    expect(await transferRows()).toEqual([])
    expect(await groceries()).toBe(10000) // and nothing was taken off the purchase's category
  })
})

describe('the amount taken off income is the amount taken off the category', () => {
  const annotateOverride = (transactionId: string, over: object) => db.annotations.add({
    transactionId, categoryId: null, subcategoryId: null, merchantId: null, typeOverride: null, paymentMethod: null, note: null,
    moodId: null, purchaseReasonId: null, worthwhile: null, reviewed: false, dateOverride: null, amountCentsOverride: null,
    descriptionOverride: null, updatedAt: 1, ...over,
  })

  it("uses the bank's amount for the refund, even when the owner corrected it (§41)", async () => {
    await tx('pay', '2026-11-01', 200000)
    await tx('buy', '2026-11-05', -10000)
    await tx('ref', '2026-11-20', 2500)
    await annotateOverride('ref', { amountCentsOverride: 9999 })
    const before = { income: (await netIncome(NOV)).cents, groceries: await groceries() }
    await linkRefund('ref', 'buy')
    const after = { income: (await netIncome(NOV)).cents, groceries: await groceries() }
    expect(before.income - after.income).toBe(2500)
    expect((before.groceries ?? 0) - (after.groceries ?? 0)).toBe(2500)
  })

  // The invariant this whole describe is named for: whatever leaves income through a link is exactly what leaves a
  // category. Every case below checks both numbers, because checking one is how a hole between them goes unseen.
  const linkedDeltas = async (refundId: string, originalId: string) => {
    const before = { income: (await netIncome(NOV)).cents, spent: (await monthlyBudget(NOV, '2026-12-05')).totals.spentCents }
    await linkRefund(refundId, originalId)
    const after = { income: (await netIncome(NOV)).cents, spent: (await monthlyBudget(NOV, '2026-12-05')).totals.spentCents }
    return { fromIncome: before.income - after.income, fromSpending: before.spent - after.spent }
  }

  it('does not lose the money when the owner flips the refund negative', async () => {
    await tx('pay', '2026-11-01', 200000)
    await tx('buy', '2026-11-05', -10000)
    await tx('ref', '2026-11-20', 2500)
    await annotateOverride('ref', { amountCentsOverride: -2500 })
    expect(await linkedDeltas('ref', 'buy')).toEqual({ fromIncome: 2500, fromSpending: 2500 })
    expect((await netIncome(NOV)).cents).toBe(200000) // 200000: the positive left income
    expect(await groceries()).toBe(7500)
  })

  it("keeps a purchase the owner re-kinded counted, because the kind is the bank's (§41), and the refund still moves both", async () => {
    await tx('pay', '2026-11-01', 200000)
    await tx('buy', '2026-11-05', -10000)
    await tx('ref', '2026-11-20', 2500)
    await linkRefund('ref', 'buy')
    await annotateOverride('buy', { typeOverride: 'internal' }) // after the link: the reviewed month must not move
    expect((await netIncome(NOV)).cents).toBe(200000)
    expect(await groceries()).toBe(7500)
  })

  const handMade = (out: string, inn: string) => db.transfers.add({
    id: 'hand', outTransactionId: out, inTransactionId: inn, amountCents: 2500, matchScore: 100, confirmedByUser: true, matchedAt: 1, linkKind: 'refund',
  })

  it.each(['internal', 'income', 'savings'] as const)('refuses to link a purchase filed under a category of kind %s, and a restored link to one moves neither figure', async (categoryKind) => {
    const categoryId = 'cat.shopping'
    await db.categories.update(categoryId, { kind: categoryKind })
    await tx('pay', '2026-11-01', 200000)
    await tx('buy', '2026-11-05', -10000)
    await tx('ref', '2026-11-20', 2500)
    await annotateOverride('buy', { categoryId })
    await expect(linkRefund('ref', 'buy')).rejects.toThrow(/purchase the budget counts as spending/)
    expect((await refundCandidates('ref')).map((t) => t.id)).toEqual([]) // and it is never offered
    expect(await transferRows()).toEqual([])
    // A hand-made or restored row can still exist; the readers must then agree that it does nothing.
    await handMade('buy', 'ref')
    expect((await netIncome(NOV)).cents).toBe(202500) // the 2.500 stays income: it is in no category either
    expect(await groceries()).toBeUndefined() // no line at all, certainly no negative one
  })

  it('refuses to link a purchase the bank did not file as spending, and a restored link to one moves neither figure', async () => {
    await tx('pay', '2026-11-01', 200000)
    await tx('buy', '2026-11-05', -10000, { kind: 'internal' })
    await tx('ref', '2026-11-20', 2500)
    await expect(linkRefund('ref', 'buy')).rejects.toThrow(/purchase the budget counts as spending/)
    expect(await transferRows()).toEqual([])
    await handMade('buy', 'ref')
    expect((await netIncome(NOV)).cents).toBe(202500) // the positive stays income
    expect((await monthlyBudget(NOV, '2026-12-05')).totals.spentCents).toBe(0) // and nothing was taken off anything
  })

  it('accepts a purchase the owner re-kinded, because the bank kind decides, and both figures move together', async () => {
    await tx('pay', '2026-11-01', 200000)
    await tx('buy', '2026-11-05', -10000)
    await tx('ref', '2026-11-20', 2500)
    await annotateOverride('buy', { typeOverride: 'internal' })
    expect(await linkedDeltas('ref', 'buy')).toEqual({ fromIncome: 2500, fromSpending: 2500 })
  })
})

describe('unconfirmedPositives', () => {
  it('flags an unconfirmed positive that is not a known transfer leg', async () => {
    await tx('maybe', '2026-11-09', 4200)
    await tx('other-month', '2026-10-09', 4200)
    await tx('deleted', '2026-11-09', 4200, { deletedAt: 5 })
    await tx('spend', '2026-11-09', -4200)
    await tx('lone-internal', '2026-11-09', 700, { kind: 'internal' }) // not income, so not offered as a possible refund
    await tx('t-in', '2026-11-11', 50000, { accountId: 'acc.2', kind: 'internal' })
    await tx('t-out', '2026-11-11', -50000, { kind: 'internal' })
    await db.transfers.add({ id: 't', outTransactionId: 't-out', inTransactionId: 't-in', amountCents: 50000, matchScore: 100, confirmedByUser: false, matchedAt: 1 })
    await tx('buy', '2026-11-02', -1000)
    await tx('ref', '2026-11-12', 1000)
    await linkRefund('ref', 'buy')
    expect((await unconfirmedPositives(NOV)).map((t) => t.id)).toEqual(['maybe'])
  })

  it('does not change any figure: an unconfirmed positive is still income', async () => {
    await tx('pay', '2026-11-01', 200000)
    await tx('maybe', '2026-11-09', 4200)
    const before = { income: await netIncome(NOV), excluded: await excludedTransactionIds(NOV), budget: await monthlyBudget(NOV, '2026-12-05') }
    expect((await unconfirmedPositives(NOV)).map((t) => t.id)).toEqual(['maybe', 'pay'])
    expect(await netIncome(NOV)).toEqual(before.income)
    expect(before.income.cents).toBe(204200)
    expect(await excludedTransactionIds(NOV)).toEqual(before.excluded)
    expect(await monthlyBudget(NOV, '2026-12-05')).toEqual(before.budget)
    expect(await transferRows()).toEqual([])
  })

  it('lists money by the month the bank dated it, the month the income figure uses', async () => {
    await tx('moved', '2026-11-28', 900)
    await db.annotations.add({
      transactionId: 'moved', categoryId: null, subcategoryId: null, merchantId: null, typeOverride: null, paymentMethod: null, note: null,
      moodId: null, purchaseReasonId: null, worthwhile: null, reviewed: false, dateOverride: '2026-12-02', amountCentsOverride: null,
      descriptionOverride: null, updatedAt: 1,
    })
    expect((await unconfirmedPositives(NOV)).map((t) => t.id)).toEqual(['moved'])
    expect(await unconfirmedPositives('2026-12')).toEqual([])
  })

  it('rejects a malformed month', async () => {
    await expect(unconfirmedPositives('nov')).rejects.toThrow()
  })
})

describe('a link holds only while both legs are live', () => {
  const figures = async () => ({
    income: await netIncome(NOV), excluded: await excludedTransactionIds(NOV), budget: await monthlyBudget(NOV, '2026-12-05'),
  })

  it('is inert while the spend is deleted, and returns exactly when it is restored', async () => {
    await tx('pay', '2026-11-01', 200000)
    await tx('keep', '2026-11-04', -6000) // same category, stays live throughout
    await tx('buy', '2026-11-05', -10000)
    await tx('ref', '2026-11-20', 2500)
    const unlinked = await figures()
    await linkRefund('ref', 'buy')
    const linked = await figures()
    expect(linked.income.cents).toBe(200000)
    expect(await groceries()).toBe(6000 + 10000 - 2500)

    await db.transactions.update('buy', { deletedAt: 5 })
    const paused = await figures()
    expect(paused.income.cents).toBe(202500) // the refund counts as income again: never counted nowhere
    expect(paused.excluded.has('ref')).toBe(false)
    expect(await groceries()).toBe(6000) // and nothing is subtracted from any category
    expect(paused.budget.totals.spentCents).toBe(6000)
    expect(await transferRows()).toHaveLength(1) // nothing was destroyed

    // Both legs deleted: inert too, and the figures are those of neither leg existing.
    await db.transactions.update('ref', { deletedAt: 5 })
    const both = await figures()
    expect(both.income.cents).toBe(200000)
    expect(await groceries()).toBe(6000)
    await db.transactions.update('ref', { deletedAt: null })
    await db.transactions.update('buy', { deletedAt: null })
    expect(await figures()).toEqual(linked)
    expect(linked).not.toEqual(unlinked)
  })

  it('is inert while the refund is deleted, and returns when it is restored', async () => {
    await tx('pay', '2026-11-01', 200000)
    await tx('buy', '2026-11-05', -10000)
    await tx('ref', '2026-11-20', 2500)
    await linkRefund('ref', 'buy')
    const linked = await figures()
    await db.transactions.update('ref', { deletedAt: 5 })
    expect((await figures()).income.cents).toBe(200000)
    expect(await groceries()).toBe(10000) // the deleted refund subtracts nothing
    await db.transactions.update('ref', { deletedAt: null })
    expect(await figures()).toEqual(linked)
  })

  it('can still be unlinked from the refund side while the spend is deleted', async () => {
    await tx('ref', '2026-11-20', 2500)
    await tx('buy', '2026-11-05', -10000)
    const row = await linkRefund('ref', 'buy')
    await db.transactions.update('buy', { deletedAt: 5 })
    const ctx = await refundContext('ref')
    expect(ctx.refundOf).toMatchObject({ transferId: row.id, spend: { id: 'buy', deletedAt: 5 } })
    await unlinkRefund(ctx.refundOf?.transferId ?? '')
    expect(await transferRows()).toEqual([])
  })
})

describe('unlinkRefund', () => {
  it('removes the link and restores the positive to income', async () => {
    await tx('pay', '2026-11-01', 200000)
    await tx('buy', '2026-11-05', -10000)
    await tx('ref', '2026-11-20', 2500)
    const before = { income: await netIncome(NOV), excluded: await excludedTransactionIds(NOV), budget: await monthlyBudget(NOV, '2026-12-05') }
    const row = await linkRefund('ref', 'buy')
    expect(await netIncome(NOV)).not.toEqual(before.income)
    await unlinkRefund(row.id)
    expect(await transferRows()).toEqual([])
    expect(await netIncome(NOV)).toEqual(before.income)
    expect(await excludedTransactionIds(NOV)).toEqual(before.excluded)
    expect(await monthlyBudget(NOV, '2026-12-05')).toEqual(before.budget)
    expect((await unconfirmedPositives(NOV)).map((t) => t.id)).toContain('ref')
    // and it can be linked again
    await expect(linkRefund('ref', 'buy')).resolves.toMatchObject({ linkKind: 'refund' })
  })

  it('leaves an internal transfer alone, and says so when the link is gone', async () => {
    await tx('o', '2026-11-10', -500, { kind: 'internal' })
    await tx('i', '2026-11-10', 500, { kind: 'internal', accountId: 'acc.2' })
    await db.transfers.add({ id: 't', outTransactionId: 'o', inTransactionId: 'i', amountCents: 500, matchScore: 100, confirmedByUser: false, matchedAt: 1 })
    await expect(unlinkRefund('t')).rejects.toThrow(/not a refund link/)
    expect(await transferRows()).toHaveLength(1)
    await expect(unlinkRefund('missing')).rejects.toThrow(/no longer exists/)
  })
})

describe('what the screen is offered', () => {
  it('offers exactly the purchases linkRefund would accept', async () => {
    await tx('ref', '2026-11-20', 2500)
    await tx('ok1', '2026-11-19', -100)
    await tx('ok2', '2026-08-22', -100)
    await tx('too-old', '2026-08-21', -100)
    await tx('later', '2026-11-21', -100)
    await tx('gone', '2026-11-10', -100, { deletedAt: 5 })
    await tx('income', '2026-11-10', 100)
    expect((await refundCandidates('ref')).map((t) => t.id)).toEqual(['ok1', 'ok2'])
    for (const id of ['ok1', 'ok2']) await expect(linkRefund('ref', id).finally(() => db.transfers.clear())).resolves.toBeDefined()
    for (const id of ['too-old', 'later', 'gone', 'income']) await expect(linkRefund('ref', id)).rejects.toThrow()
  })

  it('describes a link from either side, and offers nothing once linked', async () => {
    await tx('ref', '2026-11-20', 2500)
    await tx('buy', '2026-11-05', -10000)
    const row = await linkRefund('ref', 'buy')
    const asRefund = await refundContext('ref')
    expect(asRefund.refundOf).toMatchObject({ transferId: row.id, spend: { id: 'buy' } })
    expect(asRefund.candidates).toEqual([])
    const asSpend = await refundContext('buy')
    expect(asSpend.refundedBy).toMatchObject([{ transferId: row.id, refund: { id: 'ref' } }])
    expect(asSpend.refundOf).toBeNull()
  })
})

describe('what refund reads cost (spec 39.4)', () => {
  it('unconfirmedPositives reads only the rows that are candidates, not the month or the ledger', async () => {
    for (let i = 0; i < 120; i++) await tx(`spend${i}`, `2026-${i % 2 ? '10' : '11'}-${String((i % 27) + 1).padStart(2, '0')}`, -500)
    await tx('pay', '2026-11-01', 200000)
    await tx('old.pay', '2026-10-01', 200000)
    await tx('in.pay', '2026-11-02', 4000, { kind: 'internal' }) // not income: never a candidate
    await tx('ref', '2026-11-20', 1500)
    await db.transfers.add({ id: 'tr.x', outTransactionId: 'spend0', inTransactionId: 'ref', amountCents: 1500, matchScore: 100, confirmedByUser: true, matchedAt: 1, linkKind: 'refund' })
    let ids: string[] = []
    const reads = await transactionRowReads(async () => { ids = (await unconfirmedPositives(NOV)).map((t) => t.id) })
    expect(ids).toEqual(['pay']) // ref is linked, old.pay is October, in.pay is not income
    expect(reads).toBeLessThanOrEqual(4) // pay, ref, and a margin for the resolve step; the ledger holds 124 rows
  })

  it('still lists a positive whose refund link is live but inert, because income still counts it', async () => {
    await tx('buy', '2026-11-05', -10000)
    await tx('ref', '2026-11-20', 2500)
    await linkRefund('ref', 'buy')
    expect((await unconfirmedPositives(NOV)).map((t) => t.id)).not.toContain('ref') // the link moves money
    await db.annotations.add({
      transactionId: 'buy', categoryId: 'cat.roundup', subcategoryId: null, merchantId: null, typeOverride: null,
      paymentMethod: null, note: null, moodId: null, purchaseReasonId: null, worthwhile: null, reviewed: false,
      dateOverride: null, amountCentsOverride: null, descriptionOverride: null, updatedAt: 1,
    }) // re-filed as savings: the link no longer subtracts anything
    expect((await unconfirmedPositives(NOV)).map((t) => t.id)).toEqual(['ref'])
  })

  it('refundContext still lists every refund of a purchase refunded twice', async () => {
    await tx('buy', '2026-11-05', -10000)
    await tx('r1', '2026-11-10', 2000)
    await tx('r2', '2026-11-12', 3000)
    await linkRefund('r1', 'buy')
    await linkRefund('r2', 'buy')
    const context = await refundContext('buy')
    expect(context.refundedBy.map((r) => r.refund.id).sort()).toEqual(['r1', 'r2'])
  })

  it('names refund dates the way the owner reads them', async () => {
    await tx('buy', '2026-11-20', -10000)
    await tx('early', '2026-11-05', 2000)
    await expect(linkRefund('early', 'buy')).rejects.toThrow(/20\/11\/2026.*05\/11\/2026/)
    await tx('ancient', '2026-01-02', -500)
    await tx('late', '2026-11-30', 100)
    await expect(linkRefund('late', 'ancient')).rejects.toThrow(/02\/01\/2026.*30\/11\/2026/)
  })
})
