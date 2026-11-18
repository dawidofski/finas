import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import Recurring, { REGULAR_BP, VERY_REGULAR_BP, regularityIn } from './Recurring'
import { db } from '../../db/db'
import { seedDatabase } from '../../db/seed'
import type { AnnotationRow, TransactionRow } from '../../db/schema'
import { formatEur } from '../../lib/money'
import { formatSpanishDate } from '../../lib/dates'
import { confirmRecurring, recurringPayments } from '../../recurring/store'
import { BANNED_LISTS, WORDING_LISTS, violations } from '../../test/bannedWords'
import { appSpoken, spoken } from '../../test/spoken'
import { guardWording } from '../../test/wording'
import { ROUTES } from '../routes'

const TODAY = '2026-11-18'
const AT = 1_700_000_000_000
configure({ asyncUtilTimeout: 8000 })
vi.setConfig({ testTimeout: 30_000 })
afterEach(() => { cleanup(); vi.restoreAllMocks() })
// Registered after the cleanup above so it runs before it (after-hooks run last to first): every state a test leaves on the page is scanned
// for banned wording. The merchant is the bank's or the owner's text, so it is left out.
guardWording(8)

let n = 0
const tx = (valueDate: string, amountCents: number): TransactionRow => ({
  id: `t${++n}`, accountId: 'acc', valueDate, amountCents, balanceCents: 50000, description: 'X', comment: null,
  ingCategory: null, ingSubcategory: null, kind: 'spend', dedupKey: `K${n}`, importId: 'imp', fileSeq: n, roundupParentId: null,
  createdAt: 1, deletedAt: null,
})
const ann = (transactionId: string, merchantId: string): AnnotationRow => ({
  transactionId, categoryId: null, subcategoryId: null, merchantId, typeOverride: null, paymentMethod: null,
  note: null, moodId: null, purchaseReasonId: null, worthwhile: null, reviewed: false, dateOverride: null,
  amountCentsOverride: null, descriptionOverride: null, updatedAt: 1,
})
async function merchant(id: string, canonicalName: string): Promise<void> {
  await db.merchants.put({ id, canonicalName, kind: 'subscription', matchPatterns: [], defaultCategoryId: null, isSubscription: true, createdAt: 1 } as never)
}
/** One payment per date, to a merchant, each with its own amount (cents out). */
async function payments(merchantId: string, dates: string[], amounts: number | number[]): Promise<void> {
  const rows = dates.map((d, i) => tx(d, -(Array.isArray(amounts) ? (amounts[i] ?? 0) : amounts)))
  await db.transactions.bulkAdd(rows)
  await db.annotations.bulkAdd(rows.map((r) => ann(r.id, merchantId)))
}
const on5th = (months: string[]): string[] => months.map((m) => `${m}-05`)
/** May to November: the last payment was on 5 November, the next is due about 6 December, nothing is overdue on TODAY. */
const LIVE = on5th(['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11'])
/** May to October: the payment due on 5 November has not come by TODAY (18 November), but not a whole cycle has passed. */
const OVERDUE = on5th(['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'])
/** March to August: more than a whole cycle past the date the next one was due. */
const STOPPED = on5th(['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08'])

beforeEach(async () => { n = 0; await db.delete(); await db.open(); await seedDatabase() })

const mount = async (computedAt = AT) => {
  const view = render(<Recurring today={TODAY} computedAt={computedAt} />)
  await screen.findByRole('heading', { level: 1, name: 'Recurring' })
  await waitFor(() => expect(screen.queryByText(/Loading your recurring payments/)).toBeNull())
  return view
}
const text = () => document.body.textContent ?? ''
const rowOf = (name: string): HTMLElement => screen.getByRole('heading', { level: 3, name }).closest('article') as HTMLElement
const field = (row: HTMLElement, term: string): string | null => within(row).queryByText(term, { selector: 'dt' })?.nextElementSibling?.textContent ?? null
const rows = () => screen.queryAllByRole('article')

describe('Recurring screen', () => {
  it('says nothing recurring has been found yet and what it needs, without reading as a failure', async () => {
    await mount()
    expect(text()).toMatch(/No recurring payments have been found yet/)
    expect(text()).toMatch(/normal starting point, not a problem with your records/)
    expect(text()).toMatch(/at least three payments to the same merchant at a steady interval/)
    expect(screen.getByRole('link', { name: 'import your bank statements' })).toHaveAttribute('href', '#/import')
    expect(rows()).toHaveLength(0)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryAllByRole('button')).toHaveLength(0)
    expect(text()).not.toMatch(/could not|failed|error|went wrong/i)
    // No total is invented, and no zero stands in for one.
    expect(text()).toMatch(/no monthly total yet/)
    expect(text()).not.toMatch(/\b0,00/)
  })

  it('shows merchant, amount, frequency, last and expected next payment for each', async () => {
    await merchant('m.gym', 'Gimnasio Ejemplo')
    await payments('m.gym', LIVE, 3000)
    await mount()
    const row = rowOf('Gimnasio Ejemplo')
    expect(field(row, 'Amount')).toBe(formatEur(3000))
    expect(field(row, 'How often')).toBe('Every month')
    expect(field(row, 'Last payment')).toBe(formatSpanishDate('2026-11-05'))
    expect(field(row, 'Expected next payment')).toBe(formatSpanishDate('2026-12-06'))
    expect(field(row, 'Cost per month')).toBe(formatEur(3000))
    // The name is the bank's or the owner's text: quoted, so it never reads as the app's sentence.
    expect(within(row).getByRole('heading', { level: 3 }).querySelector('q')?.textContent).toBe('Gimnasio Ejemplo')
    expect(appSpoken()).not.toContain('Gimnasio Ejemplo')
    expect(spoken()).toContain('Gimnasio Ejemplo')
  })

  it('shows the id of a merchant the records do not name, rather than nothing', async () => {
    await payments('m.unknown', LIVE, 3000)
    await mount()
    expect(rowOf('m.unknown')).toBeInTheDocument()
  })

  it('shows other frequencies as a cost per month, worked out', async () => {
    await merchant('m.rev', 'Seguro Ejemplo')
    await payments('m.rev', ['2025-05-10', '2025-08-10', '2025-11-10', '2026-02-10', '2026-05-10', '2026-08-10'], 9000)
    await mount()
    const row = rowOf('Seguro Ejemplo')
    expect(field(row, 'How often')).toBe('Every three months')
    expect(field(row, 'Cost per month')).toBe(formatEur(3000))
  })

  it('says how sure it is in words, never as a score', async () => {
    expect(regularityIn(VERY_REGULAR_BP)).not.toBe(regularityIn(VERY_REGULAR_BP - 1))
    expect(regularityIn(REGULAR_BP)).not.toBe(regularityIn(REGULAR_BP - 1))
    expect(regularityIn(REGULAR_BP)).toBe(regularityIn(VERY_REGULAR_BP - 1))
    await merchant('m.long', 'Largo Ejemplo')
    await merchant('m.short', 'Corto Ejemplo')
    await merchant('m.ragged', 'Irregular Ejemplo')
    await payments('m.long', LIVE, 3000)                                          // six steady payments
    await payments('m.short', on5th(['2026-08', '2026-09', '2026-10']), 1000)      // three steady payments
    await payments('m.ragged', ['2026-06-01', '2026-07-01', '2026-07-31', '2026-08-08'], 700) // one gap off
    await mount()
    const views = await recurringPayments(TODAY, AT)
    const bp = (m: string): number => views.find((v) => v.merchantId === m)?.matchScoreBp ?? -1
    expect(bp('m.long')).toBeGreaterThanOrEqual(VERY_REGULAR_BP)
    expect(bp('m.short')).toBeGreaterThanOrEqual(REGULAR_BP)
    expect(bp('m.short')).toBeLessThan(VERY_REGULAR_BP)
    expect(bp('m.ragged')).toBeLessThan(REGULAR_BP)
    const regular = (name: string): string => field(rowOf(name), 'How regular it has been') ?? ''
    expect(regular('Largo Ejemplo')).toContain(regularityIn(bp('m.long')))
    expect(regular('Corto Ejemplo')).toContain(regularityIn(bp('m.short')))
    expect(regular('Irregular Ejemplo')).toContain(regularityIn(bp('m.ragged')))
    expect(new Set(['Largo Ejemplo', 'Corto Ejemplo', 'Irregular Ejemplo'].map(regular)).size).toBe(3)
    // Neither the figure nor the words for it are anywhere on the page.
    const said = appSpoken()
    for (const m of ['m.long', 'm.short', 'm.ragged']) expect(said).not.toContain(String(bp(m)))
    expect(said).not.toMatch(/score|match|confiden|%|probab/i)
  })

  it('removes a payment the owner says is not recurring and keeps it removed after a reload', async () => {
    await merchant('m.gym', 'Gimnasio Ejemplo')
    await merchant('m.tv', 'Televisión Ejemplo')
    await payments('m.gym', LIVE, 3000)
    await payments('m.tv', LIVE, 1299)
    await mount()
    expect(rows()).toHaveLength(2)
    fireEvent.click(within(rowOf('Gimnasio Ejemplo')).getByRole('button', { name: /not recurring/ }))
    await waitFor(() => expect(rows()).toHaveLength(1))
    expect(screen.queryByRole('heading', { level: 3, name: 'Gimnasio Ejemplo' })).toBeNull()
    // Stored, and stored as "not recurring", not as cancelled.
    const stored = (await db.recurring.toArray()).find((r) => r.merchantId === 'm.gym')
    expect(stored).toMatchObject({ dismissed: true, cancelled: false })
    // A fresh mount (nothing carried in component state), later: still gone, and the total no longer counts it.
    cleanup()
    await mount(AT + 86_400_000)
    expect(rows()).toHaveLength(1)
    expect(screen.queryByRole('heading', { level: 3, name: 'Gimnasio Ejemplo' })).toBeNull()
    expect(text()).toContain(`come to ${formatEur(1299)} a month`)
    // Dismissing the last one leaves a page that says so, not the beginner's page.
    fireEvent.click(within(rowOf('Televisión Ejemplo')).getByRole('button', { name: /not recurring/ }))
    await waitFor(() => expect(rows()).toHaveLength(0))
    expect(text()).toMatch(/You said 2 payments are not recurring/)
    expect(text()).not.toMatch(/normal starting point/)
    cleanup()
    await mount()
    expect(text()).toMatch(/You said 2 payments are not recurring/)
  })

  it('states a price change rather than showing two payments', async () => {
    await merchant('m.tv', 'Televisión Ejemplo')
    await payments('m.tv', LIVE, [1299, 1299, 1299, 1299, 1390, 1390])
    await mount()
    expect(rows()).toHaveLength(1)
    const row = rowOf('Televisión Ejemplo')
    expect(field(row, 'Price change')).toBe(`It used to be ${formatEur(1299)}, and the latest payment was ${formatEur(1390)}.`)
    // One payment: no second row for the new price.
    cleanup()
    await db.transactions.clear(); await db.annotations.clear()
    await payments('m.tv', LIVE, 1299)
    await mount()
    expect(field(rowOf('Televisión Ejemplo'), 'Price change')).toBeNull()
  })

  it('says a payment seems to have stopped, with no expected date and no monthly figure, and leaves it out of the total', async () => {
    await merchant('m.old', 'Revista Ejemplo')
    await merchant('m.gym', 'Gimnasio Ejemplo')
    await payments('m.old', STOPPED, 1200)
    await payments('m.gym', LIVE, 3000)
    await mount()
    const old = rowOf('Revista Ejemplo')
    expect(old.textContent).toContain('This seems to have stopped')
    expect(field(old, 'Last payment')).toBe(formatSpanishDate('2026-08-05'))
    expect(field(old, 'Expected next payment')).toBeNull()
    expect(field(old, 'Cost per month')).toBe('Not counted while it seems to have stopped.')
    expect(old.textContent).not.toMatch(/0,00/)
    expect(field(rowOf('Gimnasio Ejemplo'), 'Expected next payment')).not.toBeNull()
    expect(text()).toContain(`come to ${formatEur(3000)} a month`)
    expect(text()).not.toContain(formatEur(4200))
  })

  it('says a payment was expected and has not appeared, never showing a past date as upcoming', async () => {
    await merchant('m.gym', 'Gimnasio Ejemplo')
    await payments('m.gym', OVERDUE, 3000)
    await mount()
    const row = rowOf('Gimnasio Ejemplo')
    expect(field(row, 'Expected next payment')).toBeNull()
    expect(field(row, 'Expected payment')).toBe(`It was expected around ${formatSpanishDate('2026-11-05')} and has not appeared yet.`)
    expect(row.textContent).not.toContain('seems to have stopped')
    expect(field(row, 'Cost per month')).toBe(formatEur(3000))
  })

  it('shows the owner the payments they hid, and shows one again on request', async () => {
    await merchant('m.gym', 'Gimnasio Ejemplo')
    await merchant('m.tv', 'Televisión Ejemplo')
    await payments('m.gym', LIVE, 3000)
    await payments('m.tv', LIVE, 1299)
    await mount()
    expect(screen.queryByRole('heading', { level: 2, name: 'Hidden' })).toBeNull()
    fireEvent.click(within(rowOf('Gimnasio Ejemplo')).getByRole('button', { name: /not recurring/ }))
    await waitFor(() => expect(rows()).toHaveLength(1))
    const hidden = screen.getByRole('list', { name: 'Hidden payments' })
    expect(hidden.textContent).toContain('Gimnasio Ejemplo')
    expect(text()).toMatch(/You said one payment is not recurring/)
    fireEvent.click(within(hidden).getByRole('button', { name: 'Show again: Gimnasio Ejemplo' }))
    await waitFor(() => expect(rows()).toHaveLength(2))
    expect(screen.queryByRole('list', { name: 'Hidden payments' })).toBeNull()
    expect((await db.recurring.toArray()).every((r) => r.dismissed !== true)).toBe(true)
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 3, name: 'Gimnasio Ejemplo' }))
  })

  it('does not promise yearly bills, and says why', async () => {
    await mount()
    expect(text()).not.toMatch(/every year/i)
    expect(text()).toMatch(/A yearly bill is not found here/)
  })

  it('describes the regularity by how many payments and a roughly equal interval, not as very even', async () => {
    expect(regularityIn(VERY_REGULAR_BP)).not.toMatch(/very even/)
    expect(regularityIn(VERY_REGULAR_BP)).toMatch(/roughly the same interval/)
    expect(regularityIn(REGULAR_BP)).toMatch(/roughly the same interval/)
  })

  it('shows an irregular payment only once confirmed, with no expected date and no monthly figure', async () => {
    await merchant('m.odd', 'Variable Ejemplo')
    await payments('m.odd', ['2026-06-01', '2026-06-03', '2026-06-05'], 500)
    await mount()
    expect(rows()).toHaveLength(0)
    cleanup()
    await confirmRecurring((await db.recurring.toArray())[0]?.id as string)
    await mount()
    const row = rowOf('Variable Ejemplo')
    expect(field(row, 'How often')).toBe('No regular interval')
    expect(field(row, 'Expected next payment')).toBeNull()
    expect(field(row, 'Cost per month')).toBe('No monthly figure: the payments do not come at a regular interval.')
    expect(row.textContent).not.toMatch(/0,00/)
    expect(text()).toMatch(/no monthly total yet/)
    expect(within(row).queryByRole('button', { name: /Yes, this recurs/ })).toBeNull()
  })

  it('confirms a payment, keeps it on the page, and keeps focus on it', async () => {
    await merchant('m.gym', 'Gimnasio Ejemplo')
    await payments('m.gym', LIVE, 3000)
    await mount()
    expect(within(rowOf('Gimnasio Ejemplo')).queryByText('You confirmed that this recurs.')).toBeNull()
    fireEvent.click(within(rowOf('Gimnasio Ejemplo')).getByRole('button', { name: /Yes, this recurs/ }))
    await waitFor(() => expect(within(rowOf('Gimnasio Ejemplo')).getByText('You confirmed that this recurs.')).toBeInTheDocument())
    expect(within(rowOf('Gimnasio Ejemplo')).queryByRole('button', { name: /Yes, this recurs/ })).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 3, name: 'Gimnasio Ejemplo' }))
    expect((await db.recurring.toArray())[0]?.confirmedByUser).toBe(true)
    cleanup()
    await mount()
    expect(within(rowOf('Gimnasio Ejemplo')).getByText('You confirmed that this recurs.')).toBeInTheDocument()
  })

  it('shows a cancelled payment as cancelled, apart, with no controls and out of the total', async () => {
    await merchant('m.gym', 'Gimnasio Ejemplo')
    await merchant('m.tv', 'Televisión Ejemplo')
    await payments('m.gym', LIVE, 3000)
    await payments('m.tv', LIVE, 1299)
    await mount()
    expect(text()).toContain(`come to ${formatEur(4299)} a month`)
    fireEvent.click(within(rowOf('Gimnasio Ejemplo')).getByRole('button', { name: /I cancelled it/ }))
    const cancelled = await screen.findByRole('list', { name: 'Cancelled payments' })
    expect(within(cancelled).getByRole('heading', { level: 3, name: 'Gimnasio Ejemplo' })).toBeInTheDocument()
    expect(screen.getByRole('list', { name: 'Recurring payments' }).textContent).not.toContain('Gimnasio Ejemplo')
    expect(cancelled.textContent).toContain('You marked this as cancelled')
    expect(within(cancelled).queryAllByRole('button')).toHaveLength(0)
    expect(field(rowOf('Gimnasio Ejemplo'), 'Expected next payment')).toBeNull()
    expect(field(rowOf('Gimnasio Ejemplo'), 'Cost per month')).toBe('Not counted: you marked it as cancelled.')
    expect(text()).toContain(`come to ${formatEur(1299)} a month`)
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 3, name: 'Gimnasio Ejemplo' }))
    const gym = (await db.recurring.toArray()).find((r) => r.merchantId === 'm.gym')
    expect(gym).toMatchObject({ cancelled: true })
    expect(gym?.dismissed).not.toBe(true)
    cleanup()
    await mount()
    expect(within(screen.getByRole('list', { name: 'Cancelled payments' })).getByRole('heading', { level: 3, name: 'Gimnasio Ejemplo' })).toBeInTheDocument()
  })

  it('says what the total includes, and shows no total rather than a zero when nothing counts', async () => {
    await merchant('m.gym', 'Gimnasio Ejemplo')
    await payments('m.gym', LIVE, 3000)
    await mount()
    expect(text()).toMatch(/counts each payment that comes at a regular interval, has not seemed to stop, and that you have not marked as cancelled/)
    expect(text()).toMatch(/includes payments you have not yet confirmed/)
    expect(text()).toMatch(/leaves out payments with no regular interval, payments that seem to have stopped, cancelled ones/)
    fireEvent.click(within(rowOf('Gimnasio Ejemplo')).getByRole('button', { name: /I cancelled it/ }))
    await screen.findByRole('list', { name: 'Cancelled payments' })
    expect(text()).toMatch(/no monthly total yet/)
    expect(text()).not.toMatch(/\b0,00/)
  })

  it('moves focus to the next payment when one is removed, and to the heading when none is left', async () => {
    await merchant('m.gym', 'Gimnasio Ejemplo')
    await merchant('m.tv', 'Televisión Ejemplo')
    await payments('m.gym', LIVE, 3000)
    await payments('m.tv', LIVE, 1299)
    await mount()
    const order = rows().map((r) => r.querySelector('h3')?.textContent as string)
    fireEvent.click(within(rowOf(order[0] as string)).getByRole('button', { name: /not recurring/ }))
    await waitFor(() => expect(rows()).toHaveLength(1))
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 3, name: order[1] }))
    fireEvent.click(within(rowOf(order[1] as string)).getByRole('button', { name: /not recurring/ }))
    await waitFor(() => expect(rows()).toHaveLength(0))
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 2, name: 'Monthly cost' }))
  })

  it('keeps the payment and says so when a choice cannot be saved', async () => {
    await merchant('m.gym', 'Gimnasio Ejemplo')
    await payments('m.gym', LIVE, 3000)
    await mount()
    vi.spyOn(db.recurring, 'update').mockRejectedValue(new Error('disk full'))
    fireEvent.click(within(rowOf('Gimnasio Ejemplo')).getByRole('button', { name: /not recurring/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Your choice could not be saved (disk full). Nothing was changed.')
    expect(rows()).toHaveLength(1)
  })

  it('says the payments could not be worked out, and offers nothing to press, when the store fails', async () => {
    await payments('m.gym', LIVE, 3000)
    vi.spyOn(db.recurring, 'toArray').mockRejectedValue(new Error('the store is gone'))
    render(<Recurring today={TODAY} computedAt={AT} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Your recurring payments could not be worked out (the store is gone).')
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })

  it('renders no control that does nothing, and only links to screens that exist', async () => {
    await merchant('m.gym', 'Gimnasio Ejemplo')
    await payments('m.gym', LIVE, 3000)
    await payments('m.old', STOPPED, 1200)
    await mount()
    expect(document.querySelectorAll('[disabled], [aria-disabled="true"]')).toHaveLength(0)
    for (const el of document.querySelectorAll('[tabindex]')) expect(el.getAttribute('tabindex')).toBe('-1')
    expect(screen.getAllByRole('button')).toHaveLength(6)
    for (const a of screen.queryAllByRole('link')) expect(ROUTES.map((r) => '#' + r.path)).toContain(a.getAttribute('href'))
    cleanup()
    await db.transactions.clear(); await db.annotations.clear()
    await mount()
    for (const a of screen.queryAllByRole('link')) expect(ROUTES.map((r) => '#' + r.path)).toContain(a.getAttribute('href'))
  })

  it('uses no causal, shaming, means-assuming or statistical wording anywhere on the page, and a merchant name never counts as the app speaking', async () => {
    const lists = [...BANNED_LISTS, ...WORDING_LISTS]
    for (const list of lists) {
      expect(list.forbids, list.name).toMatch(list.pattern)
      expect(list.allows, list.name).not.toMatch(list.pattern)
    }
    // The bank's text can say anything; it is quoted, and the scan leaves it out.
    await merchant('m.gym', 'Because Gym, just stop wasting')
    await merchant('m.old', 'Revista Ejemplo')
    await merchant('m.odd', 'Variable Ejemplo')
    await payments('m.gym', [...LIVE], [3000, 3000, 3000, 3000, 3090, 3090])
    await payments('m.old', STOPPED, 1200)
    await payments('m.odd', ['2026-06-01', '2026-06-03', '2026-06-05'], 500)
    for (const stage of ['unconfirmed', 'confirmed']) {
      cleanup()
      if (stage === 'confirmed') await confirmRecurring((await db.recurring.toArray()).find((r) => r.merchantId === 'm.odd')?.id as string)
      await mount()
      const page = appSpoken()
      expect(page).toContain('seems to have stopped')
      expect(page).toContain('It used to be')
      expect(page).not.toContain('Because Gym')
      for (const list of lists) expect(page, list.name).not.toMatch(list.pattern)
      expect(violations(page)).toEqual([])
    }
    // The empty page too.
    cleanup()
    await db.transactions.clear(); await db.annotations.clear(); await db.recurring.clear()
    await mount()
    expect(appSpoken()).toContain('No recurring payments have been found yet')
    expect(violations(appSpoken())).toEqual([])
  })
})
