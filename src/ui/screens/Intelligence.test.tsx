import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import Intelligence, { MIN_ANSWERED, MIN_REGRETTED, isFinding } from './Intelligence'
import { db } from '../../db/db'
import { seedDatabase } from '../../db/seed'
import { writeAnnotation } from '../../db/annotations'
import { ENGINE_VERSION, inputsHash } from '../../analytics/cache'
import { BATTERY, type RelationshipId } from '../../battery/battery'
import { FDR_BP } from '../../battery/correction'
import { findingFor } from '../../battery/finding'
import type { ContingencyResult } from '../../battery/contingency'
import type { RankFinding } from '../../battery/rank'
import type { CategorySavings, MoodFrequencyFinding, TrendFinding } from '../../battery/trend'
import type { SmallPurchases } from '../../analytics/habits'
import type { MonthPoint } from '../../analytics/series'
import { formatBp, formatEur } from '../../lib/money'
import type { AnnotationRow, TransactionRow } from '../../db/schema'

const TODAY = '2026-11-17' // a Tuesday
// 05/03/2026, deliberately not the month of TODAY and with a day that cannot be read as a month.
const TAUGHT_AT = Date.UTC(2026, 2, 5, 12)

const tx = (id: string, over: Partial<TransactionRow> = {}): TransactionRow => ({
  id, accountId: 'acc', valueDate: '2026-11-17', amountCents: -1000, balanceCents: 50000, description: `SHOP ${id}`, comment: null,
  ingCategory: null, ingSubcategory: null, kind: 'spend', dedupKey: `K${id}`, importId: 'imp', fileSeq: 1, roundupParentId: null,
  createdAt: 1, deletedAt: null, ...over,
})
const ann = (transactionId: string, over: Partial<AnnotationRow> = {}): AnnotationRow => ({
  transactionId, categoryId: null, subcategoryId: null, merchantId: null, typeOverride: null, paymentMethod: null,
  note: null, moodId: null, purchaseReasonId: null, worthwhile: null, reviewed: false, dateOverride: null,
  amountCentsOverride: null, descriptionOverride: null, updatedAt: 1, ...over,
})
const merchant = (id: string, canonicalName: string) =>
  db.merchants.add({ id, canonicalName, kind: 'merchant', matchPatterns: [], defaultCategoryId: null, isSubscription: false, createdAt: 1 })

/** Corrections through the real write path, so the screen and memory.ts are tested against each other. */
let clock = 0
const correct = async (id: string, merchantId: string, categoryId: string) => {
  await db.transactions.add(tx(id))
  await writeAnnotation(id, { categoryId, merchantId }, 'owner')
}

/** Spends on one day, answered worthwhile or not, all attached to one merchant and category. */
async function answered(prefix: string, answers: boolean[], over: Partial<AnnotationRow> = {}, day = '2026-11-17') {
  const ids = answers.map((_, i) => `${prefix}${i}`)
  await db.transactions.bulkAdd(ids.map((id) => tx(id, { valueDate: day, amountCents: -1250 })))
  await db.annotations.bulkAdd(ids.map((id, i) => ann(id, { worthwhile: answers[i]!, ...over })))
}

const settled = async () => {
  await waitFor(() => expect(screen.queryByText(/Loading/)).not.toBeInTheDocument())
}
const pageText = () => document.body.textContent ?? ''

beforeEach(async () => {
  vi.restoreAllMocks()
  await db.delete(); await db.open(); await seedDatabase()
  clock = TAUGHT_AT
  vi.spyOn(Date, 'now').mockImplementation(() => (clock += 10))
})
afterEach(() => { vi.restoreAllMocks() })

describe('Intelligence screen: what has been learned', () => {
  it('says what was learned per merchant, with the number of corrections behind it, and what is still short', async () => {
    await merchant('m1', 'Supermercado Ejemplo'); await merchant('m2', 'Tienda Ejemplo')
    await correct('a', 'm1', 'cat.groceries'); await correct('b', 'm1', 'cat.groceries'); await correct('c', 'm1', 'cat.groceries')
    await correct('d', 'm2', 'cat.shopping')
    render(<Intelligence today={TODAY} />)
    await settled()
    const learned = within(await screen.findByRole('list', { name: 'Learned merchants' })).getAllByRole('listitem')
    expect(learned).toHaveLength(1)
    expect(learned[0]).toHaveTextContent(/Supermercado Ejemplo: .*Corrected 3 times/)
    const groceries = (await db.categories.get('cat.groceries'))!.name
    expect(learned[0]).toHaveTextContent(groceries)
    const pending = within(screen.getByRole('list', { name: 'Merchants still being learned' })).getAllByRole('listitem')
    expect(pending).toHaveLength(1)
    expect(pending[0]).toHaveTextContent(/Tienda Ejemplo: .*Corrected once; 1 more of the same correction/)
    // Something is learned, so the "nothing learned" message must not be shown beside it.
    expect(screen.queryByText(/Nothing learned yet/)).not.toBeInTheDocument()
  })

  it('says plainly that it has learned nothing yet, rather than showing an empty table', async () => {
    render(<Intelligence today={TODAY} />)
    await settled()
    expect(screen.getByText(/Nothing learned yet/)).toHaveTextContent(/corrected it the same way twice/)
    expect(screen.getByText(/have not corrected any merchant/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Transactions' })).toHaveAttribute('href', '#/transactions')
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'Learned merchants' })).not.toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'Merchants still being learned' })).not.toBeInTheDocument()
  })

  it('still says nothing is learned when every merchant has only one correction, and says how many are one short', async () => {
    await merchant('m1', 'Tienda Ejemplo')
    await correct('a', 'm1', 'cat.shopping')
    render(<Intelligence today={TODAY} />)
    await settled()
    expect(screen.getByText(/Nothing learned yet/)).toHaveTextContent(/1 merchant has one correction so far/)
    expect(screen.queryByRole('list', { name: 'Learned merchants' })).not.toBeInTheDocument()
    expect(screen.getByRole('list', { name: 'Merchants still being learned' })).toHaveTextContent('Tienda Ejemplo')
  })

  it('reads the merchants table once for what was learned, however many merchants there are', async () => {
    await merchant('m1', 'Supermercado Ejemplo'); await merchant('m2', 'Tienda Ejemplo')
    await correct('a', 'm1', 'cat.groceries'); await correct('b', 'm1', 'cat.groceries'); await correct('c', 'm2', 'cat.shopping')
    const reads = vi.spyOn(db.merchants, 'toArray')
    render(<Intelligence today={TODAY} />)
    await settled()
    await screen.findByRole('list', { name: 'Learned merchants' })
    await waitFor(() => expect(screen.queryByText(/Loading/)).not.toBeInTheDocument())
    // Two reads in all: one here, handed to the memory, and one by regretClusters for its own labels (a separate module).
    // A screen that also let categoryMemory read the table itself would make three.
    expect(reads).toHaveBeenCalledTimes(2)
  })

  it('shows dates in Spanish format', async () => {
    await merchant('m1', 'Supermercado Ejemplo')
    await correct('a', 'm1', 'cat.groceries'); await correct('b', 'm1', 'cat.groceries')
    render(<Intelligence today={TODAY} />)
    await settled()
    const item = within(await screen.findByRole('list', { name: 'Learned merchants' })).getByRole('listitem')
    expect(item).toHaveTextContent('05/03/2026')
    expect(item).not.toHaveTextContent('2026-03-05')
    expect(item).not.toHaveTextContent('03/05/2026')
  })

  it('names a merchant or category that no longer exists as removed, never as a blank or an id', async () => {
    await merchant('m1', 'Gone')
    await correct('a', 'm1', 'cat.groceries'); await correct('b', 'm1', 'cat.groceries')
    await db.merchants.delete('m1'); await db.categories.delete('cat.groceries')
    render(<Intelligence today={TODAY} />)
    await settled()
    const item = within(await screen.findByRole('list', { name: 'Learned merchants' })).getByRole('listitem')
    expect(item).toHaveTextContent('Removed merchant: Removed category.')
    expect(item).not.toHaveTextContent('cat.groceries')
    expect(item).not.toHaveTextContent('m1')
  })
})

describe('Intelligence screen: purchases marked not worth it', () => {
  it('shows a group with its denominator and its period, and no causal wording', async () => {
    await merchant('m1', 'Bar Pepe')
    await answered('r', [false, false, true], { merchantId: 'm1', purchaseReasonId: 'reason.impulse', moodId: 'mood.bored' })
    render(<Intelligence today={TODAY} />)
    await settled()
    const list = await screen.findByRole('list', { name: 'Not worth it, all your records' })
    const merchantItem = within(list).getByText(/^Merchant: Bar Pepe/)
    expect(merchantItem).toHaveTextContent(`2 of 3 answered purchases marked not worth it, ${formatEur(2500)} in total (all your records)`)
    expect(within(list).getByText(/^Mood: Bored/)).toHaveTextContent('2 of 3')
    expect(within(list).getByText(/^Day of the week: martes/)).toHaveTextContent('2 of 3')
    expect(pageText()).not.toMatch(/because you|caused|makes you|leads? to|results? in|due to/i)
    expect(pageText()).not.toMatch(/\b(tier|classifier|bayesian|cluster|correlation|posterior)\b/i)
  })

  it('names the month when the period is narrowed to it, and counts only that month', async () => {
    await merchant('m1', 'Bar Pepe')
    await answered('n', [false, false, true], { merchantId: 'm1' }, '2026-11-10')
    await answered('o', [false, true, true, true], { merchantId: 'm1' }, '2026-10-10') // 1 of 4 in October
    render(<Intelligence today={TODAY} />)
    await settled()
    expect(await screen.findByText(/^Merchant: Bar Pepe/)).toHaveTextContent('3 of 7')
    fireEvent.click(screen.getByRole('button', { name: 'November 2026' }))
    const item = await screen.findByText(/^Merchant: Bar Pepe.*\(November 2026\)/)
    expect(item).toHaveTextContent('2 of 3 answered purchases')
    expect(item).toHaveTextContent(formatEur(2500))
  })

  it('does not render one regretted purchase out of one as a finding, and says what is missing instead', async () => {
    await merchant('m1', 'Bar Pepe')
    await answered('x', [false], { merchantId: 'm1', purchaseReasonId: 'reason.impulse' })
    render(<Intelligence today={TODAY} />)
    await settled()
    expect(await screen.findByText(/Not enough to say anything yet/)).toHaveTextContent(
      `at least ${MIN_REGRETTED} of its purchases are marked not worth it, out of at least ${MIN_ANSWERED} you answered`)
    expect(screen.queryByRole('list', { name: /Not worth it/ })).not.toBeInTheDocument()
    expect(pageText()).not.toMatch(/Bar Pepe/)
    expect(pageText()).not.toMatch(/1 of 1/)
  })

  it('holds back a group that is under the bar while showing one that is over it, and says it did', async () => {
    await merchant('m1', 'Bar Pepe')
    // Merchant m1 and the weekday group are 2 of 3 and 1 of 1 respectively for the reason only the first purchase has.
    await answered('p', [false, false, true], { merchantId: 'm1' })
    await db.annotations.update('p0', { purchaseReasonId: 'reason.impulse' })
    render(<Intelligence today={TODAY} />)
    await settled()
    const list = await screen.findByRole('list', { name: 'Not worth it, all your records' })
    expect(within(list).getByText(/^Merchant: Bar Pepe/)).toBeInTheDocument()
    expect(within(list).queryByText(/Impulse/)).not.toBeInTheDocument()
    expect(screen.getByText(/1 other group is not shown/)).toBeInTheDocument()
  })

  it('says plainly that nothing is marked yet, with what each group will need, rather than an empty list', async () => {
    render(<Intelligence today={TODAY} />)
    await settled()
    expect(await screen.findByText(/no purchase is marked as not worth it/)).toHaveTextContent(
      `at least ${MIN_REGRETTED} marked not worth it out of at least ${MIN_ANSWERED} you answered`)
    expect(screen.queryByRole('list', { name: /Not worth it/ })).not.toBeInTheDocument()
  })

  it('draws the line at two regretted of three answered', () => {
    const c = (regretted: number, total: number) => ({ by: 'merchant' as const, key: 'k', label: 'L', regretted, total, cents: 100 })
    expect([c(1, 1), c(1, 2), c(1, 3), c(2, 2)].map(isFinding)).toEqual([false, false, false, false])
    expect([c(2, 3), c(3, 3), c(2, 10)].map(isFinding)).toEqual([true, true, true])
  })
})

describe('Intelligence screen: keyboard', () => {
  it('has only controls that act, they are native buttons, and focus stays on the one just used', async () => {
    await answered('p', [false, false, true])
    render(<Intelligence today={TODAY} />)
    await settled()
    await screen.findByRole('list', { name: /Not worth it/ })
    const buttons = screen.getAllByRole('button')
    expect(buttons.map((b) => b.textContent)).toEqual(['All time', 'November 2026'])
    for (const b of buttons) { expect(b.tagName).toBe('BUTTON'); expect(b).not.toHaveAttribute('tabindex', '-1'); expect(b).not.toBeDisabled() }

    const month = screen.getByRole('button', { name: 'November 2026' })
    month.focus()
    fireEvent.click(month)
    expect(month).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'All time' })).toHaveAttribute('aria-pressed', 'false')
    // Wait for what the screen is still doing (reloading the answers), not just for the first change.
    await screen.findByRole('list', { name: 'Not worth it, November 2026' })
    expect(month).toBeInTheDocument()
    expect(document.activeElement).toBe(month)
  })

  it('renders no button at all while there is nothing to act on besides the period', async () => {
    render(<Intelligence today={TODAY} />)
    await settled()
    await screen.findByText(/no purchase is marked/)
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['All time', 'November 2026'])
    expect(screen.queryByRole('button', { name: /teach|forget|reset|clear|undo|apply/i })).not.toBeInTheDocument()
  })
})

// ===========================================================================
// THE BATTERY: the ten declared relationships of §12 as the owner reads them.
//
// Every battery figure is read through the analytics cache, exactly as the rest of this screen's figures are, so the
// fixtures here are CACHE ROWS. That is deliberate and not a shortcut: it tests the screen against the shapes the four
// result modules really hand back (a figure, the gates it is short of, a table no test could be run on), and it is the
// only way to put a chosen set of brackets in front of the correction without inventing a database that happens to
// produce them. The keys belong to the modules; the window is this screen's own decision and is written out here as
// literals rather than imported, so a change to it fails loudly instead of quietly following the code.
// ===========================================================================

const WINDOW_FROM = '2025-12' // twelve months ending in the month of TODAY
const WINDOW_TO = '2026-11'
const SMALL_MONTH = '2026-10' // the latest COMPLETE month in that window
const SMALL_CEILING_CENTS = 1000

const KEY = {
  'mood-amount': 'battery.rank.mood-amount',
  'mood-frequency': 'battery.trend.mood-frequency',
  'stress-discretionary': 'battery.rank.stress-discretionary',
  'boredom-impulse': 'battery:boredom-impulse',
  'reason-worthwhile': 'battery:reason-worthwhile',
  weekend: `battery.rank.weekend.${WINDOW_FROM}.${WINDOW_TO}`,
  payday: `battery.trend.payday:${WINDOW_FROM}:${WINDOW_TO}:${TODAY}`,
  'salary-lifestyle': `battery.trend.salary-lifestyle:${WINDOW_FROM}:${WINDOW_TO}:${TODAY}`,
  'category-savings': `battery.trend.category-savings:${WINDOW_FROM}:${WINDOW_TO}:${TODAY}`,
  months: `monthSeries:${WINDOW_FROM}:${WINDOW_TO}`,
  small: `habits.small:${SMALL_MONTH}:${SMALL_CEILING_CENTS}`,
}

/** A figure the modules would have computed, put where the screen reads from. The hash is taken after the data is set up. */
const cacheRow = async (key: string, value: unknown) => {
  await db.analyticsCache.put({
    key, engineVersion: ENGINE_VERSION, inputsHash: await inputsHash(), computedAt: 1,
    payload: { shape: 1, value },
  })
}

const PERIOD = { from: '2026-01-05', to: '2026-11-15' }
const PERIOD_TEXT = '05/01/2026 to 15/11/2026'

const WEEKEND: RankFinding = { effectBp: 4200, bracket: 'p<0.001', n: 96, period: PERIOD }
const MOOD_AMOUNT: RankFinding = { effectBp: 2600, bracket: 'p<0.05', n: 34, period: PERIOD }
const PAYDAY: TrendFinding = { effectBp: 400, bracket: 'none', n: 120, period: PERIOD }
const MOOD_FREQUENCY: MoodFrequencyFinding = {
  effectBp: 3200, bracket: 'p<0.05', n: 17, period: PERIOD,
  lowMood: { weeks: 9, purchases: 41 }, goodMood: { weeks: 8, purchases: 26 }, tiedWeeks: 3,
}

/** A category the owner named themselves: it reaches the pattern, the effect's label and the action. */
const OWN_CATEGORY = 'Vermut con los amigos'
const CATEGORY_SAVINGS: CategorySavings = {
  months: 7, period: PERIOD,
  categories: [
    { categoryId: 'cat.own', label: OWN_CATEGORY, effectBp: 5100, bracket: 'p<0.01' },
    { categoryId: 'cat.groceries', label: 'Groceries', effectBp: 1200, bracket: 'none' },
  ],
}

/** Too thin in the corners for any test to have been run: a real strength figure beside a placeholder bracket. */
const SPARSE: ContingencyResult = {
  n: 24, period: { from: '2026-09-02', to: '2026-11-04' },
  columns: ['Impulse', 'Not impulse'],
  rows: [
    { key: 'mood.bored', label: 'Bored', counts: [7, 1] },
    { key: 'mood.not-bored', label: 'Any other mood', counts: [14, 2] },
  ],
  chiScaled: 12000, df: 1, vBp: 2200, bracket: 'none', verdict: 'sparse',
}

/** A reason the owner wrote in their own words, and more rows than the comparison can weigh at once. */
const OWN_REASON = 'Because I was tired'
const REASONS: ContingencyResult = {
  n: 40, period: PERIOD,
  columns: ['Worthwhile', 'Not worthwhile'],
  rows: [
    { key: 'reason.impulse', label: 'Impulse', counts: [3, 9] },
    { key: 'reason.planned', label: 'Planned', counts: [14, 2] },
    { key: 'reason.tired', label: OWN_REASON, counts: [1, 11] },
  ],
  chiScaled: 30000, df: 22, vBp: 2800, bracket: 'none', verdict: 'too-many-categories',
}

const WINDOW_LIST = [
  '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05',
  '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11',
]
const point = (month: string, over: Partial<MonthPoint> = {}): MonthPoint => ({
  month, incomeCents: 0, spentCents: 0, savedCents: 0, essentialCents: 0, discretionaryCents: 0, uncategorisedCents: 0,
  netCents: 0, provisional: true, incomeBasis: 'none', transactions: 0, hasData: false, ...over,
})
const SERIES: MonthPoint[] = WINDOW_LIST.map((m) => (m === SMALL_MONTH
  ? point(m, { incomeCents: 200000, spentCents: 120000, transactions: 40, provisional: false, incomeBasis: 'actual', hasData: true })
  : point(m)))
const SMALL: SmallPurchases = { count: 23, totalCents: 14500, medianCents: 450 }

/** weekend, mood-amount and payday looked at; the two tables withheld; everything else short of its gates. */
const seedThree = async () => {
  await cacheRow(KEY.weekend, WEEKEND)
  await cacheRow(KEY['mood-amount'], MOOD_AMOUNT)
  await cacheRow(KEY.payday, PAYDAY)
  await cacheRow(KEY['boredom-impulse'], SPARSE)
  await cacheRow(KEY['reason-worthwhile'], REASONS)
}

/** Every state at once: three verdicts of the correction, three withheld, a plain count, and two still gated. */
const seedAll = async () => {
  await seedThree()
  await cacheRow(KEY['mood-frequency'], MOOD_FREQUENCY)
  await cacheRow(KEY['category-savings'], CATEGORY_SAVINGS)
  await cacheRow(KEY.months, SERIES)
  await cacheRow(KEY.small, SMALL)
}

const BATTERY_REGION = '10 questions about your spending'
const QUESTION_LIST = 'Each question and what it can say'

const region = () => screen.getByRole('region', { name: BATTERY_REGION })
/** The outer items only: each one's own gate list is a nested list, which `within` would otherwise return too. */
const questionItems = (): HTMLElement[] =>
  [...screen.getByRole('list', { name: QUESTION_LIST }).children].filter((e): e is HTMLElement => e instanceof HTMLElement)
const questionFor = (id: RelationshipId): HTMLElement => {
  const item = questionItems()[BATTERY.findIndex((r) => r.id === id)]
  if (item === undefined) throw new Error(`nothing rendered for ${id}`)
  return item
}
/** The one-line state each question carries, read as its own element: "a finding" must not be matched inside a longer sentence. */
const stateOf = (item: HTMLElement): string => item.querySelector('.battery-state')?.textContent ?? ''
/**
 * The line that says how much was read, whole. Asserting the count anywhere in the item would pass on the limitation
 * sentence, which states the count in its own words too; this is the line that LABELS the figure.
 */
const readFrom = (item: HTMLElement): string =>
  [...item.querySelectorAll('p')].map((p) => p.textContent ?? '').find((t) => t.startsWith('Read from:')) ?? ''

const mountBattery = async () => {
  render(<Intelligence today={TODAY} />)
  await settled()
  await screen.findByRole('list', { name: QUESTION_LIST })
}

describe('Intelligence screen: the ten questions', () => {
  it('says what each relationship still needs, on a fresh install, without reading as ten failures', async () => {
    await mountBattery()
    const items = questionItems()
    // One per declared relationship, in the battery's own order, each named by its own question.
    expect(items).toHaveLength(BATTERY.length)
    BATTERY.forEach((r, i) => expect(items[i]).toHaveTextContent(r.question))
    // What is missing and how much more is needed, in the gate's own words — both gates where there are two.
    expect(items[0]).toHaveTextContent(
      'The app needs 30 discretionary purchases with a mood recorded before it can look at this. You have 0, so 30 more purchases are needed.')
    expect(items[0]).toHaveTextContent(
      'The app needs 2 moods that each have at least 10 purchases before it can look at this. You have 0, so 2 more moods are needed.')
    expect(questionFor('category-savings')).toHaveTextContent(
      'The app needs 4 months of spending before it can look at this. You have 0, so 4 more months are needed.')
    for (const item of items) expect(stateOf(item)).toBe('Not enough recorded yet')
    // An ingredient list, not an error log: nothing is raised as a fault and nothing claims the app is broken.
    expect(within(region()).queryAllByRole('alert')).toEqual([])
    expect(region().querySelectorAll('.notice-refusal')).toHaveLength(0)
    expect(region().textContent ?? '').not.toMatch(/\b(error|errors|failed|failure|fails|warning|invalid|unavailable|problem|sorry|unable)\b/i)
    expect(region()).toHaveTextContent('Nothing was looked at this time')
    expect(region()).toHaveTextContent('What this one still needs')
  })

  it('shows a finding with all eight of its fields once the data supports one', async () => {
    await cacheRow(KEY.weekend, WEEKEND)
    await mountBattery()
    // The only relationship with a figure, so it alone is weighed and it survives: p<0.001 against a 5 % bar.
    const f = findingFor('weekend', WEEKEND, { bracket: 'p<0.001', survives: true })
    const item = questionFor('weekend')
    expect(stateOf(item)).toBe('A finding')
    expect(item).toHaveTextContent(f.pattern)
    expect(item).toHaveTextContent(`${f.effect.label}: ${formatBp(f.effect.bp)}`)
    expect(item).toHaveTextContent(f.confidence)
    expect(item).toHaveTextContent('96 purchases')
    expect(item).toHaveTextContent(PERIOD_TEXT)
    expect(item).toHaveTextContent(f.limitation)
    expect(item).toHaveTextContent(f.meaning)
    expect(item).toHaveTextContent(f.action)
  })

  it('keeps the size of an effect and how sure the app is in separate lines', async () => {
    await cacheRow(KEY.weekend, WEEKEND)
    await mountBattery()
    const f = findingFor('weekend', WEEKEND, { bracket: 'p<0.001', survives: true })
    const item = questionFor('weekend')
    const size = within(item).getByText(`${f.effect.label}: ${formatBp(f.effect.bp)}`, { exact: false })
    const sure = within(item).getByText(f.confidence, { exact: false })
    expect(size).not.toBe(sure)
    expect(size.textContent ?? '').not.toContain(f.confidence)
    expect(sure.textContent ?? '').not.toContain(formatBp(f.effect.bp))
    // No single merged score, bar or adjective standing for both.
    expect(item.textContent ?? '').not.toMatch(/\b(score|rating|out of 10|strength and certainty)\b/i)
  })

  it('shows the corrected threshold it applied, and what testing ten things means', async () => {
    await seedThree()
    await mountBattery()
    // Three were validly looked at (p<0.001, p<0.05, none). The two tables were not: a sparse one and one with more
    // answers than the comparison can weigh were never tested, so neither may swell the count the bar is divided by.
    expect(region()).toHaveTextContent('The app looked at 3 of these questions this time')
    expect(region()).toHaveTextContent('the easier it is for one of them to look clear by luck alone')
    // Benjamini-Hochberg at 5 % over m = 3: only rank 1 clears (10 * 3 <= 1 * 500), so the bar applied is 500 / 3 bp.
    expect(region()).toHaveTextContent(`${formatBp(FDR_BP)} on its own, ${formatBp(166)} here`)
    expect(region()).toHaveTextContent('1 of the 3 cleared that')
  })

  it('does not present a result that failed correction as a finding', async () => {
    await seedThree()
    await mountBattery()
    const survivor = questionFor('weekend')
    const beaten = questionFor('mood-amount')
    const uncertain = questionFor('payday')
    const sparse = questionFor('boredom-impulse')
    const tooMany = questionFor('reason-worthwhile')
    const gated = questionFor('salary-lifestyle')

    expect(stateOf(survivor)).toBe('A finding')
    expect(stateOf(beaten)).toBe('Shown, and not called a finding')
    expect(beaten).toHaveTextContent(findingFor('mood-amount', MOOD_AMOUNT, { bracket: 'p<0.05', survives: false }).confidence)
    expect(beaten).toHaveTextContent('34 purchases') // shown in full, and still not called a finding

    // Four withheld states, four different sentences, and none of them is the one a real but uncertain effect gets.
    const notCertain = findingFor('payday', PAYDAY, { bracket: 'none', survives: false }).confidence
    expect(stateOf(uncertain)).toBe('Looked at, and not certain yet')
    expect(uncertain).toHaveTextContent(notCertain)
    for (const held of [sparse, tooMany, gated]) expect(held.textContent ?? '').not.toContain(notCertain)
    expect(sparse).toHaveTextContent(findingFor('boredom-impulse', SPARSE, { bracket: 'none', survives: false }).confidence)
    expect(tooMany).toHaveTextContent(findingFor('reason-worthwhile', REASONS, { bracket: 'none', survives: false }).confidence)
    const states = [stateOf(uncertain), stateOf(sparse), stateOf(tooMany), stateOf(gated)]
    expect(new Set(states).size).toBe(4)
    // Nothing anywhere says the app found no connection: not one of these said that.
    expect(region().textContent ?? '').not.toMatch(/no (effect|connection|link|pattern at all)|does not predict|unrelated/i)
  })

  it('says a table could not be compared at all without calling that an answer', async () => {
    // contingency.ts's fourth shape: enough answers to try, but a row or column of the table is empty, so there is
    // nothing to set beside anything. No test was run, so it is not weighed with the others and no figure is shown.
    const withheld = { withheld: true, n: 21, period: { from: '2026-08-03', to: '2026-10-29' }, why: 'A row or column of the table is empty, so there is nothing to compare.' }
    await cacheRow(KEY['boredom-impulse'], withheld)
    await mountBattery()
    const item = questionFor('boredom-impulse')
    expect(stateOf(item)).toBe('Nothing to compare yet')
    expect(item).toHaveTextContent(withheld.why)
    expect(readFrom(item)).toBe('Read from: 21 purchases, 03/08/2026 to 29/10/2026')
    expect(item.textContent ?? '').not.toContain('How sure the app is')
    expect(region()).toHaveTextContent('Nothing was looked at this time')
  })

  it('reads the cache rather than the transactions table', async () => {
    await seedAll()
    const reads = vi.spyOn(db.transactions, 'toArray')
    await mountBattery()
    // Not one transaction exists, so every figure on the screen can only have come from the cache.
    expect(await db.transactions.count()).toBe(0)
    expect(questionFor('weekend')).toHaveTextContent(findingFor('weekend', WEEKEND, { bracket: 'p<0.001', survives: true }).pattern)
    expect(questionFor('small-purchases')).toHaveTextContent('23 purchases')
    expect(questionFor('category-savings')).toHaveTextContent(OWN_CATEGORY)
    expect(reads).not.toHaveBeenCalled()
  })

  it('never calls a week, a day or a month a transaction', async () => {
    await seedAll()
    await mountBattery()
    // Four of the ten count something else, and each says which: the count is labelled from the finding's own unit.
    expect(readFrom(questionFor('mood-frequency'))).toBe(`Read from: 17 weeks, ${PERIOD_TEXT}`)
    expect(readFrom(questionFor('payday'))).toBe(`Read from: 120 days, ${PERIOD_TEXT}`)
    expect(readFrom(questionFor('category-savings'))).toBe(`Read from: 7 months, ${PERIOD_TEXT}`)
    expect(readFrom(questionFor('weekend'))).toBe(`Read from: 96 purchases, ${PERIOD_TEXT}`)
    expect(readFrom(questionFor('small-purchases'))).toBe('Read from: 23 purchases, 01/10/2026 to 31/10/2026')
    expect(pageText()).not.toMatch(/\d+\s+transactions?\b/i)
    expect(region().textContent ?? '').not.toMatch(/\btransactions? (analysed|counted|used)\b/i)
  })

  it("shows a reason or a category the owner named as the owner's own words", async () => {
    await seedAll()
    await mountBattery()
    const item = questionFor('category-savings')
    const f = findingFor('category-savings', CATEGORY_SAVINGS, { bracket: 'p<0.01', survives: true })
    // The name the owner gave appears in three of the finding's fields, and is quoted as theirs in each.
    for (const field of [f.pattern, f.effect.label, f.action]) expect(field).toContain(OWN_CATEGORY)
    expect(item).toHaveTextContent(f.pattern)
    expect(item).toHaveTextContent(f.action)
    const quoted = [...item.querySelectorAll('q')].map((q) => q.textContent)
    expect(quoted.filter((t) => t === OWN_CATEGORY)).toHaveLength(3)
    // The app's own sentence around it is left alone: the rest of the item carries no quotation.
    expect(quoted.every((t) => t === OWN_CATEGORY)).toBe(true)
    // And the owner's own reason, likewise.
    const reasons = [...questionFor('reason-worthwhile').querySelectorAll('q')].map((q) => q.textContent)
    expect(reasons).toContain(OWN_REASON)
  })

  it('uses no causal or statistical wording anywhere on the page', async () => {
    await seedAll()
    await mountBattery()
    // The two lists that already own these words, read by name out of the files that own them rather than copied: a
    // fourth copy of a rule is how the first three drift apart. src/battery/finding.test.ts reads them the same way.
    const SRC = resolve(import.meta.dirname, '../..')
    const regexFrom = (file: string, name: string): RegExp => {
      const text = readFileSync(resolve(SRC, file), 'utf8')
      const match = new RegExp(`const ${name} = /(.*)/([a-z]*)\\s*$`, 'm').exec(text)
      const source = match?.[1]
      if (source === undefined) throw new Error(`no regex named ${name} in src/${file}`)
      return new RegExp(source, match?.[2] ?? '')
    }
    const causalWords = regexFrom('ui/screens/Reports.test.tsx', 'causalWords')
    const jargonWords = regexFrom('ui/screens/Reports.test.tsx', 'jargonWords')
    const noJargon = regexFrom('learning/categorise.test.ts', 'NO_JARGON')
    // A vacuous extraction would make the assertions below pass on anything.
    expect('because').toMatch(causalWords)
    expect('percentile').toMatch(jargonWords)
    expect('bayes').toMatch(noJargon)
    expect('a plain sentence about your own money').not.toMatch(causalWords)

    // The APP's words. What the owner wrote is quoted as theirs and is not the app speaking: this fixture's own reason
    // is "Because I was tired", which the app may repeat but may not be judged on.
    const clone = document.body.cloneNode(true) as HTMLElement
    for (const q of clone.querySelectorAll('q')) q.remove()
    const appWords = clone.textContent ?? ''
    expect(pageText()).toContain(OWN_REASON) // the owner's words really are on the page
    expect(appWords).not.toContain(OWN_REASON)
    expect(appWords).not.toMatch(causalWords)
    expect(appWords).not.toMatch(jargonWords)
    expect(appWords).not.toMatch(noJargon)
  })

  it('keeps focus and renders no control that does nothing', async () => {
    await answered('p', [false, false, true])
    await seedAll() // after the data, so the rows are stamped with the hash the screen will compute
    await mountBattery()
    // The region reads; it offers nothing to press, and nothing it renders is reachable by keyboard but inert.
    expect(within(region()).queryAllByRole('button')).toEqual([])
    expect(within(region()).queryAllByRole('link')).toEqual([])
    expect(region().querySelectorAll('[tabindex]')).toHaveLength(0)
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['All time', 'November 2026'])

    const month = screen.getByRole('button', { name: 'November 2026' })
    month.focus()
    fireEvent.click(month)
    await screen.findByRole('list', { name: 'Not worth it, November 2026' })
    expect(document.activeElement).toBe(month)
    expect(screen.getByRole('list', { name: QUESTION_LIST })).toBeInTheDocument()
  })
})
