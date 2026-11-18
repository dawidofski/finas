import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import Score from './Score'
import { db } from '../../db/db'
import { seedDatabase } from '../../db/seed'
import { saveAllocation } from '../../budget/allocations'
import { moneyScore, WEIGHTS, type ComponentId } from '../../score/score'
import { BANNED_LISTS, causalWords, jargonWords, noJargon } from '../../test/bannedWords'
import { transactionRowReads } from '../../test/reads'
import type { TransactionRow } from '../../db/schema'
import { learning, savingsConsistency, spendingAwareness } from '../../score/components'
import { regretClusters } from '../../learning/regret'

// Pass-throughs that remember how they were called, so the windows the screen asks about can be read back.
vi.mock('../../score/components', async (original) => {
  const real = await original<typeof import('../../score/components')>()
  return { ...real, spendingAwareness: vi.fn(real.spendingAwareness), learning: vi.fn(real.learning), savingsConsistency: vi.fn(real.savingsConsistency) }
})
vi.mock('../../learning/regret', async (original) => {
  const real = await original<typeof import('../../learning/regret')>()
  return { ...real, regretClusters: vi.fn(real.regretClusters) }
})

const GROCERIES: [string, string] = ['Alimentación', 'Supermercados y alimentación']
const RESTAURANTS: [string, string] = ['Ocio y viajes', 'Cafeterías y restaurantes']
const TODAY = '2026-11-10'
const AT = 1_700_000_000_000

let uid = 0
const tx = async (id: string, valueDate: string, amountCents: number, ing: [string, string] | null = null): Promise<void> => {
  const row: TransactionRow = {
    id, accountId: 'acc.1', valueDate, amountCents, balanceCents: 0, description: 'Movimiento inventado', comment: null,
    ingCategory: ing?.[0] ?? null, ingSubcategory: ing?.[1] ?? null, kind: amountCents > 0 ? 'income' : 'spend',
    dedupKey: `k.${++uid}`, importId: 'imp.1', fileSeq: uid, roundupParentId: null, createdAt: 1, deletedAt: null,
  }
  await db.transactions.add(row)
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })
beforeEach(async () => {
  uid = 0
  await db.delete(); await db.open(); await seedDatabase()
})

const settled = async () => {
  await screen.findByRole('heading', { level: 1, name: 'Money Score' })
  await waitFor(() => expect(screen.queryByText(/Loading your Money Score/)).toBeNull())
}
const mount = async () => {
  const view = render(<Score today={TODAY} computedAt={AT} />)
  await settled()
  return view
}
const text = () => document.body.textContent ?? ''
/**
 * What the owner reads, with a space wherever one element ends and the next begins. textContent runs them together
 * ("worked outComponent weight"), and a word boundary in a banned-word pattern never sees a word that starts there,
 * so a scan of textContent passes on wording the pattern exists to forbid.
 */
const spoken = (): string => {
  const clone = document.body.cloneNode(true) as HTMLElement
  for (const el of clone.querySelectorAll('*')) { el.insertAdjacentText('beforebegin', ' '); el.insertAdjacentText('afterend', ' ') }
  return clone.textContent ?? ''
}

/**
 * Two of the six measured, with DIFFERENT weights (budget 3, goals 2) so that the divisor the screen shows can be told from
 * the weight of all six (14), from the number of measured parts (2), and from either one alone:
 *   October: groceries allocated 300, spent 100 (respected); restaurants allocated 100, spent 200 (not) -> 300 of 400 = 75.
 *   Goals: one completed (target 1.000), one not (target 3.000) -> 1.000 of 4.000 = 25.
 *   3 x 75 + 2 x 25 = 275, over a measured weight of 5 = 55.
 */
async function twoMeasured(): Promise<void> {
  await tx('pay', '2026-10-01', 200000)
  await tx('g', '2026-10-03', -10000, GROCERIES)
  await tx('r', '2026-10-04', -20000, RESTAURANTS)
  await saveAllocation({ categoryId: 'cat.groceries', savingsGoalId: null, percentBp: null, fixedCents: 30000, effectiveFrom: '2026-01-01', note: null })
  await saveAllocation({ categoryId: 'cat.restaurants', savingsGoalId: null, percentBp: null, fixedCents: 10000, effectiveFrom: '2026-01-01', note: null })
  await db.savingsGoals.add({ id: 'g1', name: 'Viaje', targetCents: 100000, deadline: null, contributionPercentBp: 0, createdAt: 1, completedAt: 5, archived: false })
  await db.savingsGoals.add({ id: 'g2', name: 'Coche', targetCents: 300000, deadline: null, contributionPercentBp: 0, createdAt: 1, completedAt: null, archived: false })
}

const IDS = Object.keys(WEIGHTS) as ComponentId[]
/** The labels as score.ts owns them, read by handing it six unmeasured parts rather than typed here. */
const LABEL: Record<ComponentId, string> = Object.fromEntries(
  moneyScore(Object.fromEntries(IDS.map((id) => [id, { kind: 'not-measured', why: '' }])) as never).components.map((c) => [c.id, c.label]),
) as Record<ComponentId, string>
const itemOf = (id: ComponentId): HTMLElement => {
  const heading = screen.getByRole('heading', { level: 3, name: LABEL[id] })
  return heading.closest('li') as HTMLElement
}
/** What a definition list says under a term. */
const field = (item: HTMLElement, term: string): string => {
  const dt = within(item).getByText(term, { selector: 'dt' })
  return dt.nextElementSibling?.textContent ?? ''
}

describe('Money Score screen', () => {
  it('says the score cannot be given yet on a fresh install, and shows no number', async () => {
    await mount()
    expect(screen.getByText(/Your Money Score cannot be given yet/)).toBeInTheDocument()
    // No score of any kind: not "0 out of 100", not "0 / 100", not a ring or a meter, not a headline figure.
    expect(text()).not.toMatch(/out of 100/)
    expect(text()).not.toMatch(/\d\s*\/\s*100/)
    expect(text()).not.toMatch(/Your Money Score:/)
    expect(text()).not.toMatch(/How the total is worked out/)
    expect(screen.queryByRole('meter')).toBeNull()
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(document.querySelector('svg, canvas, meter, progress')).toBeNull()
    // It also does not read as a verdict.
    expect(text()).not.toMatch(/Measured:/)
    expect(screen.getByRole('link', { name: 'import your ING statements' })).toHaveAttribute('href', '#/import')
  })

  it('shows all six components, their weights, their inputs and the arithmetic', async () => {
    await twoMeasured()
    await mount()
    const list = screen.getByRole('list', { name: 'The six parts of the Money Score' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(6)
    // The order is score.ts's, and every weight on the page is the one in its table.
    expect(within(list).getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(IDS.map((id) => LABEL[id]))
    for (const id of IDS) expect(field(itemOf(id), 'Weight'), id).toBe(String(WEIGHTS[id]))

    const budget = itemOf('budget-awareness')
    expect(field(budget, 'Status')).toBe('Measured: 75 out of 100')
    expect(field(budget, 'Inputs')).toContain('You respected 1 of 2 allocations in completed months')
    expect(field(budget, 'Arithmetic')).toBe('75 × 3 = 225')

    const goals = itemOf('goal-progress')
    expect(field(goals, 'Status')).toBe('Measured: 25 out of 100')
    expect(field(goals, 'Inputs')).toContain('You have completed 1 of 2 savings goals')
    expect(field(goals, 'Arithmetic')).toBe('25 × 2 = 50')

    // The four are there for the four that are not measured too, each with its own words.
    for (const id of ['savings-consistency', 'improvement', 'spending-awareness', 'learning'] as const) {
      const item = itemOf(id)
      for (const term of ['Status', 'Weight', 'Inputs', 'Arithmetic']) expect(field(item, term).length, `${id} ${term}`).toBeGreaterThan(0)
    }
  })

  it('marks a component not yet measured and says what it is waiting for', async () => {
    await mount()
    // Each reason is the one its own component gives, so a screen that printed one generic line for all six fails.
    const waiting: Record<ComponentId, RegExp> = {
      'budget-awareness': /No completed month with a category allocation is recorded yet/,
      'savings-consistency': /Not enough months recorded yet: this needs 3 and there are 0\./,
      'improvement': /so it needs 6 and there are 0\./,
      'spending-awareness': /No transactions in this period are ones the app asks you to review/,
      'goal-progress': /You have not set a savings goal yet/,
      'learning': /It needs 2 such patterns and there are 0\./,
    }
    for (const id of IDS) {
      const item = itemOf(id)
      expect(field(item, 'Status'), id).toBe('Not yet measured')
      expect(field(item, 'Inputs'), id).toMatch(waiting[id])
      expect(field(item, 'Arithmetic'), id).toMatch(/not counted as 0/)
      expect(field(item, 'Weight'), id).toBe(String(WEIGHTS[id]))
    }
    // A measured part is not marked unmeasured: that mark depends on the data, not on the screen.
    cleanup()
    await twoMeasured()
    await mount()
    expect(field(itemOf('goal-progress'), 'Status')).toBe('Measured: 25 out of 100')
    expect(field(itemOf('learning'), 'Status')).toBe('Not yet measured')
  })

  it('shows the weight it actually divided by, not the total of all six', async () => {
    await twoMeasured()
    await mount()
    expect(screen.getByText('Your Money Score: 55 out of 100')).toBeInTheDocument()
    expect(text()).toContain('Weight measured: 5 of 14.')
    // 225 + 50 = 275, over 5: not over 14 (which would give 20), and not over the 2 parts measured (which would be capped).
    expect(text()).toContain('275 ÷ 5, rounded to a whole number, gives 55.')
    expect(text()).not.toMatch(/÷ 14/)
    expect(text()).not.toMatch(/÷ 2\b/)
  })

  it('reads the cache rather than the transactions table', async () => {
    await twoMeasured()
    // First visit: the figures are computed, and the counter proves it can see such a read.
    const first = await (async () => {
      let view: ReturnType<typeof render> | undefined
      const reads = await transactionRowReads(async () => { view = await mount() })
      return { reads, view: view as ReturnType<typeof render> }
    })()
    expect(first.reads).toBeGreaterThan(0)
    const initial = text()
    first.view.unmount()

    // Second visit, nothing changed: every figure is served from the cache, so no transaction row is read at all.
    const put = vi.spyOn(db.analyticsCache, 'put')
    let second: ReturnType<typeof render> | undefined
    const reads = await transactionRowReads(async () => { second = await mount() })
    expect(reads).toBe(0)
    expect(put).not.toHaveBeenCalled()
    expect(text()).toBe(initial)
    second?.unmount()
  })

  it('looks at the windows it says: twelve completed months, six months to date, and two runs of three completed months', async () => {
    vi.mocked(spendingAwareness).mockClear(); vi.mocked(savingsConsistency).mockClear(); vi.mocked(regretClusters).mockClear()
    await mount() // today is 2026-11-10, so the latest completed month is October
    expect(vi.mocked(spendingAwareness).mock.calls).toEqual([['2026-06-01', '2026-11-31']])
    const months = vi.mocked(savingsConsistency).mock.calls[0]?.[0].map((p) => p.month)
    expect(months).toEqual(['2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'])
    // Earlier run May to July, later run August to October: the month in progress is in neither, and nothing is read twice.
    expect(vi.mocked(regretClusters).mock.calls.map((c) => c[0]).sort()).toEqual(['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'])
  })

  it('hands the earlier months and the later months to the repeated-regrets measure in that order, each added up across its months', async () => {
    const real = await vi.importActual<typeof import('../../learning/regret')>('../../learning/regret')
    vi.mocked(learning).mockClear()
    // One pattern in every month, with a regret count that is the month number, so each run's total says which months it holds.
    vi.mocked(regretClusters).mockImplementation(async (m) =>
      [{ by: 'category', key: 'k', label: 'k', regretted: Number((m ?? '').slice(5)), total: 10, cents: 0 }])
    try { await mount() } finally { vi.mocked(regretClusters).mockImplementation(real.regretClusters) }
    const [early, late] = vi.mocked(learning).mock.calls[0] ?? []
    expect(early).toEqual([{ by: 'category', key: 'k', label: 'k', regretted: 5 + 6 + 7, total: 30, cents: 0 }])
    expect(late).toEqual([{ by: 'category', key: 'k', label: 'k', regretted: 8 + 9 + 10, total: 30, cents: 0 }])
  })

  it('stamps what it caches with the instant it was given', async () => {
    await twoMeasured()
    await mount()
    const rows = (await db.analyticsCache.toArray()).filter((r) => r.key.startsWith('score:'))
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) expect(r.computedAt, r.key).toBe(AT)
  })

  it('shows a goal completed after the first visit on the next, because goals are not cached', async () => {
    await twoMeasured()
    const view = await mount()
    expect(field(itemOf('goal-progress'), 'Status')).toBe('Measured: 25 out of 100')
    view.unmount()
    await db.savingsGoals.update('g2', { completedAt: 9 })
    await mount()
    expect(field(itemOf('goal-progress'), 'Status')).toBe('Measured: 100 out of 100')
  })

  it('says the score could not be worked out, and offers nothing to press, when the store fails', async () => {
    vi.spyOn(db.analyticsCache, 'get').mockRejectedValue(new Error('the store is gone'))
    render(<Score today={TODAY} computedAt={AT} />)
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Your Money Score could not be worked out (the store is gone). Nothing was changed.')
    expect(text()).not.toMatch(/out of 100/)
    expect(screen.queryByText(/Loading your Money Score/)).toBeNull()
  })

  it('uses no causal, shaming or statistical wording anywhere on the page', async () => {
    // The lists come from src/test/bannedWords.ts. A vacuous extraction would pass anything, so each is probed first.
    for (const list of BANNED_LISTS) {
      expect(list.forbids, list.name).toMatch(list.pattern)
      expect(list.allows, list.name).not.toMatch(list.pattern)
    }
    // The fresh page, and a page with measured parts (whose sentences come from other modules), are both scanned.
    for (const setup of [async () => {}, twoMeasured]) {
      cleanup()
      await db.delete(); await db.open(); await seedDatabase()
      await setup()
      await mount()
      const page = spoken()
      expect(page).toMatch(setup === twoMeasured ? /weight measured/i : /cannot be given yet/)
      expect(page).toContain('The six parts') // it really rendered, so this is not a scan of nothing
      expect(page).toContain(LABEL['learning'])
      expect(page).not.toMatch(causalWords)
      expect(page).not.toMatch(jargonWords)
      expect(page).not.toMatch(noJargon)
    }
  })

  it('keeps focus and renders no control that does nothing', async () => {
    await mount()
    expect(screen.queryAllByRole('button')).toHaveLength(0)
    expect(document.querySelectorAll('[disabled], [aria-disabled="true"], [tabindex]')).toHaveLength(0)
    const links = screen.getAllByRole('link')
    expect(links.length).toBeGreaterThan(0)
    for (const a of links) expect(a.getAttribute('href')).toMatch(/^#\/[a-z]+/)

    const link = screen.getByRole('link', { name: 'import your ING statements' })
    link.focus()
    fireEvent.click(link)
    expect(document.activeElement).toBe(link)
    expect(screen.getByRole('heading', { level: 1, name: 'Money Score' })).toBeInTheDocument()
  })
})
