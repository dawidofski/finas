import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import Learning from './Learning'
import { db } from '../../db/db'
import { seedDatabase } from '../../db/seed'
import { saveAllocation } from '../../budget/allocations'
import * as advice from '../../advice/recommendations'
import { recommendationsFor } from '../../advice/recommendations'
import { challengesFor, noteFor } from '../../advice/education'
import { SNOOZE_DAYS, SUPPRESS_AFTER_REJECTIONS } from '../../advice/state'
import { formatEur } from '../../lib/money'
import { BANNED_LISTS, WORDING_LISTS } from '../../test/bannedWords'
import type { TransactionRow } from '../../db/schema'
import { ROUTES } from '../routes'

const GROCERIES: [string, string] = ['Alimentación', 'Supermercados y alimentación']
const RESTAURANTS: [string, string] = ['Ocio y viajes', 'Cafeterías y restaurantes']
const TODAY = '2026-11-10'
const AT = 1_700_000_000_000
const DAY = 86_400_000
const SMALL = 'small-purchases-add-up'
const OVER = 'overspent-category:cat.restaurants'
const SMALL_TITLE = 'Small purchases add up'
const OVER_TITLE = 'A line has passed its figure'

let uid = 0
const tx = async (id: string, valueDate: string, amountCents: number, ing: [string, string] | null = null, description = 'Movimiento inventado'): Promise<void> => {
  const row: TransactionRow = {
    id, accountId: 'acc.1', valueDate, amountCents, balanceCents: 0, description, comment: null,
    ingCategory: ing?.[0] ?? null, ingSubcategory: ing?.[1] ?? null, kind: amountCents > 0 ? 'income' : 'spend',
    dedupKey: `k.${++uid}`, importId: 'imp.1', fileSeq: uid, roundupParentId: null, createdAt: 1, deletedAt: null,
  }
  await db.transactions.add(row)
}

/** Ten small purchases in November (the small-purchases advice). */
async function smallOnly(): Promise<void> {
  for (let i = 1; i <= 10; i++) await tx(`s${i}`, `2026-11-0${i === 10 ? 9 : i}`, -500, GROCERIES, `Compra pequena ${i}`)
}
/** Those, plus one restaurant line 100 % over what the owner set (the overspend advice, which comes first). */
async function twoAdvices(): Promise<void> {
  await smallOnly()
  await tx('big', '2026-11-04', -20000, RESTAURANTS, 'Cena grande')
  await saveAllocation({ categoryId: 'cat.restaurants', savingsGoalId: null, percentBp: null, fixedCents: 10000, effectiveFrom: '2026-01-01', note: null })
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })
beforeEach(async () => {
  uid = 0
  await db.delete(); await db.open(); await seedDatabase()
})

const mount = async (computedAt = AT) => {
  const view = render(<Learning today={TODAY} computedAt={computedAt} />)
  await screen.findByRole('heading', { level: 1, name: 'Learning' })
  // The first load of a cold run reads the whole battery, and the full suite runs seventy files at once: a second is not enough.
  await waitFor(() => expect(screen.queryByText(/Loading your advice/)).toBeNull(), { timeout: 8000 })
  return view
}
const text = () => document.body.textContent ?? ''
/** Space-separated element text (the idea of spoken() in Score.test.tsx): textContent runs adjacent elements together, and a word boundary then misses a word at an element edge. */
const spokenOf = (root: HTMLElement): string => {
  const clone = root.cloneNode(true) as HTMLElement
  for (const el of clone.querySelectorAll('*')) { el.insertAdjacentText('beforebegin', ' '); el.insertAdjacentText('afterend', ' ') }
  return clone.textContent ?? ''
}
/** The app's own words: the owner's words (<q>) are taken out of the scan, as in Intelligence.test.tsx. */
const appWords = (): string => {
  const clone = document.body.cloneNode(true) as HTMLElement
  for (const q of clone.querySelectorAll('q')) q.remove()
  return spokenOf(clone)
}
const cards = () => screen.queryAllByRole('article')
const cardOf = (heading: string): HTMLElement => screen.getByRole('heading', { level: 3, name: heading }).closest('article') as HTMLElement
const states = async () => Object.fromEntries((await db.recommendationState.toArray()).map((r) => [r.key, r]))
const REJECT = { name: 'Reject' }
const SNOOZE = { name: `Snooze for ${SNOOZE_DAYS} days` }

describe('Learning screen', () => {
  it('shows nothing to act on yet, without reading as a failure, on a fresh install', async () => {
    await mount()
    expect(screen.getByText(/There is nothing to act on yet/)).toBeInTheDocument()
    expect(text()).toMatch(/normal starting point/)
    // It says what makes advice appear, and where to begin.
    expect(text()).toMatch(/Advice appears when your records show something worth a look/)
    expect(screen.getByRole('link', { name: 'import your bank statements' })).toHaveAttribute('href', '#/import')
    expect(cards()).toHaveLength(0)
    // Not an error: no alert, no refusal styling, no word of failure.
    expect(screen.queryByRole('alert')).toBeNull()
    expect(document.querySelector('.notice-refusal')).toBeNull()
    expect(text()).not.toMatch(/could not|failed|error|went wrong/i)
    // And no stored decision was invented for advice that was never shown.
    expect(await db.recommendationState.count()).toBe(0)
  })

  it('shows all six fields of a recommendation, with its evidence inspectable', async () => {
    await smallOnly()
    await mount()
    const [rec] = await recommendationsFor('2026-11', TODAY, AT)
    expect(rec?.id).toBe(SMALL)
    const card = cardOf(SMALL_TITLE)
    const field = (term: string): string => within(card).getByText(term, { selector: 'dt' }).nextElementSibling?.textContent ?? ''
    expect(field('What was noticed')).toBe(rec?.noticed)
    expect(field('What this means')).toBe(rec?.why)
    expect(field('What to do differently')).toBe(rec?.todo)
    expect(field('Confidence')).toBe('Medium')
    expect(field('Evidence')).toContain(rec?.evidence.summary)
    // Inspectable: the purchases themselves, each with its date, its amount and the owner's own description.
    const rows = card.querySelectorAll('ul[aria-label="Purchases behind this advice"] li')
    expect(rows).toHaveLength(10)
    expect(rows[0]?.textContent).toContain('Compra pequena 1')
    expect(rows[0]?.textContent).toContain('01/11/2026')
    expect(rows[0]?.textContent).toContain(formatEur(-500))
    expect(card.querySelector('details')).not.toBeNull()
  })

  it('shows no impact figure, and no zero, where there is no honest estimate', async () => {
    await smallOnly()
    await mount()
    expect((await recommendationsFor('2026-11', TODAY, AT))[0]?.impactCents).toBeNull()
    const card = cardOf(SMALL_TITLE)
    expect(within(card).queryByText('Estimated impact')).toBeNull()
    expect(card.textContent).not.toMatch(/\b0,00/)
    cleanup()
    await db.transactions.clear()
    await twoAdvices()
    await mount()
    // The overspend carries one: 100 EUR above the line the owner set.
    const over = cardOf(OVER_TITLE)
    expect(within(over).getByText('Estimated impact', { selector: 'dt' }).nextElementSibling?.textContent).toContain(formatEur(10000))
  })

  it('says some purchases are gone from the records, instead of a blank row, when evidence was deleted since', async () => {
    await smallOnly()
    // The advice was worked out before the deletion; a tab left open shows it after.
    const stale = await recommendationsFor('2026-11', TODAY, AT)
    await db.transactions.update('s3', { deletedAt: 5 })
    await db.transactions.update('s4', { deletedAt: 5 })
    vi.spyOn(advice, 'recommendationsFor').mockResolvedValue(stale)
    await mount()
    const card = cardOf(SMALL_TITLE)
    expect(card.querySelectorAll('ul[aria-label="Purchases behind this advice"] li')).toHaveLength(8)
    expect(card.textContent).toMatch(/2 of the purchases behind this are no longer in your records/)
    expect(card.textContent).not.toMatch(/No description/)
    cleanup()
    // Nothing deleted: nothing said.
    await db.transactions.update('s3', { deletedAt: null })
    await db.transactions.update('s4', { deletedAt: null })
    await mount()
    expect(text()).not.toMatch(/no longer in your records/)
  })

  it('records each showing once, before the owner can act, and not again on a re-render', async () => {
    await smallOnly()
    const view = await mount()
    const [rec] = await recommendationsFor('2026-11', TODAY, AT)
    expect((await states())[SMALL]).toMatchObject({ shownCount: 1, lastShownAt: AT, evidenceFingerprint: rec?.evidenceFingerprint, status: 'active' })
    // The same props again, and a click that only opens the evidence: neither is a new showing.
    view.rerender(<Learning today={TODAY} computedAt={AT} />)
    fireEvent.click(within(cardOf(SMALL_TITLE)).getByText('Show the purchases'))
    await new Promise((r) => setTimeout(r, 20))
    expect((await states())[SMALL]?.shownCount).toBe(1)
  })

  it('lets the owner reject a recommendation, and stops showing it after the second time', async () => {
    await smallOnly()
    expect(SUPPRESS_AFTER_REJECTIONS).toBe(2)
    await mount()
    fireEvent.click(within(cardOf(SMALL_TITLE)).getByRole('button', REJECT))
    await waitFor(() => expect(cards()).toHaveLength(0))
    expect((await states())[SMALL]).toMatchObject({ status: 'rejected', rejectedCount: 1 })
    // The first rejection is "not now": a fresh screen (nothing carried in component state) shows it again.
    cleanup()
    await mount()
    expect(cards()).toHaveLength(1)
    expect((await states())[SMALL]?.shownCount).toBe(2) // shown again, which is what makes the second rejection count
    fireEvent.click(within(cardOf(SMALL_TITLE)).getByRole('button', REJECT))
    await waitFor(() => expect(cards()).toHaveLength(0))
    expect((await states())[SMALL]).toMatchObject({ status: 'suppressed', rejectedCount: 2 })
    // Reload, a long time later, same evidence: gone for good.
    cleanup()
    await mount(AT + 400 * DAY)
    expect(cards()).toHaveLength(0)
    expect(screen.getByText(/There is nothing to act on yet/)).toBeInTheDocument()
  })

  it('says plainly what each choice does, including that a second rejection removes it for good and how long a snooze lasts', async () => {
    await smallOnly()
    await mount()
    expect(SUPPRESS_AFTER_REJECTIONS).toBe(2)
    expect(text()).toContain('Rejecting the same advice a second time removes it for good')
    expect(text()).toContain(`Snooze hides it for ${SNOOZE_DAYS} days`)
    expect(screen.getByRole('button', SNOOZE)).toBeInTheDocument()
  })

  it('offers accept, snooze and reject, and each writes the state it claims to', async () => {
    await twoAdvices()
    await mount()
    expect(cards()).toHaveLength(2)
    for (const c of cards()) {
      expect(within(c).getByRole('button', { name: 'Accept' })).toBeInTheDocument()
      expect(within(c).getByRole('button', SNOOZE)).toBeInTheDocument()
      expect(within(c).getByRole('button', REJECT)).toBeInTheDocument()
    }
    const over = (await recommendationsFor('2026-11', TODAY, AT)).find((r) => r.key === OVER)

    fireEvent.click(within(cardOf(OVER_TITLE)).getByRole('button', { name: 'Accept' }))
    await waitFor(() => expect(cards()).toHaveLength(1))
    expect((await states())[OVER]).toMatchObject({ status: 'accepted', evidenceFingerprint: over?.evidenceFingerprint })

    fireEvent.click(within(cardOf(SMALL_TITLE)).getByRole('button', SNOOZE))
    await waitFor(() => expect(cards()).toHaveLength(0))
    expect((await states())[SMALL]).toMatchObject({ status: 'snoozed', suppressedUntil: AT + SNOOZE_DAYS * DAY })

    // Remounted: the accepted advice stays away on the same evidence, the snooze holds until its day, and then it returns.
    cleanup()
    await mount()
    expect(cards()).toHaveLength(0)
    cleanup()
    await mount(AT + SNOOZE_DAYS * DAY)
    expect(cards()).toHaveLength(1)
    expect(within(cards()[0] as HTMLElement).getByRole('heading', { level: 3 })).toHaveTextContent(SMALL_TITLE)
  })

  it('shows the note attached to a recommendation beside it, never on its own', async () => {
    await twoAdvices()
    await mount()
    const small = cardOf(SMALL_TITLE)
    const note = noteFor('small-purchases-add-up')
    expect(note).not.toBeNull()
    expect(within(small).getByRole('heading', { level: 4, name: note?.title })).toBeInTheDocument()
    expect(small.textContent).toContain(note?.body)
    // The other advice's note is beside that one and not here; a note whose advice is not shown is nowhere.
    expect(small.textContent).not.toContain(noteFor('overspent-category')?.body)
    expect(cardOf(OVER_TITLE).textContent).toContain(noteFor('overspent-category')?.body)
    for (const id of ['savings-inconsistent', 'unusual-spend', 'discretionary-rising', 'regret-cluster'] as const) expect(text()).not.toContain(noteFor(id)?.body)
    // Fresh install: no advice, so no lesson either.
    cleanup()
    await db.delete(); await db.open(); await seedDatabase()
    await mount()
    for (const id of ['overspent-category', 'small-purchases-add-up'] as const) expect(text()).not.toContain(noteFor(id)?.body)
    expect(screen.queryAllByRole('heading', { level: 4 })).toHaveLength(0)
  })

  it('says which challenge cannot run yet and why, rather than hiding it', async () => {
    await smallOnly()
    await mount()
    const all = challengesFor('small-purchases-add-up', false)
    expect(all.some((c) => !c.available)).toBe(true)
    const items = within(cardOf(SMALL_TITLE)).getByRole('list', { name: 'Challenges you can try' })
    expect(within(items).getAllByRole('listitem')).toHaveLength(all.length)
    for (const c of all) {
      const li = within(items).getByRole('heading', { level: 5, name: c.title }).closest('li') as HTMLElement
      expect(li.textContent).toContain(c.body)
      if (c.available) expect(li.textContent).not.toMatch(/Not available yet/)
      else { expect(li.textContent).toContain('Not available yet'); expect(li.textContent).toContain(c.why) }
    }
    // Recurring data present: the same challenge is offered and says nothing of the kind.
    cleanup()
    await db.recurring.add({ id: 'r1' } as never)
    await mount()
    expect(within(cardOf(SMALL_TITLE)).queryByText(/Not available yet/)).toBeNull()
  })

  it('uses no causal, shaming or statistical wording anywhere on the page', async () => {
    const lists = [...BANNED_LISTS, ...WORDING_LISTS]
    for (const list of lists) {
      expect(list.forbids, list.name).toMatch(list.pattern)
      expect(list.allows, list.name).not.toMatch(list.pattern)
    }
    for (const setup of [async () => {}, twoAdvices]) {
      cleanup()
      await db.delete(); await db.open(); await seedDatabase()
      await setup()
      await mount()
      const page = appWords()
      expect(page).toContain(setup === twoAdvices ? 'A line has passed its figure' : 'There is nothing to act on yet')
      if (setup === twoAdvices) { expect(cards()).toHaveLength(2); expect(page).toContain('Snooze'); expect(page).toContain('Not available yet') }
      for (const list of lists) expect(page, list.name).not.toMatch(list.pattern)
    }
  })

  it('renders the owners own words as theirs, and the scan leaves them out', async () => {
    await smallOnly()
    await mount()
    expect([...document.querySelectorAll('q')].map((q) => q.textContent)).toContain('Compra pequena 1')
    expect(appWords()).not.toContain('Compra pequena')
    expect(spokenOf(document.body)).toContain('Compra pequena 1')
  })

  it('keeps focus after an action, on the next piece of advice or else the heading', async () => {
    await twoAdvices()
    await mount()
    fireEvent.click(within(cardOf(OVER_TITLE)).getByRole('button', REJECT))
    await waitFor(() => expect(cards()).toHaveLength(1))
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 3, name: SMALL_TITLE }))
    fireEvent.click(within(cardOf(SMALL_TITLE)).getByRole('button', { name: 'Accept' }))
    await waitFor(() => expect(cards()).toHaveLength(0))
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 2 }))
  })

  it('renders no control that does nothing', async () => {
    await twoAdvices()
    await mount()
    expect(document.querySelectorAll('[disabled], [aria-disabled="true"]')).toHaveLength(0)
    // The only tabindex is -1, there so the screen can place focus; nothing is added to the tab order.
    for (const el of document.querySelectorAll('[tabindex]')) expect(el.getAttribute('tabindex')).toBe('-1')
    const names = screen.getAllByRole('button').map((b) => b.textContent)
    expect(names).toHaveLength(6)
    expect(names.every((n) => ['Accept', `Snooze for ${SNOOZE_DAYS} days`, 'Reject'].includes(n ?? ''))).toBe(true)
    for (const a of screen.queryAllByRole('link')) expect(ROUTES.map((r) => '#' + r.path)).toContain(a.getAttribute('href'))
  })

  it('says the advice could not be worked out, and offers nothing to press, when the store fails', async () => {
    await smallOnly()
    vi.spyOn(db.recommendationState, 'bulkGet').mockRejectedValue(new Error('the store is gone'))
    render(<Learning today={TODAY} computedAt={AT} />)
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Your advice could not be worked out (the store is gone). Nothing was changed.')
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })

  it('keeps the card and says so when a choice cannot be stored', async () => {
    await smallOnly()
    await mount()
    vi.spyOn(db.recommendationState, 'put').mockRejectedValue(new Error('disk full'))
    fireEvent.click(within(cardOf(SMALL_TITLE)).getByRole('button', { name: 'Accept' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be saved')
    expect(cards()).toHaveLength(1)
  })
})
