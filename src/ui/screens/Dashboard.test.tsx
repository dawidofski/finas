import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import Dashboard from './Dashboard'
import { db } from '../../db/db'
import { seedDatabase } from '../../db/seed'
import { inputsHash, ENGINE_VERSION } from '../../analytics/cache'
import type { MonthPoint } from '../../analytics/series'
import { formatEur } from '../../lib/money'
import type { TransactionRow } from '../../db/schema'

const GROCERIES: [string, string] = ['Alimentación', 'Supermercados y alimentación']
const RESTAURANTS: [string, string] = ['Ocio y viajes', 'Cafeterías y restaurantes']
const TODAY = '2026-11-10' // inside November: the month is still running
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

/** Waits for the settled screen, not the first thing that appears: the loading notice must be gone. */
const settled = async () => {
  await screen.findByRole('heading', { level: 1, name: 'Dashboard' })
  await waitFor(() => expect(screen.queryByText(/Loading your dashboard/)).toBeNull())
}
const mount = async (today = TODAY, month?: string) => {
  const view = render(<Dashboard today={today} computedAt={AT} month={month} />)
  await settled()
  return view
}
const text = () => document.body.textContent ?? ''

/** A November with income, groceries and a restaurant, and an October with income and groceries. */
async function twoMonths() {
  await tx('oct-pay', '2026-10-01', 100000)
  await tx('oct-a', '2026-10-05', -20000, GROCERIES)
  await tx('pay', '2026-11-01', 200000)
  await tx('a', '2026-11-03', -10000, GROCERIES)
  await tx('b', '2026-11-04', -5000, RESTAURANTS)
}

describe('Dashboard screen', () => {
  it('says plainly that there is nothing yet on a fresh install, and how to begin', async () => {
    await mount()
    expect(screen.getByText(/There is nothing to show yet/)).toBeInTheDocument()
    expect(screen.getByText(/last 6 months/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'import your ING statements' })).toHaveAttribute('href', '#/import')
    expect(screen.queryByText(/Income:/)).toBeNull()
    expect(screen.queryByText(/Compared with/)).toBeNull()
  })

  it('shows this month income, spending, savings and the net, with Spanish dates', async () => {
    await twoMonths()
    await mount()
    expect(screen.getByRole('heading', { level: 2, name: 'November 2026' })).toBeInTheDocument()
    expect(screen.getByText('Figures up to 10/11/2026.')).toBeInTheDocument()
    expect(screen.getByText(`Income: ${formatEur(200000)}`)).toBeInTheDocument()
    expect(screen.getByText(`Spent: ${formatEur(15000)}`)).toBeInTheDocument()
    expect(screen.getByText(`Saved: ${formatEur(0)}`)).toBeInTheDocument()
    expect(screen.getByText(`Left over: ${formatEur(185000)}`)).toBeInTheDocument()
    expect(text()).not.toMatch(/2026-11-10/)
    // Only fixed names reach the bars, so a long category name can never run into its amount.
    const bars = [...document.querySelectorAll('svg [data-label]')].filter((g) => g.tagName === 'g').map((g) => g.getAttribute('data-label'))
    expect(bars).toEqual(['Essentials', 'Discretionary'])
  })

  it('shows a change against last month only when there is a last month', async () => {
    await twoMonths()
    const first = await mount()
    expect(screen.getByRole('heading', { level: 2, name: 'Compared with October 2026' })).toBeInTheDocument()
    expect(screen.getByText(`Spending: down ${formatEur(5000)}`)).toBeInTheDocument()
    expect(screen.getByText(`Income: up ${formatEur(100000)}`)).toBeInTheDocument()
    first.unmount()

    // October is empty and September is not: the month before this one has no records, and nothing may be compared across the gap.
    await db.transactions.where('valueDate').startsWith('2026-10').delete()
    await tx('sep-pay', '2026-09-01', 100000)
    await db.analyticsCache.clear()
    await mount()
    expect(screen.getByText(/There is no earlier month with records to compare November 2026 with/)).toBeInTheDocument()
    expect(screen.queryByText(/Compared with/)).toBeNull()
    expect(text()).not.toMatch(/up .*\(\d+ %\)/)
    expect(text()).not.toMatch(/100 %/)
  })

  it('shows no percentage while this month is still running, and both once it is complete', async () => {
    await twoMonths()
    const running = await mount()
    expect(screen.getByText(`Spending: down ${formatEur(5000)}`)).toBeInTheDocument()
    expect(document.querySelector('.dashboard-changes')?.textContent).not.toMatch(/%/)
    expect(screen.getByText(/This compares the first 10 days of November 2026 with all of October 2026\./)).toBeInTheDocument()
    expect(screen.getByText(/November 2026 is still running, so the changes are in euros only/)).toBeInTheDocument()
    running.unmount()

    // The same data a month later: November is over, so it is compared with October as a whole month against a whole month.
    await mount('2026-12-05', '2026-11')
    expect(screen.getByText(`Spending: down ${formatEur(5000)} (25 %)`)).toBeInTheDocument()
    expect(screen.getByText(`Income: up ${formatEur(100000)} (100 %)`)).toBeInTheDocument()
    expect(screen.getByText('Figures for the whole month.')).toBeInTheDocument()
    expect(screen.queryByText(/still running/)).toBeNull()
    expect(screen.queryByText(/This compares/)).toBeNull()
    expect(screen.getByText('Both months are complete.')).toBeInTheDocument()
  })

  it('counts the days from today, and says so in the singular on the first', async () => {
    await twoMonths()
    const first = await mount('2026-11-03')
    expect(screen.getByText(/the first 3 days of November 2026 with all of October 2026/)).toBeInTheDocument()
    first.unmount()
    await mount('2026-11-01')
    expect(screen.getByText(/the first day of November 2026 with all of October 2026/)).toBeInTheDocument()
  })

  it('reads a month that spent exactly what the last one did as unchanged', async () => {
    await tx('oct-pay', '2026-10-01', 100000)
    await tx('oct-a', '2026-10-05', -15000, GROCERIES)
    await tx('pay', '2026-11-01', 200000)
    await tx('a', '2026-11-03', -15000, GROCERIES)
    await mount()
    expect(screen.getByText('Spending: the same')).toBeInTheDocument()
    expect(text()).not.toMatch(/Spending: (up|down)/)
  })

  it('marks a provisional income figure as an estimate wherever it appears', async () => {
    for (const m of ['2026-08', '2026-09', '2026-10']) {
      await tx(`pay-${m}`, `${m}-01`, 100000)
      await tx(`spend-${m}`, `${m}-05`, -20000, GROCERIES)
    }
    await tx('nov-a', '2026-11-03', -10000, GROCERIES) // November has spending but no income yet
    await mount()
    expect(screen.getByText(`Income: ${formatEur(100000)} (an estimate: the average of your last three months)`)).toBeInTheDocument()
    expect(screen.getByText(`Left over: ${formatEur(90000)} (based on estimated income)`)).toBeInTheDocument()
    const changes = document.querySelector('.dashboard-changes') as HTMLElement
    const incomeRows = [...changes.querySelectorAll('li')].filter((li) => /^(Income|Left over)/.test(li.textContent ?? ''))
    expect(incomeRows.length).toBe(2)
    for (const li of incomeRows) expect(li.textContent).toMatch(/\(estimated income\)$/)
    // Spending is the bank's own figure, so it carries no estimate mark.
    expect([...changes.querySelectorAll('li')].find((li) => li.textContent?.startsWith('Spending'))?.textContent).not.toMatch(/estimate/)
  })

  it('never prints a confident income figure when no income is known, and does not compare it', async () => {
    await tx('a', '2026-11-03', -10000, GROCERIES)
    await tx('oct-a', '2026-10-05', -20000, GROCERIES)
    await mount()
    expect(screen.getByText('Income: none recorded yet this month')).toBeInTheDocument()
    expect(screen.getByText(/Left over: cannot be worked out/)).toBeInTheDocument()
    expect(text()).not.toContain(`Income: ${formatEur(0)}`)
    expect(screen.getByText(/Income and what is left over are not compared/)).toBeInTheDocument()
    expect(screen.getByText(`Spending: down ${formatEur(10000)}`)).toBeInTheDocument()
  })

  it('does not draw a negative uncategorised figure as spending', async () => {
    // A refund filed against a savings-kind category can make the uncategorised remainder negative. The cache row is written
    // directly: the figure is reachable in principle, and the fixture for it would otherwise depend on category kinds.
    const month = (m: string, over: Partial<MonthPoint>): MonthPoint => ({
      month: m, incomeCents: 0, spentCents: 0, savedCents: 0, essentialCents: 0, discretionaryCents: 0, uncategorisedCents: 0,
      netCents: 0, provisional: true, incomeBasis: 'none', transactions: 0, hasData: false, ...over,
    })
    const points = ['2026-06', '2026-07', '2026-08', '2026-09', '2026-10'].map((m) => month(m, {}))
    points.push(month('2026-11', {
      incomeCents: 200000, spentCents: 8000, essentialCents: 10000, discretionaryCents: 0, uncategorisedCents: -2000,
      netCents: 192000, provisional: false, incomeBasis: 'actual', transactions: 3, hasData: true,
    }))
    await db.analyticsCache.put({
      key: 'monthSeries:2026-06:2026-11', engineVersion: ENGINE_VERSION, inputsHash: await inputsHash(), computedAt: AT,
      payload: { shape: 1, value: points },
    })
    await mount()
    expect(screen.getByText(/of money returned to you is not filed under a spending category/)).toBeInTheDocument()
    expect(screen.getByText(new RegExp(`^${formatEur(2000).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} of money returned`))).toBeInTheDocument()
    const labels = [...document.querySelectorAll('g[data-label]')].map((g) => g.getAttribute('data-label'))
    expect(labels).toEqual(['Essentials', 'Discretionary'])
    expect(document.querySelector('g[data-cents^="-"]')).toBeNull()
  })

  it('says what is missing when this month has no records, and never joins a line across a gap', async () => {
    await tx('oct-pay', '2026-10-01', 100000)
    await tx('oct-a', '2026-10-05', -20000, GROCERIES)
    const first = await mount()
    expect(screen.getByText(/No bank movements are recorded for November 2026 yet\. Your latest records are from October 2026/)).toBeInTheDocument()
    expect(screen.queryByText(/Income:/)).toBeNull()
    first.unmount()

    // November and October have records, September has none, August has: the line covers the unbroken run only.
    await tx('pay', '2026-11-01', 200000)
    await tx('a', '2026-11-03', -10000, GROCERIES)
    await tx('aug-a', '2026-08-03', -30000, GROCERIES)
    await mount()
    const dots = [...document.querySelectorAll('circle[data-label]')].map((c) => c.getAttribute('data-label'))
    expect(dots).toEqual(['October 2026', 'November 2026'])
  })

  it('says how many months it has when there are not enough for a line', async () => {
    await tx('pay', '2026-11-01', 200000)
    await tx('a', '2026-11-03', -10000, GROCERIES)
    await tx('aug-a', '2026-08-03', -30000, GROCERIES)
    await mount()
    expect(screen.getByText(/once two months in a row have records\. You have 1 so far/)).toBeInTheDocument()
    expect(document.querySelector('circle[data-label]')).toBeNull()
  })

  it('reads the cache rather than the transactions table', async () => {
    await twoMonths()
    // First visit: the figures are computed, which reads the month ranges. The spy proves it can see such a read.
    const ranges: string[] = []
    const where = vi.spyOn(db.transactions, 'where')
    const first = await mount()
    for (const call of where.mock.calls) ranges.push(String(call[0]))
    expect(ranges).toContain('[accountId+valueDate]')
    const initial = text()
    first.unmount()

    // Second visit, nothing changed: every figure is served from the cache. The only table reads left are the digest's.
    where.mockClear()
    const orderBy = vi.spyOn(db.transactions, 'orderBy')
    const put = vi.spyOn(db.analyticsCache, 'put')
    await mount()
    expect(text()).toBe(initial)
    expect(where.mock.calls.map((c) => String(c[0]))).not.toContain('[accountId+valueDate]')
    expect(orderBy.mock.calls.map((c) => String(c[0]))).not.toContain('accountId')
    expect(put).not.toHaveBeenCalled()
  })

  it('offers no control that does nothing, and keeps focus when a control is used', async () => {
    await twoMonths()
    await mount()
    expect(screen.queryAllByRole('button')).toHaveLength(0)
    expect(document.querySelectorAll('[disabled], [aria-disabled="true"]')).toHaveLength(0)
    const links = screen.getAllByRole('link')
    expect(links.length).toBeGreaterThan(0)
    for (const a of links) expect(a.getAttribute('href')).toMatch(/^#\/[a-z]+/)

    const budget = screen.getByRole('link', { name: 'Open the budget' })
    budget.focus()
    fireEvent.click(budget)
    expect(document.activeElement).toBe(budget)
    expect(screen.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeInTheDocument()
  })
})
