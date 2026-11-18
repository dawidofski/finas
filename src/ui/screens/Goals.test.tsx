import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import Goals, { estimateWords } from './Goals'
import { db } from '../../db/db'
import { seedDatabase } from '../../db/seed'
import type { TransactionRow } from '../../db/schema'
import { createGoal } from '../../goals/store'
import type { GoalProgress } from '../../goals/progress'
import { formatBp, formatEur } from '../../lib/money'
import { saveAllocation } from '../../budget/allocations'
import { violations } from '../../test/bannedWords'
import { appSpoken } from '../../test/spoken'
import { guardWording } from '../../test/wording'

const TODAY = '2026-11-18'
const AT = Date.UTC(2026, 10, 18, 12)
const CREATED = Date.UTC(2026, 0, 15)
configure({ asyncUtilTimeout: 8000 })
vi.setConfig({ testTimeout: 30_000 })
afterEach(() => { cleanup(); vi.restoreAllMocks() })
// Registered after the cleanup so it runs before it: every state a test leaves on the page is scanned for banned wording.
// The goal's name is the owner's text and is rendered in <q>, which the scan leaves out.
guardWording(8)

let n = 0
const tx = async (valueDate: string, amountCents: number, kind: TransactionRow['kind']): Promise<void> => {
  await db.transactions.add({
    id: `t${++n}`, accountId: 'acc.1', valueDate, amountCents, balanceCents: 0, description: 'Movimiento inventado', comment: null,
    ingCategory: kind === 'roundup' ? 'Ahorro' : null, ingSubcategory: kind === 'roundup' ? 'Redondeo' : null, kind,
    dedupKey: `k.${n}`, importId: 'imp.1', fileSeq: n, roundupParentId: null, createdAt: 1, deletedAt: null,
  })
}
/** One completed month per entry: 2000.00 EUR of income on the 1st, and `saved` cents moved into savings on the 5th. */
async function months(spec: [string, number][]): Promise<void> {
  for (const [month, saved] of spec) {
    await tx(`${month}-01`, 200000, 'income')
    if (saved > 0) await tx(`${month}-05`, -saved, 'roundup')
  }
}
const make = (name = 'Viaje inventado', targetCents = 100000, percentBp = 1000) =>
  createGoal({ name, targetCents, deadline: null, contributionPercentBp: percentBp }, CREATED)

beforeEach(async () => {
  n = 0
  await db.delete(); await db.open(); await seedDatabase()
})

const mount = async () => {
  const view = render(<Goals today={TODAY} computedAt={AT} />)
  await screen.findByRole('heading', { level: 1, name: 'Goals' })
  await waitFor(() => expect(screen.queryByText(/Loading your savings goals/)).toBeNull())
  return view
}
const card = (name: string): HTMLElement => screen.getByRole('heading', { level: 3, name }).closest('article') as HTMLElement
const text = () => document.body.textContent ?? ''
const said = () => appSpoken()
const fill = (label: RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } })
const fillForm = (name: string, target: string, percent: string) => {
  fill(/Name of the goal/, name); fill(/Target amount/, target); fill(/Share of income to put toward it/, percent)
}
const progress = (over: Partial<GoalProgress>): GoalProgress => ({
  goalId: 'g', targetCents: 1000, contributedCents: 0, remainingCents: 1000, estimate: null, estimateWhy: null, estimateNote: null, reached: false, ...over,
})

describe('Goals screen', () => {
  it('says no goal is set yet and how to set one, without reading as a failure', async () => {
    await mount()
    expect(text()).toContain('You have not set a savings goal yet')
    expect(text()).toContain('a normal place to start, not something missed')
    expect(screen.getByRole('form', { name: 'Add a savings goal' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('list', { name: 'Savings goals' })).toBeNull()
    expect(violations(said())).toEqual([])
  })

  it('shows contributed, remaining and the estimate as a range', async () => {
    await make()
    await months([['2026-08', 1000], ['2026-09', 2000], ['2026-10', 3000]])
    await mount()
    // Three months of 10, 20 and 30 EUR set aside: slower rate 10 EUR, faster 30 EUR. 60 EUR so far, 940 EUR to go.
    // 94000 / 3000 = 31.3 -> 32 months after 2026-10 = 2029-06; 94000 / 1000 = 94 months after 2026-10 = 2034-08.
    const c = within(card('Viaje inventado'))
    expect(c.getByText('Put toward it so far').nextElementSibling).toHaveTextContent(formatEur(6000))
    expect(c.getByText('Still to go').nextElementSibling).toHaveTextContent(formatEur(94000))
    expect(c.getByText('When it might be reached').nextElementSibling).toHaveTextContent('Going by your record so far, between June 2029 and August 2034.')
  })

  it('words a range inside one year with the year once, and never as a single date', () => {
    expect(estimateWords(progress({ estimate: { earliestMonth: '2027-03', latestMonth: '2027-06' } })).sentence)
      .toBe('Going by your record so far, between March and June 2027.')
    expect(estimateWords(progress({ estimate: { earliestMonth: '2027-03', latestMonth: '2028-01' } })).sentence)
      .toBe('Going by your record so far, between March 2027 and January 2028.')
    expect(estimateWords(progress({ estimate: { earliestMonth: '2027-03', latestMonth: '2027-03' } })).sentence)
      .toBe('Going by your record so far, your faster and slower months both point to March 2027.')
  })

  it('says why there is no estimate yet, in the owner terms', async () => {
    await make()
    await months([['2026-09', 2000], ['2026-10', 3000]])
    await mount()
    const when = within(card('Viaje inventado')).getByText('When it might be reached').nextElementSibling
    expect(when).toHaveTextContent('A range needs at least 3 months with something put toward it')
    expect(when?.textContent).not.toMatch(/between/)
  })

  it('gives only the earliest month, with the caveat, when some months had nothing put toward the goal', async () => {
    await make()
    await months([['2026-06', 0], ['2026-07', 0], ['2026-08', 1000], ['2026-09', 2000], ['2026-10', 3000]])
    await mount()
    // Lower half 0, 0 -> no latest month. Upper half 20, 30 -> 25 EUR a month: 94000 / 2500 = 37.6 -> 38 months after 2026-10 = 2029-12.
    const when = within(card('Viaje inventado')).getByText('When it might be reached').nextElementSibling
    expect(when).toHaveTextContent('it could be reached from December 2029 on.')
    expect(when).toHaveTextContent('Some months had nothing put toward this goal, so there is no latest date to give.')
    expect(when?.textContent).not.toMatch(/between/)
  })

  it('creates a goal and shows it without a reload, reading euros and percent exactly', async () => {
    await mount()
    fillForm('Coche inventado', '1.500,50', '12,5')
    fireEvent.click(screen.getByRole('button', { name: 'Add goal' }))
    const heading = await screen.findByRole('heading', { level: 3, name: 'Coche inventado' })
    expect(document.activeElement).toBe(heading)
    const [row] = await db.savingsGoals.toArray()
    expect(row).toMatchObject({ name: 'Coche inventado', targetCents: 150050, contributionPercentBp: 1250, archived: false, createdAt: AT })
    expect((await db.budgetAllocations.toArray())[0]).toMatchObject({ savingsGoalId: row?.id, percentBp: 1250, effectiveFrom: TODAY })
    expect(text()).not.toContain('You have not set a savings goal yet')
    cleanup()
    await mount()
    expect(screen.getByRole('heading', { level: 3, name: 'Coche inventado' })).toBeInTheDocument()
  })

  it('refuses bad input in plain words, writing nothing', async () => {
    await mount()
    const submit = () => fireEvent.click(screen.getByRole('button', { name: 'Add goal' }))
    fillForm('  ', '100', '10'); submit()
    expect(await screen.findByRole('alert')).toHaveTextContent('Give the goal a name.')
    fillForm('Viaje', 'mucho', '10'); submit()
    expect(await screen.findByRole('alert')).toHaveTextContent('Type the target as an amount in euros')
    fillForm('Viaje', '0', '10'); submit()
    expect(await screen.findByRole('alert')).toHaveTextContent('The target must be an amount of money above zero.')
    fillForm('Viaje', '100', 'x'); submit()
    expect(await screen.findByRole('alert')).toHaveTextContent('Type the share of income as a number')
    fillForm('Viaje', '100', '150'); submit()
    expect(await screen.findByRole('alert')).toHaveTextContent('between 0 % and 100 %')
    expect(await db.savingsGoals.count()).toBe(0)
  })

  it('shows the reason when the store refuses, and creates nothing', async () => {
    await mount()
    vi.spyOn(db.budgetAllocations, 'put').mockRejectedValue(new Error('the disk is full'))
    fillForm('Viaje', '100', '10')
    fireEvent.click(screen.getByRole('button', { name: 'Add goal' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('the disk is full')
    expect(await db.savingsGoals.count()).toBe(0)
    expect(screen.getByLabelText(/Name of the goal/)).toHaveValue('Viaje')
  })

  it('says what archiving, completing and changing the share apply to: the whole of the month they happen in', async () => {
    await mount()
    const page = text()
    expect(page).toContain('Archiving or completing a goal applies to this whole month and every month after')
    expect(page).toContain('Changing the share of income applies to the whole of the current month')
    expect(page).not.toContain('from today')
  })

  it('shows the share that is in force this month, which a Budget-screen edit can change, not the one on the goal row', async () => {
    const g = await make()
    await saveAllocation({ categoryId: null, savingsGoalId: g.id, percentBp: 2500, fixedCents: null, effectiveFrom: '2026-11-10', note: null })
    await mount()
    expect(within(card('Viaje inventado')).getByText('Share of income planned').nextElementSibling).toHaveTextContent(formatBp(2500))
    cleanup()
    await saveAllocation({ categoryId: null, savingsGoalId: g.id, percentBp: null, fixedCents: 4000, effectiveFrom: '2026-11-12', note: null })
    await mount()
    expect(within(card('Viaje inventado')).getByText('Share of income planned').nextElementSibling).toHaveTextContent(`a fixed ${formatEur(4000)} a month`)
  })

  it('tells the owner a goal that has reached its target keeps taking a share until it is marked completed', async () => {
    await make('Viaje inventado', 5000)
    await months([['2026-08', 1000], ['2026-09', 2000], ['2026-10', 3000]])
    await mount()
    expect(card('Viaje inventado')).toHaveTextContent('keeps receiving a share of your savings until you mark it as completed')
    fireEvent.click(screen.getByRole('button', { name: /Mark as completed: Viaje inventado/ }))
    await waitFor(() => expect(card('Viaje inventado')).toHaveTextContent('You marked this goal as completed.'))
    expect(card('Viaje inventado')).not.toHaveTextContent('keeps receiving a share')
  })

  it('explains how savings are shared between goals', async () => {
    await mount()
    const page = text()
    expect(page).toContain('shared between your goals in proportion to the share of income you set for each')
    expect(page).toContain('no goal receives more than its planned amount for that month')
    expect(page).toContain('Savings beyond what your goals plan belong to no goal')
    expect(page).toContain('the whole month it was created in, including days before you created it')
  })

  it('keeps focus after an edit, and renders no control that does nothing', async () => {
    await make()
    await mount()
    // A goal short of its target offers edit and archive, and no completion.
    expect(within(card('Viaje inventado')).queryByRole('button', { name: /Mark as completed/ })).toBeNull()
    for (const b of screen.getAllByRole('button')) expect(b, b.textContent ?? '').toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: /Edit goal: Viaje inventado/ }))
    expect(document.activeElement).toBe(screen.getByLabelText(/Name of the goal/, { selector: 'input[value="Viaje inventado"]' }))
    fireEvent.change(screen.getByLabelText(/Name of the goal/, { selector: 'input[value="Viaje inventado"]' }), { target: { value: 'Viaje a Lisboa' } })
    fireEvent.change(screen.getAllByLabelText(/Target amount/)[0] as HTMLElement, { target: { value: '2.000' } })
    fireEvent.change(screen.getAllByLabelText(/Share of income to put toward it/)[0] as HTMLElement, { target: { value: '20' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    const heading = await screen.findByRole('heading', { level: 3, name: 'Viaje a Lisboa' })
    expect(document.activeElement).toBe(heading)
    const [g] = await db.savingsGoals.toArray()
    expect(g).toMatchObject({ name: 'Viaje a Lisboa', targetCents: 200000, contributionPercentBp: 2000 })
    // The changed percentage is a new allocation from today; the one it replaced is history.
    expect((await db.budgetAllocations.toArray()).map((a) => [a.effectiveFrom, a.percentBp]).sort()).toEqual([['2026-01-15', 1000], [TODAY, 2000]])
    // Cancelling an edit puts focus back on the goal.
    fireEvent.click(screen.getByRole('button', { name: /Edit goal: Viaje a Lisboa/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 3, name: 'Viaje a Lisboa' }))
  })

  it('says a goal has reached its target, and marks it completed at the instant it was given', async () => {
    await make('Viaje inventado', 5000)
    await months([['2026-08', 1000], ['2026-09', 2000], ['2026-10', 3000]])
    await mount()
    expect(within(card('Viaje inventado')).getByText('When it might be reached').nextElementSibling).toHaveTextContent('has reached the target')
    fireEvent.click(screen.getByRole('button', { name: /Mark as completed: Viaje inventado/ }))
    await waitFor(() => expect(within(card('Viaje inventado')).getByText('When it might be reached').nextElementSibling).toHaveTextContent('You marked this goal as completed.'))
    expect(within(card('Viaje inventado')).queryByRole('button', { name: /Mark as completed/ })).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 3, name: 'Viaje inventado' }))
    expect((await db.savingsGoals.toArray())[0]?.completedAt).toBe(AT)
  })

  it('moves an archived goal to a quieter list, hands focus on, and keeps it archived after a reload', async () => {
    await make('Viaje inventado')
    await make('Coche inventado')
    await mount()
    fireEvent.click(screen.getByRole('button', { name: /Archive goal: Coche inventado/ }))
    const archived = await screen.findByRole('list', { name: 'Archived savings goals' })
    expect(archived).toHaveTextContent('Coche inventado')
    expect(screen.queryByRole('heading', { level: 3, name: 'Coche inventado' })).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 3, name: 'Viaje inventado' }))
    expect(within(archived).queryByRole('button')).toBeNull()
    const goal = (await db.savingsGoals.toArray()).find((g) => g.name === 'Coche inventado')
    expect(goal?.archived).toBe(true)
    expect((await db.budgetAllocations.where('savingsGoalId').equals(goal?.id ?? '').toArray()).some((a) => a.percentBp === 0 && a.effectiveFrom === TODAY)).toBe(true)
    cleanup()
    await mount()
    expect(screen.getByRole('list', { name: 'Archived savings goals' })).toHaveTextContent('Coche inventado')
    expect(screen.queryByRole('heading', { level: 3, name: 'Coche inventado' })).toBeNull()
    // Archiving the last active goal leaves focus on the region heading, with the form open for a new one.
    fireEvent.click(screen.getByRole('button', { name: /Archive goal: Viaje inventado/ }))
    await waitFor(() => expect(screen.queryByRole('heading', { level: 3, name: 'Viaje inventado' })).toBeNull())
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 2, name: 'Your goals' }))
    expect(text()).toContain('You have not set a savings goal yet')
  })

  it('says it could not read the goals when the store fails', async () => {
    vi.spyOn(db.savingsGoals, 'toArray').mockRejectedValue(new Error('the store is gone'))
    render(<Goals today={TODAY} computedAt={AT} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Your savings goals could not be worked out (the store is gone).')
  })

  it('uses no causal, shaming, means-assuming or statistical wording anywhere on the page', async () => {
    await make()
    await make('Coche inventado', 5000)
    await months([['2026-06', 0], ['2026-07', 0], ['2026-08', 1000], ['2026-09', 2000], ['2026-10', 3000]])
    await mount()
    expect(violations(said())).toEqual([])
    expect(said()).not.toContain('Viaje inventado') // the owner's own words are not the app's
    fireEvent.click(screen.getByRole('button', { name: /Edit goal: Viaje inventado/ }))
    expect(violations(said())).toEqual([])
  })
})
