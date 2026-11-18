import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import Score from './Score'
import { db } from '../../db/db'
import { seedDatabase } from '../../db/seed'
import { saveAllocation } from '../../budget/allocations'
import { moneyScore, WEIGHTS, type ComponentId } from '../../score/score'
import { BANNED_LISTS, WORDING_LISTS, violations } from '../../test/bannedWords'
import { spoken } from '../../test/spoken'
import { transactionRowReads } from '../../test/reads'
import type { TransactionRow } from '../../db/schema'
import type { MonthPoint } from '../../analytics/series'
import { budgetAwareness, goalProgress, improvement, learning, savingsConsistency, spendingAwareness } from '../../score/components'
import { regretClustersBetween } from '../../learning/regret'
import { goalContributions } from '../../goals/contributions'
import { progressOf } from '../../goals/progress'
import { ROUTES } from '../routes'

// Pass-throughs that remember how they were called, so the windows the screen asks about can be read back.
vi.mock('../../score/components', async (original) => {
  const real = await original<typeof import('../../score/components')>()
  return { ...real, spendingAwareness: vi.fn(real.spendingAwareness), learning: vi.fn(real.learning), savingsConsistency: vi.fn(real.savingsConsistency),
    budgetAwareness: vi.fn(real.budgetAwareness), goalProgress: vi.fn(real.goalProgress), improvement: vi.fn(real.improvement) }
})
vi.mock('../../learning/regret', async (original) => {
  const real = await original<typeof import('../../learning/regret')>()
  return { ...real, regretClustersBetween: vi.fn(real.regretClustersBetween) }
})

const GROCERIES: [string, string] = ['Alimentación', 'Supermercados y alimentación']
const RESTAURANTS: [string, string] = ['Ocio y viajes', 'Cafeterías y restaurantes']
const TODAY = '2026-11-10'
const AT = 1_700_000_000_000
const JAN = Date.UTC(2026, 0, 1) // when the goals in the fixtures were created

let uid = 0
const tx = async (id: string, valueDate: string, amountCents: number, ing: [string, string] | null = null, kind: TransactionRow['kind'] = amountCents > 0 ? 'income' : 'spend'): Promise<void> => {
  const row: TransactionRow = {
    id, accountId: 'acc.1', valueDate, amountCents, balanceCents: 0, description: 'Movimiento inventado', comment: null,
    ingCategory: ing?.[0] ?? null, ingSubcategory: ing?.[1] ?? null, kind,
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
 * Two of the six measured, with DIFFERENT weights (budget 3, goals 2) so that the divisor the screen shows can be told from
 * the weight of all six (14), from the number of measured parts (2), and from either one alone:
 *   October: groceries allocated 300, spent 100 (respected); restaurants allocated 100, spent 200 (not) -> 300 of 400 = 75.
 *   The month also saved 40.00, shared between two goals in proportion to their allocations (30.00 and 10.00): 30.00 and 10.00,
 *   so both goal lines are met and count as respected: the budget measure then reads 340 of 440 = 77 (300 + 30 + 10 respected of 300 + 100 + 30 + 10 allocated, in euros).
 *   Goals: g1 (target 40.00) has 30.00 put toward it, g2 (target 120.00) has 10.00: 40.00 of 160.00 = 25.
 *   3 x 77 + 2 x 25 = 281, over a measured weight of 5 = 56 (281 / 5 = 56.2).
 */
async function twoMeasured(): Promise<void> {
  await tx('pay', '2026-10-01', 200000)
  await tx('g', '2026-10-03', -10000, GROCERIES)
  await tx('r', '2026-10-04', -20000, RESTAURANTS)
  await saveAllocation({ categoryId: 'cat.groceries', savingsGoalId: null, percentBp: null, fixedCents: 30000, effectiveFrom: '2026-01-01', note: null })
  await saveAllocation({ categoryId: 'cat.restaurants', savingsGoalId: null, percentBp: null, fixedCents: 10000, effectiveFrom: '2026-01-01', note: null })
  await tx('save', '2026-10-05', -4000, ['Ahorro', 'Redondeo'], 'roundup')
  await db.savingsGoals.add({ id: 'g1', name: 'Viaje', targetCents: 4000, deadline: null, contributionPercentBp: 0, createdAt: JAN, completedAt: null, archived: false })
  await db.savingsGoals.add({ id: 'g2', name: 'Coche', targetCents: 12000, deadline: null, contributionPercentBp: 0, createdAt: JAN, completedAt: null, archived: false })
  await saveAllocation({ categoryId: null, savingsGoalId: 'g1', percentBp: null, fixedCents: 3000, effectiveFrom: '2026-01-01', note: null })
  await saveAllocation({ categoryId: null, savingsGoalId: 'g2', percentBp: null, fixedCents: 1000, effectiveFrom: '2026-01-01', note: null })
}

/**
 * All six measured, so every measure's own sentences reach the page. The three that need months of history are fed
 * fabricated inputs through the real functions (their sentences are still the real ones); the other three come from rows.
 */
async function allSixMeasured(): Promise<void> {
  await twoMeasured()
  await db.annotations.add({
    transactionId: 'r', categoryId: null, subcategoryId: null, merchantId: null, typeOverride: null, paymentMethod: null, note: null, moodId: null,
    purchaseReasonId: null, worthwhile: null, reviewed: true, dateOverride: null, amountCentsOverride: null, descriptionOverride: null, updatedAt: 1,
  })
  const real = await vi.importActual<typeof import('../../score/components')>('../../score/components')
  const month = (m: string, saved: number, spent: number, discretionary: number) => ({ month: m, hasData: true, savedCents: saved, spentCents: spent, discretionaryCents: discretionary })
  const months = [month('2026-05', 100, 1000, 500), month('2026-06', 100, 1000, 500), month('2026-07', 100, 1000, 500), month('2026-08', 100, 1000, 400), month('2026-09', 100, 1000, 400), month('2026-10', 100, 1000, 400)] as unknown as MonthPoint[]
  vi.mocked(savingsConsistency).mockImplementationOnce(() => real.savingsConsistency(months))
  vi.mocked(improvement).mockImplementationOnce(() => real.improvement(months))
  const cl = (key: string, regretted: number) => ({ by: 'mood' as const, key, label: key, regretted, total: 4, cents: 0 })
  vi.mocked(regretClustersBetween).mockResolvedValueOnce([cl('a', 3), cl('b', 3)]).mockResolvedValueOnce([cl('a', 1), cl('b', 0)])
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
    expect(screen.getByRole('link', { name: 'import your bank statements' })).toHaveAttribute('href', '#/import')
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
    expect(field(budget, 'Status')).toBe('Measured: 77 out of 100')
    expect(field(budget, 'Inputs')).toContain('You respected 3 of 4 allocations in completed months')
    expect(field(budget, 'Arithmetic')).toBe('77 × 3 = 231')

    const goals = itemOf('goal-progress')
    expect(field(goals, 'Status')).toBe('Measured: 25 out of 100')
    expect(field(goals, 'Inputs')).toContain('Across 2 active savings goals')
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
      'budget-awareness': /No completed month with an allocation is recorded yet/,
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
      expect(field(item, 'Inputs'), id).not.toMatch(/^Nothing to work from/) // the reason stands alone, with no lead-in that may not fit it
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
    expect(screen.getByText('Your Money Score: 56 out of 100')).toBeInTheDocument()
    expect(text()).toContain('Weight measured: 5 of 14.')
    // 231 + 50 = 281, over 5: not over 14 (which would give 20), and not over the 2 parts measured (which would be capped).
    expect(text()).toContain('281 ÷ 5, rounded to a whole number, gives 56.')
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

  it('looks at the windows it says: twelve completed months, six months to the last day of this one, and two runs of three completed months', async () => {
    vi.mocked(spendingAwareness).mockClear(); vi.mocked(savingsConsistency).mockClear(); vi.mocked(regretClustersBetween).mockClear()
    await mount() // today is 2026-11-10, so the latest completed month is October
    expect(vi.mocked(spendingAwareness).mock.calls).toEqual([['2026-06-01', '2026-11-30']]) // a real date: November has 30 days
    const months = vi.mocked(savingsConsistency).mock.calls[0]?.[0].map((p) => p.month)
    expect(months).toEqual(['2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'])
    // Earlier run May to July, later run August to October: the month in progress is in neither, and they do not overlap.
    expect(vi.mocked(regretClustersBetween).mock.calls).toEqual([['2026-05', '2026-07'], ['2026-08', '2026-10']])
  })

  it('ends the review window on the real last day of the month, leap February included', async () => {
    vi.mocked(spendingAwareness).mockClear()
    render(<Score today="2028-02-10" computedAt={AT} />)
    await settled()
    expect(vi.mocked(spendingAwareness).mock.calls).toEqual([['2027-09-01', '2028-02-29']])
  })

  it('hands the earlier window and the later window to the repeated-regrets measure in that order, as the window readers returned them', async () => {
    const real = await vi.importActual<typeof import('../../learning/regret')>('../../learning/regret')
    vi.mocked(learning).mockClear()
    // Each reading names the window it was asked for, so the argument order says which window went where.
    vi.mocked(regretClustersBetween).mockImplementation(async (first, last) =>
      [{ by: 'category', key: first + '..' + last, label: 'k', regretted: 0, total: 3, cents: 0 }])
    try { await mount() } finally { vi.mocked(regretClustersBetween).mockImplementation(real.regretClustersBetween) }
    const [early, late] = vi.mocked(learning).mock.calls[0] ?? []
    expect(early?.map((c) => c.key)).toEqual(['2026-05..2026-07'])
    expect(late?.map((c) => c.key)).toEqual(['2026-08..2026-10'])
  })

  it('names each cached figure by its window, so a new month is a new figure and the old month is not served', async () => {
    await twoMeasured()
    const keys = async () => (await db.analyticsCache.toArray()).map((r) => r.key).filter((k) => k.startsWith('score:')).sort()
    const view = await mount()
    const november = await keys()
    expect(november.map((k) => k.split(':')[1])).toEqual(['budget-awareness', 'goal-progress', 'improvement', 'learning', 'savings-consistency', 'spending-awareness'])
    view.unmount()
    render(<Score today="2026-12-10" computedAt={AT} />)
    await settled()
    const both = await keys()
    expect(both).toHaveLength(november.length * 2) // six new figures, none of them an old key reused
    expect(new Set(both).size).toBe(both.length)
  })

  it('says so when rounding would reach 100 but the score is held at 99', async () => {
    // Weights 3 and 2, scores 100 and 99: 498 / 5 = 99,6, which rounds to 100, but 100 needs every measured part at 100.
    vi.mocked(budgetAwareness).mockReturnValueOnce({ kind: 'measured', score: 100, inputs: 'Invented inputs.' })
    vi.mocked(goalProgress).mockReturnValueOnce({ kind: 'measured', score: 99, inputs: 'Invented inputs.' })
    await mount()
    expect(screen.getByText('Your Money Score: 99 out of 100')).toBeInTheDocument()
    expect(text()).toContain('498 ÷ 5, rounded to a whole number, would be 100. It is shown as 99 because 100 appears only when every measured part scored 100.')
    expect(text()).not.toContain('gives 99')
  })

  it('tells someone with records but too few months something other than to import', async () => {
    await mount()
    expect(screen.getByRole('link', { name: 'import your bank statements' })).toBeInTheDocument()
    expect(text()).not.toMatch(/Your records are in/)
    cleanup()
    await twoMeasured()
    await db.savingsGoals.clear() // records, and nothing measured
    await db.budgetAllocations.clear()
    await mount()
    expect(screen.getByText(/cannot be given yet/)).toBeInTheDocument()
    expect(text()).toMatch(/Your records are in, but they do not yet cover enough to measure anything/)
    expect(screen.queryByRole('link', { name: /import/ })).toBeNull()
    expect(text()).not.toMatch(/ING/)
  })

  it('counts a record from the month in progress as records, though no completed month has any', async () => {
    await tx('now', '2026-11-03', -1000, GROCERIES)
    await mount()
    expect(text()).toMatch(/Your records are in/)
  })

  it('stamps what it caches with the instant it was given', async () => {
    await twoMeasured()
    await mount()
    const rows = (await db.analyticsCache.toArray()).filter((r) => r.key.startsWith('score:'))
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) expect(r.computedAt, r.key).toBe(AT)
  })

  it('shows a goal completed after the first visit on the next, because the cache notices a goal change', async () => {
    await twoMeasured()
    const view = await mount()
    expect(field(itemOf('goal-progress'), 'Status')).toBe('Measured: 25 out of 100')
    view.unmount()
    await db.savingsGoals.update('g2', { completedAt: 9 })
    await mount()
    // g2 completed counts in full: 3.000 + 12.000 of 16.000 = 93.75 -> 94.
    expect(field(itemOf('goal-progress'), 'Status')).toBe('Measured: 94 out of 100')
  })

  it('feeds the score the same progress figures the goals screen shows', async () => {
    await twoMeasured()
    await mount()
    const given = vi.mocked(goalProgress).mock.calls[0]?.[0]
    const months = await goalContributions('2026-01', '2026-10', TODAY, AT)
    const goals = await db.savingsGoals.orderBy('id').toArray()
    expect([...(given ?? [])].sort((a, b) => (a.goal.id < b.goal.id ? -1 : 1))).toEqual(goals.map((goal) => ({ goal, progress: progressOf(goal, months, '2026-10') })))
    expect(given?.map((x) => x.progress.contributedCents).sort()).toEqual([1000, 3000])
  })

  it('reads at most the last 36 completed months of goal history, keys the cache by that window, and says so', async () => {
    await twoMeasured()
    await db.savingsGoals.update('g1', { createdAt: Date.UTC(2015, 0, 1) })
    await mount()
    const keys = (await db.analyticsCache.toArray()).map((r) => r.key).filter((k) => k.startsWith('score:goal-progress:'))
    expect(keys).toEqual(['score:goal-progress:2023-11:2026-10'])
    expect(field(itemOf('goal-progress'), 'Inputs')).toContain('Only the last 36 completed months are counted.')
  })

  it('says nothing about a window when no goal is older than it', async () => {
    await twoMeasured()
    await mount()
    expect(field(itemOf('goal-progress'), 'Inputs')).not.toContain('completed months are counted')
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
    for (const list of [...BANNED_LISTS, ...WORDING_LISTS]) {
      expect(list.forbids, list.name).toMatch(list.pattern)
      expect(list.allows, list.name).not.toMatch(list.pattern)
    }
    // The fresh page, and a page with measured parts (whose sentences come from other modules), are both scanned.
    for (const setup of [async () => {}, twoMeasured, allSixMeasured]) {
      cleanup()
      await db.delete(); await db.open(); await seedDatabase()
      await setup()
      await mount()
      const page = spoken()
      expect(page).toMatch(setup === allSixMeasured ? /Weight measured: 14 of 14/ : setup === twoMeasured ? /weight measured/i : /cannot be given yet/)
      if (setup === allSixMeasured) expect(page.match(/Measured: \d+ out of 100/g)).toHaveLength(6) // every part's own sentences are on the page
      expect(page).toContain('The six parts') // it really rendered, so this is not a scan of nothing
      expect(page).toContain(LABEL['learning'])
      expect(violations(page), 'lists tripped by the page').toEqual([])
    }
  })

  // The click-and-focus part is only what jsdom allows: it does not follow a hash link, so focus staying put proves little.
  // What this test really holds is that nothing on the page is a button, disabled, or focusable by tabindex, and that every
  // link goes to a route that exists.
  it('keeps focus and renders no control that does nothing', async () => {
    await mount()
    expect(screen.queryAllByRole('button')).toHaveLength(0)
    expect(document.querySelectorAll('[disabled], [aria-disabled="true"], [tabindex]')).toHaveLength(0)
    const links = screen.getAllByRole('link')
    expect(links.length).toBeGreaterThan(0)
    for (const a of links) expect(ROUTES.map((r) => '#' + r.path), a.textContent ?? '').toContain(a.getAttribute('href'))

    const link = screen.getByRole('link', { name: 'import your bank statements' })
    link.focus()
    fireEvent.click(link)
    expect(document.activeElement).toBe(link)
  })
})
