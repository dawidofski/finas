import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import Mood from './Mood'
import { db } from '../../db/db'
import { seedDatabase } from '../../db/seed'
import { writeAnnotation } from '../../db/annotations'
import type { TransactionRow } from '../../db/schema'

let seq = 0
const tx = async (id: string, valueDate: string, ing: [string, string] = ['Ocio y viajes', 'Cafeterías y restaurantes']) => {
  const row: TransactionRow = {
    id, accountId: 'acc.1', valueDate, amountCents: -1250, balanceCents: 0, description: `Compra ${id}`, comment: null,
    ingCategory: ing[0], ingSubcategory: ing[1], kind: 'spend', dedupKey: `k.${id}`, importId: 'imp.1',
    fileSeq: ++seq, roundupParentId: null, createdAt: 1, deletedAt: null,
  }
  await db.transactions.add(row)
}
const card = () => screen.findByRole('article', { name: 'Transaction to review' })
const tapMood = async (label: string, scope?: HTMLElement) =>
  fireEvent.click(await within(scope ?? screen.getByRole('article')).findByRole('button', { name: new RegExp(label) }))

beforeEach(async () => {
  seq = 0
  await db.delete(); await db.open(); await seedDatabase()
})

afterEach(() => { vi.restoreAllMocks() })

describe('Mood screen', () => {
  it('says nothing was changed only when that is true: a failed whole-day write leaves every row alone', async () => {
    await tx('a', '2026-11-03')
    await tx('b', '2026-11-03')
    render(<Mood />)
    await card()
    fireEvent.click(screen.getByRole('button', { name: /whole day/ }))
    const day = await screen.findByRole('region', { name: 'Whole day' })
    const realPut = db.annotations.put.bind(db.annotations)
    let calls = 0
    vi.spyOn(db.annotations, 'put').mockImplementation(((...args: Parameters<typeof realPut>) => {
      calls++
      return calls === 2 ? Promise.reject(new Error('disk full')) : realPut(...args)
    }) as typeof db.annotations.put)
    await tapMood('Relaxed', day)
    expect(await screen.findByRole('alert')).toHaveTextContent('nothing was changed')
    vi.restoreAllMocks()
    expect(await db.annotations.count()).toBe(0)
    expect(await card()).toHaveTextContent('Compra a')
  })

  it('presents one transaction at a time, oldest first', async () => {
    await tx('new', '2026-11-09')
    await tx('old', '2026-11-01')
    await tx('mid', '2026-11-05')
    render(<Mood />)
    expect(await card()).toHaveTextContent('Compra old')
    expect(screen.getAllByRole('article')).toHaveLength(1)
    expect(screen.queryByText('Compra new')).toBeNull()
    expect(screen.getByText('3 waiting')).toBeInTheDocument()

    await tapMood('Happy')
    await waitFor(() => expect(screen.getByRole('article')).toHaveTextContent('Compra mid'))
    expect((await db.annotations.get('old'))?.moodId).toBe('mood.happy')
    expect(await db.annotations.get('mid')).toBeUndefined()
    expect(screen.getByText('2 waiting')).toBeInTheDocument()
  })

  it('goes back to the previous transaction, shows its mood, and changes it in place', async () => {
    await tx('a', '2026-11-01')
    await tx('b', '2026-11-02')
    render(<Mood />)
    await card()
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled()
    await tapMood('Happy')
    await waitFor(() => expect(screen.getByRole('article')).toHaveTextContent('Compra b'))
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    await waitFor(() => expect(screen.getByRole('article')).toHaveTextContent('Compra a'))
    expect(screen.getByRole('button', { name: /Happy/ })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled()
    await tapMood('Sad')
    await waitFor(() => expect(screen.getByRole('article')).toHaveTextContent('Compra b'))
    expect(await db.annotations.count()).toBe(1)
    expect((await db.annotations.get('a'))?.moodId).toBe('mood.sad')
  })

  it('writes nothing when a transaction is skipped, and offers it again', async () => {
    await tx('a', '2026-11-01')
    await tx('b', '2026-11-02')
    render(<Mood />)
    await card()
    fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }))
    await waitFor(() => expect(screen.getByRole('article')).toHaveTextContent('Compra b'))
    expect(await db.annotations.count()).toBe(0)
    expect(await db.learningEvents.count()).toBe(0)
    fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }))
    expect(await screen.findByRole('status')).toHaveTextContent(/set aside 2 for later/)
    expect(await db.annotations.count()).toBe(0)
    fireEvent.click(screen.getByRole('button', { name: 'Look at them again' }))
    expect(await card()).toHaveTextContent('Compra a')
    // The empty state that held focus is gone; focus must land inside the card, not fall to <body>.
    await waitFor(() => expect(screen.getByRole('article')).toContainElement(document.activeElement as HTMLElement))
    expect(document.activeElement).not.toBe(document.body)
  })

  it('does not ask about essentials, and does not list an answered one', async () => {
    await tx('shop', '2026-11-01', ['Alimentación', 'Supermercados y alimentación'])
    await tx('answered', '2026-11-02')
    await tx('open', '2026-11-03')
    await writeAnnotation('answered', { moodId: 'mood.sad' }, 'owner')
    render(<Mood />)
    expect(await card()).toHaveTextContent('Compra open')
    expect(screen.getByText('1 waiting')).toBeInTheDocument()
  })

  it('applies the whole-day mood without overwriting a mood already chosen', async () => {
    await tx('a', '2026-11-03')
    await tx('b', '2026-11-03')
    await tx('c', '2026-11-03')
    await writeAnnotation('c', { moodId: 'mood.guilty' }, 'owner')
    render(<Mood />)
    await card()
    fireEvent.click(screen.getByRole('button', { name: /whole day/ }))
    const day = await screen.findByRole('region', { name: 'Whole day' })
    await tapMood('Relaxed', day)
    expect(await screen.findByText(/Set for 2 transactions/)).toBeInTheDocument()
    expect((await db.annotations.get('a'))?.moodId).toBe('mood.relaxed')
    expect((await db.annotations.get('b'))?.moodId).toBe('mood.relaxed')
    expect((await db.annotations.get('c'))?.moodId).toBe('mood.guilty')
    expect(await screen.findByText(/nothing waiting/)).toBeInTheDocument()
  })

  it('asks nothing when the setting is off, and can turn it back on', async () => {
    await tx('a', '2026-11-01')
    await db.settings.update('singleton', { moodPrompting: { enabled: false } })
    render(<Mood />)
    expect(await screen.findByText(/Mood prompts are turned off/)).toBeInTheDocument()
    expect(screen.queryByRole('article')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Turn mood prompts on' }))
    expect(await card()).toHaveTextContent('Compra a')
  })

  it('keeps focus working through the queue and announces each card', async () => {
    await tx('a', '2026-11-01')
    await tx('b', '2026-11-02')
    render(<Mood />)
    await card()
    const live = document.querySelector('[aria-live="polite"]') as HTMLElement
    expect(live).toHaveTextContent(/^1 of 2: Compra a/)
    await tapMood('Happy')
    await waitFor(() => expect(screen.getByRole('article')).toHaveTextContent('Compra b'))
    const first = screen.getByRole('article').querySelector('.mood-row button') as HTMLElement
    await waitFor(() => expect(first).toHaveFocus())
    expect(live).toHaveTextContent(/^2 of 2: Compra b/)
    await tapMood('Happy')
    const empty = (await screen.findByText(/nothing waiting/)).closest('div') as HTMLElement
    await waitFor(() => expect(empty).toHaveFocus())
  })

  it('mounts the announcement region while loading, so the first card is announced', async () => {
    await tx('a', '2026-11-01')
    const { container } = render(<Mood />)
    const live = container.querySelector('[aria-live="polite"]') as HTMLElement
    expect(live).not.toBeNull()
    expect(screen.queryByRole('article')).toBeNull() // still loading
    await card()
    expect(container.querySelector('[aria-live="polite"]')).toBe(live) // the same node, not a new one
    expect(live).toHaveTextContent(/^1 of 1: Compra a/)
  })

  it('moves focus to the empty state when the last item is skipped', async () => {
    await tx('a', '2026-11-01')
    render(<Mood />)
    await card()
    fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }))
    const empty = (await screen.findByText(/set aside 1 for later/)).closest('div') as HTMLElement
    await waitFor(() => expect(empty).toHaveFocus())
  })

  it('makes the announcement differ between two identical transactions', async () => {
    await tx('a', '2026-11-01')
    const a = await db.transactions.get('a')
    await db.transactions.add({ ...a!, id: 'b', dedupKey: 'k.b', fileSeq: 99 }) // truly identical rows
    render(<Mood />)
    await card()
    const live = document.querySelector('[aria-live="polite"]') as HTMLElement
    const first = live.textContent
    fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }))
    await waitFor(() => expect(live.textContent).not.toBe(first))
  })

  it('says the queue is empty in a way that is not a reproach', async () => {
    render(<Mood />)
    expect(await screen.findByText(/nothing waiting/)).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/behind|overdue|missed|should have|failed|catch up|not yet/i)
  })
})
