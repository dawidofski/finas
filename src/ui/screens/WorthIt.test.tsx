import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import WorthIt from './WorthIt'
import { spoken } from '../../test/spoken'
import { db } from '../../db/db'
import { seedDatabase } from '../../db/seed'
import { writeAnnotation } from '../../db/annotations'
import type { TransactionRow } from '../../db/schema'
import { guardWording } from '../../test/wording'

const TODAY = '2026-11-16'
let seq = 0
const tx = async (id: string, valueDate: string, withMood = true) => {
  const row: TransactionRow = {
    id, accountId: 'acc.1', valueDate, amountCents: -1250, balanceCents: 0, description: `Compra ${id}`, comment: null,
    ingCategory: 'Ocio y viajes', ingSubcategory: 'Cafeterías y restaurantes', kind: 'spend', dedupKey: `k.${id}`, importId: 'imp.1',
    fileSeq: ++seq, roundupParentId: null, createdAt: 1, deletedAt: null,
  }
  await db.transactions.add(row)
  if (withMood) await writeAnnotation(id, { moodId: 'mood.happy' }, 'owner')
}
const card = () => screen.findByRole('article', { name: 'Transaction to review' })
const tap = (name: RegExp | string) => fireEvent.click(screen.getByRole('button', { name }))
const worthwhile = async (id: string) => (await db.annotations.get(id))?.worthwhile

beforeEach(async () => {
  seq = 0
  await db.delete(); await db.open(); await seedDatabase()
})
afterEach(() => { vi.restoreAllMocks() })

guardWording(5, '.mood-label, .mood-desc, .chip, .mood-btn')

describe('WorthIt screen', () => {
  it('presents one eligible transaction at a time, oldest first, and writes the answer', async () => {
    await tx('new', '2026-11-05')
    await tx('old', '2026-11-01')
    await tx('too-young', '2026-11-14')
    await tx('no-mood', '2026-11-02', false)
    render(<WorthIt today={TODAY} />)
    expect(await card()).toHaveTextContent('Compra old')
    expect(screen.getByText('2 waiting')).toBeInTheDocument()
    tap('Worth it')
    await waitFor(() => expect(screen.getByRole('article')).toHaveTextContent('Compra new'))
    expect(await worthwhile('old')).toBe(true)
    tap('Not worth it')
    expect(await screen.findByText(/nothing waiting/)).toBeInTheDocument()
    expect(await worthwhile('new')).toBe(false)
  })

  it('writes nothing when a transaction is skipped, and offers it again', async () => {
    await tx('a', '2026-11-01')
    await tx('b', '2026-11-02')
    render(<WorthIt today={TODAY} />)
    await card()
    const before = await db.annotations.toArray()
    tap('Skip for now')
    await waitFor(() => expect(screen.getByRole('article')).toHaveTextContent('Compra b'))
    expect(await db.learningEvents.count()).toBe(0)
    tap('Skip for now')
    expect(await screen.findByRole('status')).toHaveTextContent(/set aside 2 for later/)
    expect(await db.annotations.toArray()).toEqual(before)
    expect(await worthwhile('a')).toBeNull()
    tap('Look at them again')
    expect(await card()).toHaveTextContent('Compra a')
    // The empty state that held focus is gone; focus must land inside the card, not fall to <body>.
    await waitFor(() => expect(screen.getByRole('article')).toContainElement(document.activeElement as HTMLElement))
    expect(document.activeElement).not.toBe(document.body)
  })

  it('goes back, shows the stored answer, changes it in place, and can clear it', async () => {
    await tx('a', '2026-11-01')
    await tx('b', '2026-11-02')
    render(<WorthIt today={TODAY} />)
    await card()
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled()
    tap('Worth it')
    await waitFor(() => expect(screen.getByRole('article')).toHaveTextContent('Compra b'))
    tap('Back')
    await waitFor(() => expect(screen.getByRole('article')).toHaveTextContent('Compra a'))
    expect(screen.getByRole('button', { name: 'Worth it' })).toHaveAttribute('aria-pressed', 'true')
    tap('Not worth it')
    await waitFor(() => expect(screen.getByRole('article')).toHaveTextContent('Compra b'))
    expect(await worthwhile('a')).toBe(false)
    tap('Back')
    await waitFor(() => expect(screen.getByRole('article')).toHaveTextContent('Compra a'))
    tap('Not rated')
    await waitFor(() => expect(screen.getByRole('article')).toHaveTextContent('Compra b'))
    expect(await worthwhile('a')).toBeNull()
  })

  it('offers Not rated only when revisiting, so no button is live and inert', async () => {
    await tx('a', '2026-11-01')
    await tx('b', '2026-11-02')
    render(<WorthIt today={TODAY} />)
    await card()
    expect(screen.queryByRole('button', { name: 'Not rated' })).toBeNull()
    tap('Worth it')
    await waitFor(() => expect(screen.getByRole('article')).toHaveTextContent('Compra b'))
    tap('Back')
    expect(await screen.findByRole('button', { name: 'Not rated' })).toBeInTheDocument()
  })

  it('keeps focus working through the queue and announces each card', async () => {
    await tx('a', '2026-11-01')
    await tx('b', '2026-11-02')
    render(<WorthIt today={TODAY} />)
    await card()
    const live = document.querySelector('[aria-live="polite"]') as HTMLElement
    expect(live).toHaveTextContent(/^1 of 2: Compra a/)
    tap('Worth it')
    await waitFor(() => expect(screen.getByRole('article')).toHaveTextContent('Compra b'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Worth it' })).toHaveFocus())
    expect(live).toHaveTextContent(/^2 of 2: Compra b/)
    tap('Not worth it')
    const empty = (await screen.findByText(/nothing waiting/)).closest('div') as HTMLElement
    await waitFor(() => expect(empty).toHaveFocus())
  })

  it('mounts the announcement region while loading, so the first card is announced', async () => {
    await tx('a', '2026-11-01')
    const { container } = render(<WorthIt today={TODAY} />)
    const live = container.querySelector('[aria-live="polite"]') as HTMLElement
    expect(live).not.toBeNull()
    expect(screen.queryByRole('article')).toBeNull() // still loading
    await card()
    expect(container.querySelector('[aria-live="polite"]')).toBe(live) // the same node, not a new one
    expect(live).toHaveTextContent(/^1 of 1: Compra a/)
  })

  it('moves focus to the empty state when the last item is skipped', async () => {
    await tx('a', '2026-11-01')
    render(<WorthIt today={TODAY} />)
    await card()
    fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }))
    const empty = (await screen.findByText(/set aside 1 for later/)).closest('div') as HTMLElement
    await waitFor(() => expect(empty).toHaveFocus())
  })

  it('makes the announcement differ between two identical transactions', async () => {
    await tx('a', '2026-11-01')
    const a = await db.transactions.get('a')
    await db.transactions.add({ ...a!, id: 'b', dedupKey: 'k.b', fileSeq: 99 }) // truly identical rows
    await writeAnnotation('b', { moodId: 'mood.happy' }, 'owner')
    render(<WorthIt today={TODAY} />)
    await card()
    const live = document.querySelector('[aria-live="polite"]') as HTMLElement
    const first = live.textContent
    fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }))
    await waitFor(() => expect(live.textContent).not.toBe(first))
  })

  it('says an empty queue is nothing waiting, not a reproach', async () => {
    render(<WorthIt today={TODAY} />)
    const status = (await screen.findByText(/nothing waiting/)).closest('[role="status"]') as HTMLElement
    expect(spoken(status)).not.toMatch(/behind|overdue|should|failed/i)
  })

  it('changing the delay setting changes what is offered', async () => {
    await tx('a', '2026-11-12') // 4 days old
    render(<WorthIt today={TODAY} />)
    expect(await screen.findByText(/nothing waiting/)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/days old/), { target: { value: '3' } })
    tap('Save')
    expect(await card()).toHaveTextContent('Compra a')
    expect((await db.settings.get('singleton'))?.worthwhileDelayDays).toBe(3)
  })

  it('refuses a delay that is not a whole number and saves nothing', async () => {
    render(<WorthIt today={TODAY} />)
    await screen.findByText(/nothing waiting/)
    fireEvent.change(screen.getByLabelText(/days old/), { target: { value: 'abc' } })
    tap('Save')
    expect(await screen.findByRole('alert')).toHaveTextContent(/whole number/)
    expect((await db.settings.get('singleton'))?.worthwhileDelayDays).toBeUndefined()
  })

  it('says nothing was changed when a save fails', async () => {
    await tx('a', '2026-11-01')
    render(<WorthIt today={TODAY} />)
    await card()
    vi.spyOn(db.annotations, 'put').mockRejectedValue(new Error('disk full'))
    tap('Worth it')
    expect(await screen.findByRole('alert')).toHaveTextContent('nothing was changed')
    // The refusal is shown before the screen has finished: `busy` clears afterwards and the focus effect runs then.
    // Waiting for the controls to come back settles both and pins that a failed save leaves the queue usable rather
    // than stuck disabled — the same defect class as ruling P3-R32. Only CI timing exposed this one.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Skip for now' })).toBeEnabled())
    vi.restoreAllMocks()
    expect(await worthwhile('a')).toBeNull()
  })
})
