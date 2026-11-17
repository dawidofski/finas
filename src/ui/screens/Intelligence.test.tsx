import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import Intelligence, { MIN_ANSWERED, MIN_REGRETTED, isFinding } from './Intelligence'
import { db } from '../../db/db'
import { seedDatabase } from '../../db/seed'
import { writeAnnotation } from '../../db/annotations'
import { formatEur } from '../../lib/money'
import type { AnnotationRow, TransactionRow } from '../../db/schema'

const TODAY = '2026-11-17' // a Tuesday
// 05/03/2026, deliberately not the month of TODAY and with a day that cannot be read as a month.
const TAUGHT_AT = Date.UTC(2026, 2, 5, 12)

const tx = (id: string, over: Partial<TransactionRow> = {}): TransactionRow => ({
  id, accountId: 'acc', valueDate: '2026-11-17', amountCents: -1000, balanceCents: 50000, description: `SHOP ${id}`, comment: null,
  ingCategory: null, ingSubcategory: null, kind: 'spend', dedupKey: `K${id}`, importId: 'imp', fileSeq: 1, roundupParentId: null,
  createdAt: 1, deletedAt: null, ...over,
})
const ann = (transactionId: string, over: Partial<AnnotationRow> = {}): AnnotationRow => ({
  transactionId, categoryId: null, subcategoryId: null, merchantId: null, typeOverride: null, paymentMethod: null,
  note: null, moodId: null, purchaseReasonId: null, worthwhile: null, reviewed: false, dateOverride: null,
  amountCentsOverride: null, descriptionOverride: null, updatedAt: 1, ...over,
})
const merchant = (id: string, canonicalName: string) =>
  db.merchants.add({ id, canonicalName, kind: 'merchant', matchPatterns: [], defaultCategoryId: null, isSubscription: false, createdAt: 1 })

/** Corrections through the real write path, so the screen and memory.ts are tested against each other. */
let clock = 0
const correct = async (id: string, merchantId: string, categoryId: string) => {
  await db.transactions.add(tx(id))
  await writeAnnotation(id, { categoryId, merchantId }, 'owner')
}

/** Spends on one day, answered worthwhile or not, all attached to one merchant and category. */
async function answered(prefix: string, answers: boolean[], over: Partial<AnnotationRow> = {}, day = '2026-11-17') {
  const ids = answers.map((_, i) => `${prefix}${i}`)
  await db.transactions.bulkAdd(ids.map((id) => tx(id, { valueDate: day, amountCents: -1250 })))
  await db.annotations.bulkAdd(ids.map((id, i) => ann(id, { worthwhile: answers[i]!, ...over })))
}

const settled = async () => {
  await waitFor(() => expect(screen.queryByText(/Loading/)).not.toBeInTheDocument())
}
const pageText = () => document.body.textContent ?? ''

beforeEach(async () => {
  vi.restoreAllMocks()
  await db.delete(); await db.open(); await seedDatabase()
  clock = TAUGHT_AT
  vi.spyOn(Date, 'now').mockImplementation(() => (clock += 10))
})
afterEach(() => { vi.restoreAllMocks() })

describe('Intelligence screen: what has been learned', () => {
  it('says what was learned per merchant, with the number of corrections behind it, and what is still short', async () => {
    await merchant('m1', 'Mercadona'); await merchant('m2', 'Zara')
    await correct('a', 'm1', 'cat.groceries'); await correct('b', 'm1', 'cat.groceries'); await correct('c', 'm1', 'cat.groceries')
    await correct('d', 'm2', 'cat.shopping')
    render(<Intelligence today={TODAY} />)
    await settled()
    const learned = within(await screen.findByRole('list', { name: 'Learned merchants' })).getAllByRole('listitem')
    expect(learned).toHaveLength(1)
    expect(learned[0]).toHaveTextContent(/Mercadona: .*Corrected 3 times/)
    const groceries = (await db.categories.get('cat.groceries'))!.name
    expect(learned[0]).toHaveTextContent(groceries)
    const pending = within(screen.getByRole('list', { name: 'Merchants still being learned' })).getAllByRole('listitem')
    expect(pending).toHaveLength(1)
    expect(pending[0]).toHaveTextContent(/Zara: .*Corrected once; 1 more of the same correction/)
    // Something is learned, so the "nothing learned" message must not be shown beside it.
    expect(screen.queryByText(/Nothing learned yet/)).not.toBeInTheDocument()
  })

  it('says plainly that it has learned nothing yet, rather than showing an empty table', async () => {
    render(<Intelligence today={TODAY} />)
    await settled()
    expect(screen.getByText(/Nothing learned yet/)).toHaveTextContent(/corrected it the same way twice/)
    expect(screen.getByText(/have not corrected any merchant/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Transactions' })).toHaveAttribute('href', '#/transactions')
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'Learned merchants' })).not.toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'Merchants still being learned' })).not.toBeInTheDocument()
  })

  it('still says nothing is learned when every merchant has only one correction, and says how many are one short', async () => {
    await merchant('m1', 'Zara')
    await correct('a', 'm1', 'cat.shopping')
    render(<Intelligence today={TODAY} />)
    await settled()
    expect(screen.getByText(/Nothing learned yet/)).toHaveTextContent(/1 merchant has one correction so far/)
    expect(screen.queryByRole('list', { name: 'Learned merchants' })).not.toBeInTheDocument()
    expect(screen.getByRole('list', { name: 'Merchants still being learned' })).toHaveTextContent('Zara')
  })

  it('reads the merchants table once for what was learned, however many merchants there are', async () => {
    await merchant('m1', 'Mercadona'); await merchant('m2', 'Zara')
    await correct('a', 'm1', 'cat.groceries'); await correct('b', 'm1', 'cat.groceries'); await correct('c', 'm2', 'cat.shopping')
    const reads = vi.spyOn(db.merchants, 'toArray')
    render(<Intelligence today={TODAY} />)
    await settled()
    await screen.findByRole('list', { name: 'Learned merchants' })
    await waitFor(() => expect(screen.queryByText(/Loading/)).not.toBeInTheDocument())
    // Two reads in all: one here, handed to the memory, and one by regretClusters for its own labels (a separate module).
    // A screen that also let categoryMemory read the table itself would make three.
    expect(reads).toHaveBeenCalledTimes(2)
  })

  it('shows dates in Spanish format', async () => {
    await merchant('m1', 'Mercadona')
    await correct('a', 'm1', 'cat.groceries'); await correct('b', 'm1', 'cat.groceries')
    render(<Intelligence today={TODAY} />)
    await settled()
    const item = within(await screen.findByRole('list', { name: 'Learned merchants' })).getByRole('listitem')
    expect(item).toHaveTextContent('05/03/2026')
    expect(item).not.toHaveTextContent('2026-03-05')
    expect(item).not.toHaveTextContent('03/05/2026')
  })

  it('names a merchant or category that no longer exists as removed, never as a blank or an id', async () => {
    await merchant('m1', 'Gone')
    await correct('a', 'm1', 'cat.groceries'); await correct('b', 'm1', 'cat.groceries')
    await db.merchants.delete('m1'); await db.categories.delete('cat.groceries')
    render(<Intelligence today={TODAY} />)
    await settled()
    const item = within(await screen.findByRole('list', { name: 'Learned merchants' })).getByRole('listitem')
    expect(item).toHaveTextContent('Removed merchant: Removed category.')
    expect(item).not.toHaveTextContent('cat.groceries')
    expect(item).not.toHaveTextContent('m1')
  })
})

describe('Intelligence screen: purchases marked not worth it', () => {
  it('shows a group with its denominator and its period, and no causal wording', async () => {
    await merchant('m1', 'Bar Pepe')
    await answered('r', [false, false, true], { merchantId: 'm1', purchaseReasonId: 'reason.impulse', moodId: 'mood.bored' })
    render(<Intelligence today={TODAY} />)
    await settled()
    const list = await screen.findByRole('list', { name: 'Not worth it, all your records' })
    const merchantItem = within(list).getByText(/^Merchant: Bar Pepe/)
    expect(merchantItem).toHaveTextContent(`2 of 3 answered purchases marked not worth it, ${formatEur(2500)} in total (all your records)`)
    expect(within(list).getByText(/^Mood: Bored/)).toHaveTextContent('2 of 3')
    expect(within(list).getByText(/^Day of the week: martes/)).toHaveTextContent('2 of 3')
    expect(pageText()).not.toMatch(/because you|caused|makes you|leads? to|results? in|due to/i)
    expect(pageText()).not.toMatch(/\b(tier|classifier|bayesian|cluster|correlation|posterior)\b/i)
  })

  it('names the month when the period is narrowed to it, and counts only that month', async () => {
    await merchant('m1', 'Bar Pepe')
    await answered('n', [false, false, true], { merchantId: 'm1' }, '2026-11-10')
    await answered('o', [false, true, true, true], { merchantId: 'm1' }, '2026-10-10') // 1 of 4 in October
    render(<Intelligence today={TODAY} />)
    await settled()
    expect(await screen.findByText(/^Merchant: Bar Pepe/)).toHaveTextContent('3 of 7')
    fireEvent.click(screen.getByRole('button', { name: 'November 2026' }))
    const item = await screen.findByText(/^Merchant: Bar Pepe.*\(November 2026\)/)
    expect(item).toHaveTextContent('2 of 3 answered purchases')
    expect(item).toHaveTextContent(formatEur(2500))
  })

  it('does not render one regretted purchase out of one as a finding, and says what is missing instead', async () => {
    await merchant('m1', 'Bar Pepe')
    await answered('x', [false], { merchantId: 'm1', purchaseReasonId: 'reason.impulse' })
    render(<Intelligence today={TODAY} />)
    await settled()
    expect(await screen.findByText(/Not enough to say anything yet/)).toHaveTextContent(
      `at least ${MIN_REGRETTED} of its purchases are marked not worth it, out of at least ${MIN_ANSWERED} you answered`)
    expect(screen.queryByRole('list', { name: /Not worth it/ })).not.toBeInTheDocument()
    expect(pageText()).not.toMatch(/Bar Pepe/)
    expect(pageText()).not.toMatch(/1 of 1/)
  })

  it('holds back a group that is under the bar while showing one that is over it, and says it did', async () => {
    await merchant('m1', 'Bar Pepe')
    // Merchant m1 and the weekday group are 2 of 3 and 1 of 1 respectively for the reason only the first purchase has.
    await answered('p', [false, false, true], { merchantId: 'm1' })
    await db.annotations.update('p0', { purchaseReasonId: 'reason.impulse' })
    render(<Intelligence today={TODAY} />)
    await settled()
    const list = await screen.findByRole('list', { name: 'Not worth it, all your records' })
    expect(within(list).getByText(/^Merchant: Bar Pepe/)).toBeInTheDocument()
    expect(within(list).queryByText(/Impulse/)).not.toBeInTheDocument()
    expect(screen.getByText(/1 other group is not shown/)).toBeInTheDocument()
  })

  it('says plainly that nothing is marked yet, with what each group will need, rather than an empty list', async () => {
    render(<Intelligence today={TODAY} />)
    await settled()
    expect(await screen.findByText(/no purchase is marked as not worth it/)).toHaveTextContent(
      `at least ${MIN_REGRETTED} marked not worth it out of at least ${MIN_ANSWERED} you answered`)
    expect(screen.queryByRole('list', { name: /Not worth it/ })).not.toBeInTheDocument()
  })

  it('draws the line at two regretted of three answered', () => {
    const c = (regretted: number, total: number) => ({ by: 'merchant' as const, key: 'k', label: 'L', regretted, total, cents: 100 })
    expect([c(1, 1), c(1, 2), c(1, 3), c(2, 2)].map(isFinding)).toEqual([false, false, false, false])
    expect([c(2, 3), c(3, 3), c(2, 10)].map(isFinding)).toEqual([true, true, true])
  })
})

describe('Intelligence screen: keyboard', () => {
  it('has only controls that act, they are native buttons, and focus stays on the one just used', async () => {
    await answered('p', [false, false, true])
    render(<Intelligence today={TODAY} />)
    await settled()
    await screen.findByRole('list', { name: /Not worth it/ })
    const buttons = screen.getAllByRole('button')
    expect(buttons.map((b) => b.textContent)).toEqual(['All time', 'November 2026'])
    for (const b of buttons) { expect(b.tagName).toBe('BUTTON'); expect(b).not.toHaveAttribute('tabindex', '-1'); expect(b).not.toBeDisabled() }

    const month = screen.getByRole('button', { name: 'November 2026' })
    month.focus()
    fireEvent.click(month)
    expect(month).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'All time' })).toHaveAttribute('aria-pressed', 'false')
    // Wait for what the screen is still doing (reloading the answers), not just for the first change.
    await screen.findByRole('list', { name: 'Not worth it, November 2026' })
    expect(month).toBeInTheDocument()
    expect(document.activeElement).toBe(month)
  })

  it('renders no button at all while there is nothing to act on besides the period', async () => {
    render(<Intelligence today={TODAY} />)
    await settled()
    await screen.findByText(/no purchase is marked/)
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['All time', 'November 2026'])
    expect(screen.queryByRole('button', { name: /teach|forget|reset|clear|undo|apply/i })).not.toBeInTheDocument()
  })
})
