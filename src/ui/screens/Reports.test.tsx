import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import Reports from './Reports'
import { db } from '../../db/db'
import { seedDatabase } from '../../db/seed'
import { writeAnnotation } from '../../db/annotations'
import { inputsHash, ENGINE_VERSION } from '../../analytics/cache'
import type { MonthPoint } from '../../analytics/series'
import type { AnnotatedRow } from '../../analytics/annotated'
import { formatBp, formatEur } from '../../lib/money'
import type { TransactionRow } from '../../db/schema'
import { violations } from '../../test/bannedWords'
import { spoken } from '../../test/spoken'

const GROCERIES: [string, string] = ['Alimentación', 'Supermercados y alimentación']
const RESTAURANTS: [string, string] = ['Ocio y viajes', 'Cafeterías y restaurantes']
const GROCERY_NAME = 'Supermercados y alimentación' // the seed's name for the category above
const TODAY = '2026-11-20' // inside November: the month is still running
const AT = 1_700_000_000_000

let uid = 0
const tx = async (id: string, valueDate: string, amountCents: number, ing: [string, string] | null = null): Promise<void> => {
  const row: TransactionRow = {
    id, accountId: 'acc.1', valueDate, amountCents, balanceCents: 0, description: `Movimiento ${id}`, comment: null,
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
  await screen.findByRole('heading', { level: 1, name: 'Reports' })
  await waitFor(() => expect(screen.queryByText(/Loading your reports/)).toBeNull())
}
const mount = async (today = TODAY, month?: string) => {
  const view = render(<Reports today={today} computedAt={AT} month={month} />)
  await settled()
  return view
}
const text = () => document.body.textContent ?? ''

const link = async (id: string, out: string, inn: string, amountCents: number): Promise<void> => {
  await db.transfers.add({
    id, outTransactionId: out, inTransactionId: inn, amountCents, matchScore: 100, confirmedByUser: true, matchedAt: 1, linkKind: 'refund',
  })
}
/** A purchase from October returned in November, with November's own spending: the refund lands in the purchase's category in November. */
async function returnedInNovember(purchase: { ing: [string, string] | null; cents: number }, november: Array<[string, number, [string, string]]>) {
  await tx('oct-pay', '2026-10-01', 100000)
  await tx('buy', '2026-10-10', -purchase.cents, purchase.ing)
  await tx('pay', '2026-11-01', 200000)
  for (const [id, cents, ing] of november) await tx(id, '2026-11-02', -cents, ing)
  await tx('ref', '2026-11-05', purchase.cents, null)
  await link('r1', 'buy', 'ref', purchase.cents)
}
const SHOPPING: [string, string] = ['Compras', 'Compras (otros)']
const causalWords = /\b(because|cause[sd]?|causing|due to|owing to|leads? to|led to|results? in|resulted|as a result|therefore|thus|so that|drives?|driven|explains?|explained|why|makes you|made you|since you|which is why)\b/i
const jargonWords = /\b(cache|cached|basis|engine|z-score|median|deviation|outlier|percentile|standard|component|net)\b/i
const panel = (name: string) => screen.getByRole('region', { name })
const dots = (el: HTMLElement) => [...el.querySelectorAll('circle[data-label]')].map((c) => c.getAttribute('data-label'))
const bars = (el: HTMLElement) => [...el.querySelectorAll('g[data-label]')].map((g) => g.getAttribute('data-label'))

const PANELS = [
  'Month by month', 'Where the money went', 'Essential and discretionary', 'Unusual spending', 'Small purchases',
  'The days after payday', 'Purchases by mood', 'Purchases by reason you gave', 'Looking back: worth it or not',
]

/**
 * A running November with: pay on the 1st, eight groceries purchases of which one is 300 EUR (the other seven sit with three
 * more from October, so the category has 11 to be judged against), three small coffees, and a mood, a reason and a hindsight
 * answer on some of them. October has income and groceries.
 */
async function rich() {
  await tx('oct-pay', '2026-10-01', 100000)
  for (const d of [3, 4, 5]) await tx(`oct-g${d}`, `2026-10-0${d}`, -2000, GROCERIES)
  await tx('pay', '2026-11-01', 200000)
  for (const d of [2, 3, 4, 5, 6, 7, 8]) await tx(`g${d}`, `2026-11-0${d}`, -2000, GROCERIES)
  await tx('big', '2026-11-09', -30000, GROCERIES)
  for (const d of [10, 11, 12]) await tx(`coffee${d}`, `2026-11-${d}`, -300, RESTAURANTS)
  await writeAnnotation('g2', { moodId: 'mood.happy', purchaseReasonId: 'reason.impulse' }, 'owner')
  await writeAnnotation('g3', { moodId: 'mood.happy', worthwhile: true }, 'owner')
  await writeAnnotation('g4', { moodId: 'mood.sad', worthwhile: false }, 'owner')
}

describe('Reports screen', () => {
  it('says plainly that there is nothing yet on a fresh install, and how to begin', async () => {
    await mount()
    expect(screen.getByText(/There is nothing to report yet/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'import your ING statements' })).toHaveAttribute('href', '#/import')
    expect(screen.queryAllByRole('region')).toHaveLength(0)
  })

  it('shows each panel with its reading, and never a chart alone', async () => {
    await rich()
    await mount()
    for (const name of PANELS) {
      const p = panel(name)
      expect(within(p).getByRole('heading', { level: 2, name })).toBeInTheDocument()
      // Every panel here has enough to draw its chart, so it has exactly one; and a reading in words beside it that is not part of the chart.
      expect(p.querySelectorAll('svg')).toHaveLength(1)
      const reading = [...p.querySelectorAll('p, li')].filter((el) => !el.closest('figure') && (el.textContent ?? '').trim().length > 0)
      expect(reading.length, name).toBeGreaterThan(0)
    }
    expect(screen.getAllByRole('region')).toHaveLength(PANELS.length)
    // Readings that stand without the chart, with Spanish dates and the bank's money.
    expect(within(panel('Unusual spending')).getByText(`09/11/2026, Movimiento big (${GROCERY_NAME}): ${formatEur(30000)}, where the usual amount for the category is ${formatEur(2000)}`)).toBeInTheDocument()
    expect(within(panel('Small purchases')).getByText(new RegExp(`there were 3 purchases under ${formatEur(1000).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}, adding up to ${formatEur(900).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))).toBeInTheDocument()
    expect(within(panel('Purchases by mood')).getByText('Mood recorded on 3 of 11 purchases in November 2026.')).toBeInTheDocument()
    expect(within(panel('Purchases by reason you gave')).getByText('Reason recorded on 1 of 11 purchases in November 2026.')).toBeInTheDocument()
    expect(within(panel('Looking back: worth it or not')).getByText('Looked back at on 2 of 11 purchases in November 2026.')).toBeInTheDocument()
    expect(text()).not.toMatch(/2026-1[01]-\d\d/)
  })

  it('states the number of purchases a judgement needs, and judges nothing below it', async () => {
    // Seven purchases in the category, one of them enormous: one short of the eight needed.
    await tx('pay', '2026-11-01', 200000)
    for (const d of [2, 3, 4, 5, 6, 7]) await tx(`g${d}`, `2026-11-0${d}`, -2000, GROCERIES)
    await tx('big', '2026-11-09', -30000, GROCERIES)
    const first = await mount()
    const p = panel('Unusual spending')
    expect(within(p).getByText(/judged against at least 8 purchases in the same category over the last 6 months/)).toBeInTheDocument()
    expect(within(p).getByText(/No category has that many purchases yet, so nothing in November 2026 could be judged/)).toBeInTheDocument()
    expect(p.querySelector('svg')).toBeNull()
    expect(p.textContent).not.toContain(formatEur(30000))
    first.unmount()

    // One more ordinary purchase makes eight, and the same enormous one is now reported.
    await tx('g1', '2026-11-08', -2000, GROCERIES)
    await mount()
    const q = panel('Unusual spending')
    expect(within(q).getByText(/judged against at least 8 purchases/)).toBeInTheDocument()
    expect(q.textContent).toContain(`${formatEur(30000)}, where the usual amount for the category is ${formatEur(2000)}`)
    expect(q.textContent).not.toMatch(/nothing in November 2026 could be judged/)
  })

  it('says how many categories were judged when none stood out', async () => {
    await tx('pay', '2026-11-01', 200000)
    for (const d of [1, 2, 3, 4, 5, 6, 7, 8]) await tx(`g${d}`, `2026-11-0${d}`, -2000, GROCERIES)
    await mount()
    expect(within(panel('Unusual spending')).getByText(/1 category has enough purchases to judge, and no purchase in November 2026 is far above what is usual/)).toBeInTheDocument()
  })

  it('states what is missing for a panel that has too little data', async () => {
    await tx('pay', '2026-11-01', 200000)
    await tx('a', '2026-11-03', -10000, GROCERIES)
    await mount()
    expect(within(panel('Month by month')).getByText(/once two months in a row have records\. You have 1 so far/)).toBeInTheDocument()
    expect(within(panel('Month by month')).getByText(/no earlier month with records to compare November 2026 with/)).toBeInTheDocument()
    expect(within(panel('Unusual spending')).getByText(/It begins once a category has 8 purchases/)).toBeInTheDocument()
    expect(within(panel('Small purchases')).getByText(/There were no purchases under/)).toBeInTheDocument()
    expect(within(panel('Small purchases')).queryByText(/middle amount/)).toBeNull()
    expect(within(panel('Purchases by mood')).getByText(/No purchase in November 2026 has a mood recorded yet/)).toBeInTheDocument()
    expect(within(panel('Purchases by mood')).getByRole('link', { name: 'Note today\'s mood' })).toHaveAttribute('href', '#/')
    expect(within(panel('Looking back: worth it or not')).getByRole('link', { name: 'Answer for a purchase' })).toHaveAttribute('href', '#/worth-it')
    // Only the charts that can be drawn are drawn: with nothing to draw there is no empty chart.
    for (const name of ['Month by month', 'Small purchases', 'Purchases by mood', 'Purchases by reason you gave', 'Looking back: worth it or not']) {
      expect(panel(name).querySelector('svg'), name).toBeNull()
    }
  })

  it('says a month has no records rather than drawing a zero, and never joins a line across the gap', async () => {
    await tx('oct-pay', '2026-10-01', 100000)
    await tx('oct-a', '2026-10-05', -20000, GROCERIES)
    const first = await mount()
    expect(screen.getByText(/No bank movements are recorded for November 2026 yet\. Your latest records are from October 2026/)).toBeInTheDocument()
    expect(screen.queryAllByRole('region')).toHaveLength(0)
    first.unmount()

    await tx('pay', '2026-11-01', 200000)
    await tx('a', '2026-11-03', -10000, GROCERIES)
    await tx('aug-a', '2026-08-03', -30000, GROCERIES)
    await mount()
    const p = panel('Month by month')
    expect(dots(p)).toEqual(['October 2026', 'November 2026'])
    expect(within(p).getByText('September 2026: no records')).toBeInTheDocument()
    expect(within(p).getByText(/^August 2026: income not recorded, spent/)).toBeInTheDocument()
  })

  it('gives a change in euros only while the month is running, and the percentage once it is complete', async () => {
    await tx('oct-pay', '2026-10-01', 100000)
    await tx('oct-a', '2026-10-05', -20000, GROCERIES)
    await tx('pay', '2026-11-01', 200000)
    await tx('a', '2026-11-03', -15000, GROCERIES)
    const running = await mount()
    const p = panel('Month by month')
    expect(within(p).getByText(`Spending in November 2026 is down ${formatEur(5000)} on October 2026.`)).toBeInTheDocument()
    expect(p.textContent).not.toMatch(/%/)
    expect(within(p).getByText(/still running and counts only up to 20\/11\/2026, so no percentage/)).toBeInTheDocument()
    running.unmount()

    await mount('2026-12-05', '2026-11')
    const q = panel('Month by month')
    expect(within(q).getByText(`Spending in November 2026 is down ${formatEur(5000)} (25 %) on October 2026.`)).toBeInTheDocument()
    expect(q.textContent).not.toMatch(/still running/)
  })

  it('reads a month that spent what the last one did as the same, and gives no change with nothing before it', async () => {
    await tx('oct-pay', '2026-10-01', 100000)
    await tx('oct-a', '2026-10-05', -15000, GROCERIES)
    await tx('pay', '2026-11-01', 200000)
    await tx('a', '2026-11-03', -15000, GROCERIES)
    const first = await mount()
    expect(within(panel('Month by month')).getByText('Spending in November 2026 is the same as October 2026.')).toBeInTheDocument()
    first.unmount()

    // October is empty and September is not: the month before this one has no records, and nothing is compared across the gap.
    await db.transactions.where('valueDate').startsWith('2026-10').delete()
    await tx('sep-pay', '2026-09-01', 100000)
    await db.analyticsCache.clear()
    await mount()
    const p = panel('Month by month')
    expect(within(p).getByText(/There is no earlier month with records to compare November 2026 with/)).toBeInTheDocument()
    expect(p.textContent).not.toMatch(/ is (up|down|the same)/)
    expect(p.textContent).not.toMatch(/100 %/)
  })

  it('marks an estimated income wherever it appears, and never prints a confident one where none is known', async () => {
    for (const m of ['2026-08', '2026-09', '2026-10']) {
      await tx(`pay-${m}`, `${m}-01`, 100000)
      await tx(`spend-${m}`, `${m}-05`, -20000, GROCERIES)
    }
    await tx('nov-a', '2026-11-03', -10000, GROCERIES) // spending but no income yet: the average of the last three stands in
    const first = await mount()
    const p = panel('Month by month')
    expect(within(p).getByText(`November 2026: income about ${formatEur(100000)} (an estimate), spent ${formatEur(10000)}, left over about ${formatEur(90000)} (based on estimated income)`)).toBeInTheDocument()
    expect(within(p).getByText(new RegExp(`^October 2026: income ${formatEur(100000).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}, spent`))).toBeInTheDocument()
    first.unmount()

    await db.transactions.where('valueDate').startsWith('2026-08').delete()
    await db.transactions.where('valueDate').startsWith('2026-09').delete()
    await db.transactions.where('valueDate').startsWith('2026-10').delete()
    await db.analyticsCache.clear()
    await mount()
    const q = panel('Month by month')
    expect(within(q).getByText(`November 2026: income not recorded, spent ${formatEur(10000)}, left over cannot be worked out`)).toBeInTheDocument()
    expect(q.textContent).not.toContain(`income ${formatEur(0)}`)
  })

  it('does not draw a negative uncategorised figure as spending', async () => {
    // A refund against a savings-kind category can leave the remainder negative. The cache row is written directly: the
    // figure is reachable in principle, and building it from transactions would depend on category kinds.
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
    const p = panel('Essential and discretionary')
    expect(within(p).getByText(`${formatEur(2000)} of money returned to you is not filed under a spending category. It has been taken off the amount spent, and is shown as its own bar below zero; the bars add up to ${formatEur(8000)}.`)).toBeInTheDocument()
    expect(bars(p)).toEqual(['Essentials', 'Discretionary', 'Money returned'])
    expect(p.querySelector('g[data-label="Money returned"]')?.getAttribute('data-cents')).toBe('-2000')
  })

  it('draws money returned from a real refund as its own negative bar, and the bars add up to the amount spent', async () => {
    await returnedInNovember({ ing: null, cents: 25000 }, [['g', 80000, GROCERIES], ['r', 5000, RESTAURANTS]])
    await mount()
    const p = panel('Essential and discretionary')
    const rows = [...p.querySelectorAll('g[data-label]')].map((g) => [g.getAttribute('data-label'), Number(g.getAttribute('data-cents'))])
    expect(rows).toEqual([['Essentials', 80000], ['Discretionary', 5000], ['Money returned', -25000]])
    expect(rows.reduce((sum, r) => sum + (r[1] as number), 0)).toBe(60000)
    expect(p.textContent).toContain(`${formatEur(25000)} of money returned to you is not filed under a spending category. It has been taken off the amount spent`)
    expect(p.textContent).not.toContain('is not counted as spending')
  })

  it('gives no percentage when money returned has made discretionary spending negative', async () => {
    // A 300 EUR jacket bought in October and returned in November, with 50 EUR of other discretionary spending: -250 and 800 essential.
    await returnedInNovember({ ing: SHOPPING, cents: 30000 }, [['g', 80000, GROCERIES], ['r', 5000, RESTAURANTS]])
    await mount()
    const p = panel('Essential and discretionary')
    expect(bars(p)).toEqual(['Essentials', 'Discretionary'])
    expect(p.querySelector('g[data-label="Discretionary"]')?.getAttribute('data-cents')).toBe('-25000')
    expect(p.textContent).not.toMatch(/\d %|is essential/)
    expect(p.textContent).not.toContain('filed as essential or discretionary')
    expect(within(p).getByText(`Money returned to you in November 2026 came to more than was spent on discretionary spending, so the split cannot be given as a percentage. Essentials come to ${formatEur(80000)} and discretionary spending to ${formatEur(-25000)}.`)).toBeInTheDocument()
  })

  it('gives no percentage when money returned has made essentials negative, and names the right group', async () => {
    await returnedInNovember({ ing: GROCERIES, cents: 30000 }, [['r', 50000, RESTAURANTS]])
    await mount()
    const p = panel('Essential and discretionary')
    expect(p.querySelector('g[data-label="Essentials"]')?.getAttribute('data-cents')).toBe('-30000')
    expect(p.textContent).not.toMatch(/ is essential/)
    expect(within(p).getByText(/came to more than was spent on essentials, so the split cannot be given as a percentage/)).toBeInTheDocument()
  })

  it('says money returned came to more than was spent, and gives no split, when the month holds only a refund', async () => {
    // October groceries of 300 EUR, and nothing in November but the refund: essentials -300, spent -300, nothing uncategorised.
    await tx('oct-pay', '2026-10-01', 100000)
    await tx('buy', '2026-10-10', -30000, GROCERIES)
    await tx('ref', '2026-11-05', 30000, null)
    await link('r1', 'buy', 'ref', 30000)
    await mount()
    const p = panel('Essential and discretionary')
    expect(p.querySelector('g[data-label="Essentials"]')).toBeNull() // no bars are drawn for a month with no spending
    const said = 'Money returned to you in November 2026 came to more than was spent, and there is nothing to split.'
    await waitFor(() => expect(within(p).getByText(said)).toBeInTheDocument())
    expect(p.textContent).not.toContain('No spending is recorded')
    expect(p.textContent).not.toContain('cannot be given as a percentage')
    expect(p.textContent).not.toContain(formatEur(-30000)) // the contradictory second sentence is gone
    expect(violations(spoken(p)), 'lists tripped by the panel').toEqual([])
  })

  it('still says no spending is recorded when nothing was spent and nothing was returned', async () => {
    await tx('pay', '2026-11-01', 200000)
    await mount()
    const p = panel('Essential and discretionary')
    expect(within(p).getByText('No spending is recorded in November 2026, so there is nothing to split.')).toBeInTheDocument()
    expect(p.textContent).not.toContain('Money returned')
  })

  it('still gives the percentage when both parts are spending', async () => {
    await tx('pay', '2026-11-01', 200000)
    await tx('g', '2026-11-02', -30000, GROCERIES)
    await tx('r', '2026-11-03', -10000, RESTAURANTS)
    await mount()
    const p = panel('Essential and discretionary')
    expect(within(p).getByText(`Of the ${formatEur(40000)} filed as essential or discretionary, ${formatBp(7500)} is essential.`)).toBeInTheDocument()
  })

  it('shortens a long category name on its bar and keeps the whole name in the list beside it', async () => {
    const LONG = 'Suscripciones, cuotas y servicios de la comunidad de vecinos'
    await db.categories.put({ id: 'cat.long', name: LONG, parentId: null, kind: 'discretionary', isUserCreated: true, ingMappings: [] })
    await tx('pay', '2026-11-01', 200000)
    await tx('long', '2026-11-03', -12345)
    await tx('a', '2026-11-04', -5000, GROCERIES)
    await writeAnnotation('long', { categoryId: 'cat.long' }, 'owner')
    await mount()
    const p = panel('Where the money went')
    const labels = bars(p)
    expect(labels).toHaveLength(2)
    for (const l of labels) expect(Array.from(l ?? '').length).toBeLessThanOrEqual(20)
    expect(labels).toContain('Suscripciones, cuot…')
    expect(labels).not.toContain(LONG)
    // Nothing is lost: the list beside the chart has the whole name and the whole amount.
    expect(within(p).getByText(`${LONG}: ${formatEur(12345)}`)).toBeInTheDocument()
    // The other is shortened the same way.
    expect(labels).toEqual(['Suscripciones, cuot…', 'Supermercados y ali…'])
  })

  it('counts the days after payday only up to today in a running month, and says when too few days are known', async () => {
    await tx('pay', '2026-11-01', 200000)
    await tx('a', '2026-11-03', -10000, GROCERIES)
    await mount()
    const p = panel('The days after payday')
    expect(within(p).getByText(/arrived on 01\/11\/2026\. This covers 20 days, from then up to 20\/11\/2026/)).toBeInTheDocument()
    // Days that have not happened are not days of no spending: the line stops at today (day 19), not at the end of the month.
    expect(dots(p)).toHaveLength(20)
    expect(dots(p)).toContain('Day 19')
    expect(dots(p)).not.toContain('Day 20')
    cleanup()

    // The same month, early on: eleven days are known, three short of the fourteen the shape needs.
    await mount('2026-11-11')
    const q = panel('The days after payday')
    expect(q.querySelector('svg')).toBeNull()
    expect(within(q).getByText(/too few days to show how spending is spread: at least 14 are needed\. It needs 3 more days of this month/)).toBeInTheDocument()
  })

  it('says a late payday leaves too few days, rather than drawing three days as the pattern', async () => {
    await tx('oct-pay', '2026-10-01', 100000)
    await tx('pay', '2026-10-28', 200000)
    await tx('a', '2026-10-29', -10000, GROCERIES)
    await mount('2026-12-05', '2026-10')
    const p = panel('The days after payday')
    expect(within(p).getByText(/arrived on 28\/10\/2026\. This covers 4 days, from then to the end of October 2026/)).toBeInTheDocument()
    expect(p.querySelector('svg')).toBeNull()
    expect(within(p).getByText(/at least 14 are needed\. The month ended before that many days had passed/)).toBeInTheDocument()
  })

  it('says when a month has no income to count from', async () => {
    await tx('a', '2026-11-03', -10000, GROCERIES)
    await mount()
    expect(within(panel('The days after payday')).getByText(/No income is recorded in November 2026, so there is no payday to count from/)).toBeInTheDocument()
  })

  it('shows the coverage sentence only where the number of purchases is known, never "of ?"', async () => {
    await tx('pay', '2026-11-01', 200000)
    await tx('a', '2026-11-03', -10000, GROCERIES)
    await tx('b', '2026-11-04', -5000, GROCERIES)
    const rows: AnnotatedRow[] = [{ key: 'mood.happy', label: 'Happy', transactions: 2, totalCents: 15000, answeredOf: 2, spendsInScope: null }]
    // The cache row stands in for a read whose base is not known (all history reads only annotated rows).
    await db.analyticsCache.put({
      key: 'moodBreakdown:2026-11', engineVersion: ENGINE_VERSION, inputsHash: await inputsHash(), computedAt: AT,
      payload: { shape: 1, value: rows },
    })
    await mount()
    const p = panel('Purchases by mood')
    expect(within(p).getByText('Mood recorded on 2 purchases in November 2026.')).toBeInTheDocument()
    expect(p.textContent).not.toMatch(/ of (\?|null|undefined)|of \d+ purchases/)
  })

  it('uses no causal wording and no technical terms in any reading', async () => {
    await rich()
    const first = await mount()
    const rich1 = spoken()
    first.unmount()
    // The other branches of the same sentences: a completed month, an estimate, a refund, no income, a late payday.
    await mount('2026-12-05', '2026-11')
    const rich2 = spoken()
    cleanup()
    for (const t of [rich1, rich2]) {
      expect(violations(t), 'lists tripped by the page').toEqual([])
    }
    await db.delete(); await db.open(); await seedDatabase()
    await tx('a', '2026-11-03', -10000, GROCERIES)
    await mount()
    expect(violations(spoken()), 'lists tripped by the page').toEqual([])
    expect(spoken().length).toBeGreaterThan(500) // a scan of nothing proves nothing
    // The returned-money branches: an uncategorised return, and a return that makes a group negative.
    for (const purchase of [{ ing: null, cents: 25000 }, { ing: SHOPPING, cents: 30000 }]) {
      cleanup()
      await db.delete(); await db.open(); await seedDatabase()
      uid = 0
      await returnedInNovember(purchase, [['g', 80000, GROCERIES], ['r', 5000, RESTAURANTS]])
      await mount()
      expect(text()).toMatch(/money returned to you/i)
      expect(violations(spoken()), 'lists tripped by the page').toEqual([])
    }
  })

  it('reads the cache rather than the transactions table', async () => {
    await rich()
    // First visit: the figures are computed, which reads the month ranges. The spy proves it can see such a read.
    const where = vi.spyOn(db.transactions, 'where')
    const first = await mount()
    expect(where.mock.calls.map((c) => String(c[0]))).toContain('[accountId+valueDate]')
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

  it('is navigable by keyboard through every panel, and keeps focus when a control is used', async () => {
    await tx('pay', '2026-11-01', 200000)
    await tx('a', '2026-11-03', -10000, GROCERIES)
    await mount()
    // Every panel is a named region led by a heading, in reading order, so landmark and heading navigation reach each in turn.
    const headings = screen.getAllByRole('heading').map((h) => [h.tagName, h.textContent])
    expect(headings).toEqual([['H1', 'Reports'], ...PANELS.map((n) => ['H2', n])])
    for (const name of PANELS) expect(panel(name).firstElementChild?.tagName).toBe('H2')
    // Nothing is a button that does nothing, nothing is disabled, nothing steals the tab order.
    expect(screen.queryAllByRole('button')).toHaveLength(0)
    expect(document.querySelectorAll('[disabled], [aria-disabled="true"]')).toHaveLength(0)
    expect(document.querySelectorAll('[tabindex]:not([tabindex="0"]):not([tabindex="-1"])')).toHaveLength(0)
    const links = screen.getAllByRole('link')
    expect(links.length).toBeGreaterThan(0)
    for (const a of links) expect(a.getAttribute('href')).toMatch(/^#\/[a-z-]*/)

    const mood = screen.getByRole('link', { name: 'Note today\'s mood' })
    mood.focus()
    fireEvent.click(mood)
    expect(document.activeElement).toBe(mood)
    expect(screen.getByRole('heading', { level: 1, name: 'Reports' })).toBeInTheDocument()
  })
})
