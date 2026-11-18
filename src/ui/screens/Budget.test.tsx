import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import Budget from './Budget'
import { db } from '../../db/db'
import { seedDatabase } from '../../db/seed'
import { saveAllocation } from '../../budget/allocations'
import { formatBp, formatEur } from '../../lib/money'
import type { TransactionRow } from '../../db/schema'
import { spoken } from '../../test/spoken'

const GROCERIES: [string, string] = ['Alimentación', 'Supermercados y alimentación']
const RESTAURANTS: [string, string] = ['Ocio y viajes', 'Cafeterías y restaurantes']
const TODAY_NOV = '2026-11-10' // inside November: the month is still running
const TODAY_DEC = '2026-12-05' // November is over

let uid = 0
const tx = async (id: string, valueDate: string, amountCents: number, ing: [string, string] | null = null): Promise<void> => {
  const row: TransactionRow = {
    id, accountId: 'acc.1', valueDate, amountCents, balanceCents: 0, description: 'Movimiento inventado', comment: null,
    ingCategory: ing?.[0] ?? null, ingSubcategory: ing?.[1] ?? null, kind: amountCents > 0 ? 'income' : 'spend',
    dedupKey: `k.${++uid}`, importId: 'imp.1', fileSeq: uid, roundupParentId: null, createdAt: 1, deletedAt: null,
  }
  await db.transactions.add(row)
}

const allocate = (categoryId: string, percentBp: number | null, fixedCents: number | null = null, effectiveFrom = '2026-01-01') =>
  saveAllocation({ categoryId, savingsGoalId: null, percentBp, fixedCents, effectiveFrom, note: null })

afterEach(() => { vi.restoreAllMocks() })

beforeEach(async () => {
  uid = 0
  await db.delete(); await db.open(); await seedDatabase()
})

const lineOf = async (key: string): Promise<HTMLElement> => {
  await screen.findByRole('heading', { name: 'November 2026' })
  await waitFor(() => expect(document.querySelector(`[data-budget-line="${key}"]`)).not.toBeNull())
  return document.querySelector(`[data-budget-line="${key}"]`) as HTMLElement
}
const outsideGroup = async (): Promise<HTMLElement> => {
  const heading = await screen.findByRole('heading', { name: 'Spending outside your budget' })
  return heading.nextElementSibling?.nextElementSibling as HTMLElement
}
const ready = async () => { await screen.findByRole('heading', { name: 'November 2026' }); await waitFor(() => expect(screen.queryByText(/Loading your budget/)).toBeNull()) }

const fill = (label: RegExp | string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } })

describe('Budget screen', () => {
  it('shows each allocation with its euros and its percentage', async () => {
    await tx('pay', '2026-11-01', 200000)
    await tx('a', '2026-11-03', -10000, GROCERIES)
    await allocate('cat.groceries', 1500) // 15 % of 2000 EUR
    await allocate('cat.restaurants', null, 25000) // fixed, 12,5 % of income
    render(<Budget today={TODAY_DEC} initialMonth="2026-11" />)

    const groceries = await lineOf('category:cat.groceries')
    expect(groceries).toHaveTextContent(`Planned: ${formatEur(30000)} · 15 % of income`)
    expect(groceries).toHaveTextContent(`Spent: ${formatEur(10000)}`)
    expect(groceries).toHaveTextContent('66,67 % under plan')
    expect(groceries).toHaveTextContent(`${formatEur(20000)} left`)
    // A fixed amount still states what share of income it is.
    expect(await lineOf('category:cat.restaurants')).toHaveTextContent(`Fixed: ${formatEur(25000)} · 12,5 % of income`)
    // Actual income carries no provisional label anywhere.
    expect(document.body).not.toHaveTextContent(/estimate/i)
    expect(document.body).toHaveTextContent(`Income this month: ${formatEur(200000)}.`)
  })

  it('says plainly when the income basis is provisional, and why', async () => {
    await tx('o', '2026-10-01', 180000)
    await tx('s', '2026-09-01', 220000)
    await allocate('cat.groceries', 1000)
    await allocate('cat.restaurants', null, 5000)
    render(<Budget today={TODAY_NOV} />)

    expect(await screen.findByText(/the average of your last three months/)).toHaveTextContent(`estimate of ${formatEur(200000)}`)
    // The label travels with each figure it affects, not only the header.
    const groceries = await lineOf('category:cat.groceries')
    expect(groceries).toHaveTextContent(`Planned: ${formatEur(20000)} · 10 % of income (estimated income)`)
    expect(await lineOf('category:cat.restaurants')).toHaveTextContent('2,5 % of income (estimated income)')
    expect(screen.getByText(/^Total spent:/)).toHaveTextContent('(estimated income)')
  })

  it('does not call missing income an estimate, and draws no percentage it cannot support', async () => {
    await allocate('cat.groceries', 1000) // a share of nothing
    await allocate('cat.restaurants', null, 5000)
    render(<Budget today={TODAY_NOV} />)

    expect(await screen.findByText(/No income recorded yet for this month/)).toBeInTheDocument()
    expect(document.body).not.toHaveTextContent(/you earned|earned nothing|estimate of/i)
    const share = await lineOf('category:cat.groceries')
    expect(share).toHaveTextContent(`Planned: ${formatEur(0)} (no income recorded yet)`)
    // Fixed money has no share of a missing income: no "%" in its planned figure, and above all no 0 %.
    const fixed = await lineOf('category:cat.restaurants')
    expect(fixed).toHaveTextContent(`Fixed: ${formatEur(5000)}`)
    expect(fixed.querySelector('.budget-fig')?.textContent ?? '').not.toContain('%')
    // Overcommitment is stated in euros only: no percentage of a missing income. No savings rate either.
    expect((await screen.findByText(/That is allowed/)).textContent ?? '').not.toContain('%')
    expect(screen.getByText(/^Saved:/).textContent ?? '').not.toContain('%')
  })

  it('says the month is still running and shows month-to-date actuals', async () => {
    await tx('pay', '2026-11-01', 200000)
    await tx('a', '2026-11-03', -10000, GROCERIES)
    await allocate('cat.groceries', 1500)
    render(<Budget today={TODAY_NOV} />)

    expect(await screen.findByText(/This month is still running/)).toHaveTextContent('up to 10/11/2026')
    expect(await lineOf('category:cat.groceries')).toHaveTextContent(`Spent so far: ${formatEur(10000)}`)
    expect(screen.getByRole('heading', { name: 'So far this month' })).toBeInTheDocument()
  })

  it('does not call a finished month still running', async () => {
    await tx('pay', '2026-11-01', 200000)
    await allocate('cat.groceries', 1500)
    render(<Budget today={TODAY_DEC} initialMonth="2026-11" />)
    expect(await lineOf('category:cat.groceries')).toHaveTextContent('Spent: ')
    expect(screen.queryByText(/still running/)).toBeNull()
  })

  it('states overcommitment without blocking it', async () => {
    await tx('pay', '2026-11-01', 200000)
    await allocate('cat.groceries', 7000)
    await allocate('cat.restaurants', 5000) // 120 % in all
    render(<Budget today={TODAY_DEC} initialMonth="2026-11" />)

    const note = await screen.findByText(/That is allowed/)
    expect(note).toHaveTextContent(`total ${formatEur(240000)}`)
    expect(note).toHaveTextContent(`${formatEur(40000)} more than your income of ${formatEur(200000)}`)
    expect(note).toHaveTextContent('(20 % over)')

    // Nothing is disabled or confirmed: a further allocation saves while the budget is already over.
    fireEvent.click(screen.getByRole('button', { name: 'Add an allocation' }))
    fill('What it is for', 'category:cat.group.ocio-viajes')
    fill(/Share of income/, '10')
    const save = screen.getByRole('button', { name: 'Save' })
    expect(save).toBeEnabled()
    fireEvent.click(save)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(await db.budgetAllocations.count()).toBe(3)
    expect(await screen.findByText(/That is allowed/)).toHaveTextContent('(30 % over)')
  })

  it('states the euro overcommitment when there is no income to take a percentage of', async () => {
    await allocate('cat.restaurants', null, 5000)
    render(<Budget today={TODAY_NOV} />)
    const note = await screen.findByText(/That is allowed/)
    expect(note).toHaveTextContent(`total ${formatEur(5000)}, which is ${formatEur(5000)} more than the income recorded so far, ${formatEur(0)}`)
    expect(note.textContent ?? '').not.toContain('%')
  })

  it('offers no way to plan an amount for a removed category', async () => {
    await tx('pay', '2026-11-01', 200000)
    await tx('x', '2026-11-05', -2000, null)
    await db.annotations.add({ transactionId: 'x', categoryId: 'cat.gone', subcategoryId: null, merchantId: null, typeOverride: null, paymentMethod: null, note: null, moodId: null, purchaseReasonId: null, worthwhile: null, reviewed: false, dateOverride: null, amountCentsOverride: null, descriptionOverride: null, updatedAt: 1 })
    render(<Budget today={TODAY_DEC} initialMonth="2026-11" />)
    const group = await outsideGroup()
    expect(group).toHaveTextContent('Removed category (not budgeted)')
    expect(within(group).queryByRole('button')).toBeNull()
  })

  it('adds, edits and removes an allocation', async () => {
    await tx('pay', '2026-11-01', 200000)
    render(<Budget today={TODAY_DEC} initialMonth="2026-11" />)
    await ready()

    fireEvent.click(screen.getByRole('button', { name: 'Add an allocation' }))
    fill('What it is for', 'category:cat.groceries')
    fill(/Share of income/, '15')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await lineOf('category:cat.groceries')).toHaveTextContent(`Planned: ${formatEur(30000)}`)
    expect(await db.budgetAllocations.count()).toBe(1)

    fireEvent.click(within(await lineOf('category:cat.groceries')).getByRole('button'))
    expect(screen.getByLabelText(/Share of income/)).toHaveValue('15,00')
    fill(/Share of income/, '20')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(async () => expect(await lineOf('category:cat.groceries')).toHaveTextContent(`Planned: ${formatEur(40000)}`))
    // Same target, same day: the first is replaced, not duplicated.
    expect((await db.budgetAllocations.toArray()).map((a) => a.percentBp)).toEqual([2000])

    fireEvent.click(within(await lineOf('category:cat.groceries')).getByRole('button'))
    fireEvent.click(screen.getByRole('button', { name: 'Remove allocation' }))
    await waitFor(() => expect(document.querySelector('[data-budget-line="category:cat.groceries"]')).toBeNull())
    expect(await db.budgetAllocations.count()).toBe(0)
  })

  it('says so when removing an allocation brings an earlier one back', async () => {
    await tx('pay', '2026-11-01', 200000)
    await allocate('cat.groceries', 1000, null, '2026-01-01')
    await allocate('cat.groceries', 2000, null, '2026-11-01')
    render(<Budget today={TODAY_DEC} initialMonth="2026-11" />)
    fireEvent.click(within(await lineOf('category:cat.groceries')).getByRole('button'))
    fireEvent.click(screen.getByRole('button', { name: 'Remove allocation' }))
    expect(await screen.findByText(/The earlier one from 01\/01\/2026 applies again/)).toBeInTheDocument()
    expect(await lineOf('category:cat.groceries')).toHaveTextContent(`Planned: ${formatEur(20000)}`)
  })

  it('refuses an allocation the data layer rejects, showing its message', async () => {
    render(<Budget today={TODAY_DEC} initialMonth="2026-11" />)
    await ready()
    fireEvent.click(screen.getByRole('button', { name: 'Add an allocation' }))
    fill(/Share of income/, '10') // no category or goal chosen
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Choose a spending category or a savings goal for this amount.')
    expect(screen.getByRole('dialog')).toBeInTheDocument() // still open, nothing swallowed
    expect(await db.budgetAllocations.count()).toBe(0)
  })

  it('refuses a negative amount with the data layer\'s own words', async () => {
    render(<Budget today={TODAY_DEC} initialMonth="2026-11" />)
    await ready()
    fireEvent.click(screen.getByRole('button', { name: 'Add an allocation' }))
    fill('What it is for', 'category:cat.groceries')
    fill('Set it as', 'fixed')
    fill(/Amount in euros/, '-5')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The fixed amount must be zero or more.')
  })

  it('refuses a negative share in plain words, without naming the unit it is stored in', async () => {
    render(<Budget today={TODAY_DEC} initialMonth="2026-11" />)
    await ready()
    fireEvent.click(screen.getByRole('button', { name: 'Add an allocation' }))
    fill('What it is for', 'category:cat.groceries')
    fill(/Share of income/, '-5')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    const text = (await screen.findByRole('alert')).textContent ?? ''
    expect(text).toBe('The share of income must be zero or more, with at most two decimals.')
    expect(text).not.toMatch(/hundredth|basis/i)
    expect(await db.budgetAllocations.count()).toBe(0)
  })

  it('does not claim nothing changed when the save was written and only reading it back failed', async () => {
    render(<Budget today={TODAY_DEC} initialMonth="2026-11" />)
    await ready()
    fireEvent.click(screen.getByRole('button', { name: 'Add an allocation' }))
    fill('What it is for', 'category:cat.groceries')
    fill(/Share of income/, '10')
    vi.spyOn(db.transfers, 'toArray').mockRejectedValue(new Error('boom')) // the reload after the write fails
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    const text = (await screen.findByRole('alert')).textContent ?? ''
    expect(await db.budgetAllocations.count()).toBe(1) // it WAS written...
    expect(text).toMatch(/saved/i) // ...and the screen says so
    expect(text).not.toMatch(/nothing was changed/i)
  })

  it('shows an empty state that says what to do first', async () => {
    render(<Budget today={TODAY_DEC} initialMonth="2026-11" />)
    const text = (await screen.findByText(/Nothing to show for November 2026 yet/)).textContent ?? ''
    expect(text).toMatch(/import your ING statements/)
    expect(text).toMatch(/Add an allocation/)
    expect(text).not.toMatch(/you (have not|haven't|didn't|did not)|nothing yet|forgot|failed/i)
  })

  it('groups spending in categories with no allocation as unbudgeted', async () => {
    await tx('pay', '2026-11-01', 200000)
    await tx('a', '2026-11-03', -10000, GROCERIES)
    await tx('b', '2026-11-04', -4000, RESTAURANTS) // never budgeted
    await tx('c', '2026-11-05', -500) // no category at all
    await allocate('cat.groceries', 1500)
    render(<Budget today={TODAY_DEC} initialMonth="2026-11" />)

    const group = await outsideGroup()
    expect(within(group).getByText('Cafeterías y restaurantes')).toBeInTheDocument()
    expect(within(group).getByText('Uncategorised')).toBeInTheDocument()
    // Keyed on the flag, not the id: the uncategorised line has an empty id and is still in the group.
    expect(group.querySelectorAll('li')).toHaveLength(2)
    expect(within(group).queryByText('Supermercados y alimentación')).toBeNull()
    expect(await lineOf('category:cat.groceries')).toBeInTheDocument()
    // Budgeted plus outside accounts for the whole of the spending.
    expect(screen.getByText(/^Total spent:/)).toHaveTextContent(formatEur(10000 + 4000 + 500))
    expect(group).toHaveTextContent(formatEur(4000))
    expect(group).toHaveTextContent(formatEur(500))
    // The uncategorised line has nothing to plan against; the categorised one does.
    expect(within(group).queryByRole('button', { name: /Uncategorised/ })).toBeNull()
    fireEvent.click(within(group).getByRole('button', { name: 'Plan an amount for Cafeterías y restaurantes' }))
    expect(screen.getByLabelText('What it is for')).toHaveValue('category:cat.restaurants')
  })

  it('never shows a variance percentage for an unbudgeted line', async () => {
    await tx('pay', '2026-11-01', 200000)
    await tx('b', '2026-11-04', -4000, RESTAURANTS)
    await tx('c', '2026-11-05', -500)
    render(<Budget today={TODAY_DEC} initialMonth="2026-11" />)
    const group = await outsideGroup()
    expect(group.textContent ?? '').not.toContain('%')
    expect(spoken(group)).not.toMatch(/over|under|plan\b/)
    expect(group).toHaveTextContent(formatEur(4000))
  })

  it('keeps the words of a parent line that excludes separately budgeted children', async () => {
    await tx('pay', '2026-11-01', 200000)
    await allocate('cat.group.ocio-viajes', 2000)
    await allocate('cat.restaurants', 500)
    render(<Budget today={TODAY_DEC} initialMonth="2026-11" />)
    expect(await lineOf('category:cat.group.ocio-viajes')).toHaveTextContent('(excluding categories budgeted separately)')
  })

  it('closes the editor on Escape and returns focus to what opened it', async () => {
    await tx('pay', '2026-11-01', 200000)
    await allocate('cat.groceries', 1500)
    render(<Budget today={TODAY_DEC} initialMonth="2026-11" />)
    const opener = within(await lineOf('category:cat.groceries')).getByRole('button')
    opener.focus()
    fireEvent.click(opener)
    const dialog = await screen.findByRole('dialog')
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(opener).toHaveFocus())
  })

  it('moves between months', async () => {
    await tx('pay', '2026-10-01', 150000)
    render(<Budget today={TODAY_NOV} />)
    await ready()
    fireEvent.click(screen.getByRole('button', { name: 'Previous month' }))
    expect(await screen.findByRole('heading', { name: 'October 2026' })).toBeInTheDocument()
    expect(await screen.findByText(`Income this month: ${formatEur(150000)}.`)).toBeInTheDocument()
    expect(formatBp(-4000)).toBe('-40 %')
    expect(formatBp(1250)).toBe('12,5 %')
  })
})
