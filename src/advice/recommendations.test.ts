import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../db/db'
import { seedDatabase } from '../db/seed'
import type { AnnotationRow, TransactionRow } from '../db/schema'
import { saveAllocation } from '../budget/allocations'
import { recordAccepted, recordRejected, recordShown } from './state'
import { BANNED_LISTS, WORDING_LISTS, assertNotVacuous, causalWords, jargonWords, noJargon } from '../test/bannedWords'
import { smallPurchases } from '../analytics/habits'
import { formatEur } from '../lib/money'
import { moodAmount, stressDiscretionary, weekend } from '../battery/rank'
import { categorySavings, moodFrequency, paydayTrend, salaryLifestyle } from '../battery/trend'
import { boredomImpulse, reasonWorthwhile } from '../battery/contingency'
import { challengesFor, noteFor } from './education'
import { liveEvidence, recommendationsFor, type Recommendation, type RecommendationId } from './recommendations'

// The battery's ten readers are replaced so a test can say exactly which bracket each relationship came back with:
// the correction is the rule under test, and building twelve months of mood data to reach a chosen bracket would test
// the readers instead. Everything else (budget, series, unusual, regret, the state table) is the real thing.
vi.mock('../battery/rank', () => ({ moodAmount: vi.fn(), stressDiscretionary: vi.fn(), weekend: vi.fn() }))
vi.mock('../battery/trend', () => ({ categorySavings: vi.fn(), moodFrequency: vi.fn(), paydayTrend: vi.fn(), salaryLifestyle: vi.fn() }))
vi.mock('../battery/contingency', () => ({ boredomImpulse: vi.fn(), reasonWorthwhile: vi.fn() }))

const TODAY = '2026-12-05'
const MONTH = '2026-11'
const COMPUTED_AT = 1_000
const GROCERIES: [string, string] = ['Alimentación', 'Supermercados y alimentación']
const RESTAURANTS: [string, string] = ['Ocio y viajes', 'Cafeterías y restaurantes']
const ROUNDUP: [string, string] = ['Ahorro', 'Redondeo']

let uid = 0
const tx = async (
  id: string, valueDate: string, amountCents: number, ing: [string, string] | null = null,
  over: Partial<TransactionRow> = {},
): Promise<void> => {
  await db.transactions.add({
    id, accountId: 'acc.1', valueDate, amountCents, balanceCents: 0, description: `Compra ${id}`, comment: null,
    ingCategory: ing?.[0] ?? null, ingSubcategory: ing?.[1] ?? null, kind: amountCents > 0 ? 'income' : 'spend',
    dedupKey: `k.${++uid}`, importId: 'imp.1', fileSeq: uid, roundupParentId: null, createdAt: 1, deletedAt: null, ...over,
  })
}
const annotate = async (transactionId: string, over: Partial<AnnotationRow>): Promise<void> => {
  await db.annotations.add({
    transactionId, categoryId: null, subcategoryId: null, merchantId: null, typeOverride: null, paymentMethod: null, note: null,
    moodId: null, purchaseReasonId: null, worthwhile: null, reviewed: false, dateOverride: null, amountCentsOverride: null,
    descriptionOverride: null, updatedAt: 1, ...over,
  })
}

type Bracket = 'p<0.001' | 'p<0.01' | 'p<0.05' | 'none'
const PERIOD = { from: '2026-01-01', to: '2026-11-30' }
const rank = (bracket: Bracket) => ({ effectBp: 1000, bracket, n: 40, period: PERIOD })
const contingency = (bracket: Bracket) => ({ verdict: 'tested', bracket, n: 40, vBp: 1000, period: PERIOD, rows: [], columns: ['a', 'b'] })
const salary = (bracket: Bracket, effectBp = 4000) => ({ effectBp, bracket, n: 8, period: PERIOD })

/** Every relationship still gated (an array of unmet gates): nothing was tested, so nothing enters the correction. */
function battery(over: {
  salary?: unknown; others?: Bracket | null
} = {}): void {
  const gated = [] as unknown[]
  const others = over.others ?? null
  const asRank = others === null ? gated : rank(others)
  vi.mocked(moodAmount).mockResolvedValue(asRank as never)
  vi.mocked(stressDiscretionary).mockResolvedValue(asRank as never)
  vi.mocked(weekend).mockResolvedValue(asRank as never)
  vi.mocked(moodFrequency).mockResolvedValue((others === null ? gated : { ...rank(others), lowMood: { weeks: 1, purchases: 1 }, goodMood: { weeks: 1, purchases: 1 }, tiedWeeks: 0 }) as never)
  vi.mocked(paydayTrend).mockResolvedValue(asRank as never)
  vi.mocked(categorySavings).mockResolvedValue((others === null ? gated : { months: 8, period: PERIOD, categories: [{ categoryId: 'c', label: 'c', effectBp: 1000, bracket: others }] }) as never)
  vi.mocked(boredomImpulse).mockResolvedValue((others === null ? gated : contingency(others)) as never)
  vi.mocked(reasonWorthwhile).mockResolvedValue((others === null ? gated : contingency(others)) as never)
  vi.mocked(salaryLifestyle).mockResolvedValue((over.salary ?? gated) as never)
}

/**
 * One owner whose November 2026 holds all six situations at once, over a budget, with history behind it:
 *   groceries   fixed 100,00 EUR allocated, 150,00 EUR spent                       -> overspent-category
 *   uncategorised  ten purchases of 5,00 EUR                                        -> small-purchases-add-up
 *   round-ups   saved in July, September and November only (3 of 6 months)         -> savings-inconsistent
 *   restaurants 20,00 EUR every month June-October, then 150,00 EUR in November    -> unusual-spend
 *   two of three answered restaurant purchases marked not worth it                  -> regret-cluster
 *   the corrected salary-lifestyle finding (see battery())                          -> discretionary-rising
 */
async function world(): Promise<void> {
  await tx('pay', '2026-11-01', 300000)
  await saveAllocation({ categoryId: 'cat.groceries', savingsGoalId: null, percentBp: null, fixedCents: 10000, effectiveFrom: '2026-01-01', note: null })
  for (const [id, day] of [['g1', '06'], ['g2', '07'], ['g3', '08']] as const) await tx(id, `2026-11-${day}`, -5000, GROCERIES)
  for (let i = 1; i <= 10; i++) await tx(`s${i}`, `2026-11-${String(10 + i).padStart(2, '0')}`, -500)
  for (const m of ['2026-06', '2026-07', '2026-08', '2026-09', '2026-10']) await tx(`h${m}`, `${m}-15`, -2000, RESTAURANTS)
  await tx('r1', '2026-11-03', -15000, RESTAURANTS) // Tuesday
  await tx('r2', '2026-11-04', -2000, RESTAURANTS)  // Wednesday
  await tx('r3', '2026-11-05', -2000, RESTAURANTS)  // Thursday
  await annotate('r1', { worthwhile: false })
  await annotate('r2', { worthwhile: false })
  await annotate('r3', { worthwhile: true })
  await tx('old-r', '2026-10-20', -2000, RESTAURANTS) // an earlier month's "not worth it": not November's evidence
  await annotate('old-r', { worthwhile: false })
  for (const m of ['2026-07', '2026-09', '2026-11']) await tx(`u${m}`, `${m}-20`, -300, ROUNDUP, { kind: 'roundup' })
  battery({ salary: salary('p<0.01') })
}

const run = (): Promise<Recommendation[]> => recommendationsFor(MONTH, TODAY, COMPUTED_AT)
const byId = (recs: Recommendation[], id: RecommendationId): Recommendation => {
  const found = recs.find((r) => r.id === id)
  if (!found) throw new Error(`no ${id} recommendation; got ${recs.map((r) => r.id).join(', ')}`)
  return found
}
const ALL_SIX: RecommendationId[] = ['overspent-category', 'small-purchases-add-up', 'savings-inconsistent', 'unusual-spend', 'discretionary-rising', 'regret-cluster']

beforeEach(async () => {
  uid = 0
  await db.delete(); await db.open(); await seedDatabase()
  battery()
})

/** Every owner-facing string a recommendation carries. */
const wordsOf = (r: Recommendation): string[] => [r.noticed, r.evidence.summary, r.why, r.todo]

describe('recommendationsFor', () => {
  it('fills all six fields the spec requires, on every recommendation it produces', async () => {
    await world()
    const recs = await run()
    // The fixture must really have produced every kind, or "every recommendation" is a loop over three of them.
    expect(recs.map((r) => r.id).sort()).toEqual([...ALL_SIX].sort())
    for (const r of recs) {
      for (const field of [r.noticed, r.why, r.todo, r.evidence.summary, r.key, r.evidenceFingerprint]) {
        expect(typeof field).toBe('string')
        expect(field.trim().length).toBeGreaterThan(0)
      }
      expect(r.evidence.transactionIds.length).toBeGreaterThan(0)
      expect(['high', 'medium', 'low']).toContain(r.confidence)
      expect(r.impactCents === null || Number.isInteger(r.impactCents)).toBe(true)
    }
  })

  it('states the same small-purchases figure the analytics reader gives, over the same purchases', async () => {
    await world()
    const small = await smallPurchases(MONTH, 1000, COMPUTED_AT)
    const rec = byId(await run(), 'small-purchases-add-up')
    expect(rec.noticed).toContain(`${small.count} purchases under`)
    expect(rec.noticed).toContain(formatEur(small.totalCents))
    expect(rec.evidence.transactionIds).toHaveLength(small.count)
    await db.transactions.update('s1', { deletedAt: 5 }) // nine is a handful, not a habit
    expect((await run()).map((r) => r.id)).not.toContain('small-purchases-add-up')
  })

  it('says the figure is worked out with refunds taken off when it differs from the purchases listed, and not otherwise', async () => {
    await world()
    expect(byId(await run(), 'overspent-category').evidence.summary).not.toMatch(/refund/i) // 150,00 listed, 150,00 spent
    await tx('ref', '2026-11-20', 2000, GROCERIES, { kind: 'income' })
    await db.transfers.add({ id: 'rf', outTransactionId: 'g1', inTransactionId: 'ref', amountCents: 2000, matchScore: 100, confirmedByUser: true, matchedAt: 1, linkKind: 'refund' })
    const rec = byId(await run(), 'overspent-category')
    expect(rec.noticed).toContain(formatEur(13000)) // 150,00 less the 20,00 refunded
    expect(rec.evidence.summary).toContain(formatEur(15000))
    expect(rec.evidence.summary).toMatch(/refunds taken off, so it can differ/)
  })

  it('names the transactions behind each recommendation, and only those', async () => {
    await world()
    const recs = await run()
    const ids = (id: RecommendationId) => [...byId(recs, id).evidence.transactionIds].sort()
    expect(ids('overspent-category')).toEqual(['g1', 'g2', 'g3'])
    expect(ids('small-purchases-add-up')).toEqual(Array.from({ length: 10 }, (_, i) => `s${i + 1}`).sort())
    expect(ids('unusual-spend')).toEqual(['r1'])
    expect(ids('regret-cluster')).toEqual(['r1', 'r2']) // November's two marked not worth it: not the one marked worth it, not October's
    expect(ids('discretionary-rising')).toEqual(['r1', 'r2', 'r3'])
    expect(ids('savings-inconsistent')).toEqual(['u2026-07', 'u2026-09', 'u2026-11'])
  })

  it('never raises advice from a finding that did not survive correction', async () => {
    await world()
    // Ten relationships tested, nine of them unremarkable, the salary one alone at the 5 % rung. On its own that rung
    // would pass; counted among ten it does not, which is the whole reason the correction exists.
    battery({ salary: salary('p<0.05'), others: 'none' })
    expect((await run()).map((r) => r.id)).not.toContain('discretionary-rising')

    // The control, same bracket and same fixture: with nothing else tested the identical finding does survive. Without
    // this the test above would also pass for an implementation that never raises this advice at all.
    battery({ salary: salary('p<0.05') })
    expect((await run()).map((r) => r.id)).toContain('discretionary-rising')

    // And the correction does not over-withhold: at the strongest rung it holds up beside nine others.
    battery({ salary: salary('p<0.001'), others: 'none' })
    expect((await run()).map((r) => r.id)).toContain('discretionary-rising')
  })

  it('counts a relationship that was tested and came back unremarkable, so it cannot be dropped to loosen the bar', async () => {
    await world()
    // The 1 % rung survives among at most five comparisons (100 * 5 <= 500). Five unremarkable ones beside it make six,
    // so it must not: if the unremarkable ones were left out of the count it would stand alone and be raised.
    battery({ salary: salary('p<0.01') })
    for (const read of [moodAmount, stressDiscretionary, weekend, paydayTrend]) vi.mocked(read).mockResolvedValue(rank('none') as never)
    vi.mocked(moodFrequency).mockResolvedValue({ ...rank('none'), lowMood: { weeks: 1, purchases: 1 }, goodMood: { weeks: 1, purchases: 1 }, tiedWeeks: 0 } as never)
    expect((await run()).map((r) => r.id)).not.toContain('discretionary-rising')
    // With one fewer of them, five in all, it is raised: the line sits exactly where the arithmetic says.
    vi.mocked(paydayTrend).mockResolvedValue([] as never)
    expect((await run()).map((r) => r.id)).toContain('discretionary-rising')
  })

  it('does not count a table the app declined to judge among the comparisons that were made', async () => {
    await world()
    // Three tested unremarkable comparisons beside it make four, and the 1 % rung survives at m = 4 (100 * 4 <= 500).
    // The two contingency tables were not validly tested (too few answers, too many kinds of answer), so they are not
    // comparisons made; counting them would make six, and the same finding would no longer survive (100 * 6 > 500).
    battery({ salary: salary('p<0.01') })
    vi.mocked(moodAmount).mockResolvedValue(rank('none') as never)
    vi.mocked(stressDiscretionary).mockResolvedValue(rank('none') as never)
    vi.mocked(weekend).mockResolvedValue(rank('none') as never)
    vi.mocked(boredomImpulse).mockResolvedValue({ ...contingency('none'), verdict: 'sparse' } as never)
    vi.mocked(reasonWorthwhile).mockResolvedValue({ ...contingency('none'), verdict: 'too-many-categories' } as never)
    expect((await run()).map((r) => r.id)).toContain('discretionary-rising')
  })

  it('raises nothing from a surviving finding that points the other way', async () => {
    await world()
    battery({ salary: salary('p<0.001', -4000) })
    expect((await run()).map((r) => r.id)).not.toContain('discretionary-rising')
  })

  it('withholds an estimated impact it cannot honestly compute, rather than printing zero', async () => {
    await world()
    const recs = await run()
    // No honest saving can be read off a count of small purchases, a pattern across months, a run of savings or a list of purchases the owner rated.
    for (const id of ['small-purchases-add-up', 'savings-inconsistent', 'discretionary-rising', 'regret-cluster'] as const) {
      expect(byId(recs, id).impactCents).toBeNull()
    }
    // Where the bank rows do give a figure it is that figure: the overage on a line and the part above usual. What was marked
    // not worth it is a fact in the summary, not an estimate of what would be saved, so it is not offered as an impact.
    expect(byId(recs, 'overspent-category').impactCents).toBe(5000)  // 150,00 spent against 100,00
    expect(byId(recs, 'unusual-spend').impactCents).toBe(13000)      // 150,00 against a usual 20,00
    expect(byId(recs, 'regret-cluster').evidence.summary).toContain(formatEur(17000)) // what was spent is still said, as a fact
    expect(recs.some((r) => r.impactCents === 0)).toBe(false)
  })

  it('leaves out a recommendation the owner has rejected twice, and only that one', async () => {
    await world()
    const before = await run()
    const small = byId(before, 'small-purchases-add-up')
    await recordShown(small.key, small.evidenceFingerprint, 10); await recordRejected(small.key)
    await recordShown(small.key, 'a-later-month', 20); await recordRejected(small.key) // rejected on a second, separate occasion
    const after = await run()
    expect(after.map((r) => r.id)).not.toContain('small-purchases-add-up')
    expect(after.map((r) => r.id).sort()).toEqual(ALL_SIX.filter((i) => i !== 'small-purchases-add-up').sort())
  })

  it('keeps once rejected advice away for the month it was rejected in, and offers it again in a later month', async () => {
    await world()
    const small = byId(await run(), 'small-purchases-add-up')
    await recordShown(small.key, small.evidenceFingerprint, 10)
    await recordRejected(small.key)
    expect((await run()).map((r) => r.id)).not.toContain('small-purchases-add-up') // "not now" lasts for the period it was said about
    await tx('s11', '2026-11-28', -500) // an import after the rejection brings one more purchase: still the same occurrence
    expect((await run()).map((r) => r.id)).not.toContain('small-purchases-add-up')
    await smallInDecember()
    const later = byId(await recommendationsFor('2026-12', TODAY, COMPUTED_AT), 'small-purchases-add-up')
    expect(later.key).toBe(small.key)
    expect(later.evidenceFingerprint).not.toBe(small.evidenceFingerprint)
  })

  it('hands the state module each recommendation own period, so accepted advice returns only in a later month, not after one more purchase', async () => {
    await world()
    const first = byId(await run(), 'overspent-category')
    expect(first.evidenceFingerprint).toBe(MONTH) // the period the advice is about, not a digest of its rows
    await recordShown(first.key, first.evidenceFingerprint, 10)
    await recordAccepted(first.key)
    expect((await run()).map((r) => r.id)).not.toContain('overspent-category') // the occurrence they already acted on
    await tx('g4', '2026-11-09', -1000, GROCERIES)                              // a new purchase in the same line, imported later
    expect((await run()).map((r) => r.id)).not.toContain('overspent-category') // still their Accept: the month is the same
    // The same line over its allocation in a later month is a new occurrence.
    await tx('g5', '2026-12-02', -15000, GROCERIES)
    const later = byId(await recommendationsFor('2026-12', TODAY, COMPUTED_AT), 'overspent-category')
    expect(later.key).toBe(first.key)
    expect(later.evidenceFingerprint).toBe('2026-12')
  })

  it('keeps each key the same when the figures change, so a dismissal keeps taking effect', async () => {
    await world()
    const before = await run()
    // Same situations, different amounts everywhere.
    const replace = async (id: string, date: string, cents: number, ing: [string, string] | null) => { await db.transactions.delete(id); await tx(id, date, cents, ing) }
    await replace('g1', '2026-11-06', -9000, GROCERIES)
    await replace('r1', '2026-11-03', -30000, RESTAURANTS)
    for (let i = 1; i <= 10; i++) await replace(`s${i}`, `2026-11-${String(10 + i).padStart(2, '0')}`, -700, null)
    const after = await run()
    expect(after.map((r) => r.key).sort()).toEqual(before.map((r) => r.key).sort())
    expect(byId(after, 'overspent-category').impactCents).not.toBe(byId(before, 'overspent-category').impactCents)
    expect(byId(before, 'overspent-category').key).toBe('overspent-category:cat.groceries')
    expect(byId(before, 'small-purchases-add-up').key).toBe('small-purchases-add-up')
    expect(byId(before, 'savings-inconsistent').key).toBe('savings-inconsistent')
    expect(byId(before, 'unusual-spend').key).toBe('unusual-spend:cat.restaurants')
    expect(byId(before, 'discretionary-rising').key).toBe('discretionary-rising')
    expect(byId(before, 'regret-cluster').key).toBe('regret-cluster:category:cat.restaurants')
    for (const r of before) expect(r.key).not.toMatch(/\d{3,}/) // no figure, no date, in a key
  })

  it('gives the same fingerprint for the same run twice, and when evidence is swapped for other purchases in the same month', async () => {
    await world()
    const a = byId(await run(), 'overspent-category')
    expect(byId(await run(), 'overspent-category').evidenceFingerprint).toBe(a.evidenceFingerprint)
    await db.transactions.update('g3', { deletedAt: 5 })
    await tx('g9', '2026-11-08', -5000, GROCERIES)
    const swapped = byId(await run(), 'overspent-category')
    expect(swapped.evidence.transactionIds).not.toEqual(a.evidence.transactionIds) // different evidence...
    expect(swapped.evidenceFingerprint).toBe(a.evidenceFingerprint)                // ...the same occurrence
  })

  it('labels each impact figure as what it is and the period it covers, and never calls it a saving', async () => {
    await world()
    const recs = await run()
    expect(byId(recs, 'overspent-category').impactLabel).toBe('Over the allocation in November 2026')
    expect(byId(recs, 'unusual-spend').impactLabel).toBe('Above your usual for this category in November 2026')
    for (const r of recs) {
      expect(r.impactLabel === null, r.id).toBe(r.impactCents === null) // a figure always comes with its label, and no label without a figure
      expect(r.impactLabel ?? '').not.toMatch(/sav(e|ing)|gain|earn/i)
    }
  })

  it('says a month still running is the month so far, in the small-purchases advice', async () => {
    await world()
    expect(byId(await run(), 'small-purchases-add-up').noticed).toMatch(/ in November 2026\.$/) // November is over: no "so far"
    await smallInDecember()
    const december = byId(await recommendationsFor('2026-12', TODAY, COMPUTED_AT), 'small-purchases-add-up')
    expect(december.noticed).toMatch(/ so far in December 2026\.$/)
    expect(december.evidence.summary).toContain('this month so far')
  })

  it('offers one regret card for the same purchases, the grouping with the most marked not worth it, in a fixed order', async () => {
    await world()
    // Give r1 and r2 a shared merchant as well: the same two purchases now form a category group and a merchant group.
    await db.annotations.update('r1', { merchantId: 'm1' })
    await db.annotations.update('r2', { merchantId: 'm1' })
    await db.annotations.update('r3', { merchantId: 'm1' }) // answered "worth it": it makes three answered, which is what a group needs to count
    const regrets = (await run()).filter((r) => r.id === 'regret-cluster')
    expect(regrets).toHaveLength(1)
    expect(regrets[0]?.key).toBe('regret-cluster:category:cat.restaurants') // tie on purchases and amount: the fixed order puts category first
    expect(regrets[0]?.evidence.transactionIds).toEqual(['r1', 'r2'])
  })

  it('leaves the how of saving to the challenge, so the advice, the note and the challenge do not say the same thing three times', async () => {
    await world()
    const savings = byId(await run(), 'savings-inconsistent')
    expect(savings.todo).not.toMatch(/\b(day|move the same amount)\b/i) // choosing a day and an amount is the challenge's instruction
    expect(noteFor('savings-inconsistent')?.body).not.toMatch(/\b(day|amount)\b/i)
    expect(challengesFor('savings-inconsistent', false).map((c) => c.id)).toEqual(['savings-step-up'])
  })

  it('says nothing of recent change, rising or time in the wants advice, since it compares higher-income months with lower-income ones', async () => {
    await world()
    const wants = byId(await run(), 'discretionary-rising')
    const said = [wants.noticed, wants.evidence.summary, wants.why, wants.todo].join(' ')
    expect(said).not.toMatch(/\b(recent\w*|gone up|going up|rising|rises?|rose|growing|grew|over time|increas\w*|more and more)\b/i)
    expect(wants.noticed).toMatch(/months at your higher income, a larger share of your spending went on wants/)
  })

  it('reads every amount from the bank row, whatever the owner typed over it', async () => {
    await world()
    await annotate('g1', { amountCentsOverride: -100 })  // a big purchase made to look small
    await annotate('s1', { amountCentsOverride: -9000 })  // a small one made to look big
    const recs = await run()
    expect(byId(recs, 'overspent-category').impactCents).toBe(5000)
    expect([...byId(recs, 'small-purchases-add-up').evidence.transactionIds].sort())
      .toEqual(Array.from({ length: 10 }, (_, i) => `s${i + 1}`).sort())
  })

  it('does not call a line over when it is only a little past what the owner set', async () => {
    await tx('pay', '2026-11-01', 300000)
    await saveAllocation({ categoryId: 'cat.groceries', savingsGoalId: null, percentBp: null, fixedCents: 10000, effectiveFrom: '2026-01-01', note: null })
    await tx('g1', '2026-11-06', -10500, GROCERIES) // 5 % past
    expect((await run()).map((r) => r.id)).not.toContain('overspent-category')
    await tx('g2', '2026-11-07', -500, GROCERIES)   // now 10 % past: the bar is inclusive
    expect((await run()).map((r) => r.id)).toContain('overspent-category')
  })

  it('reads only the month it was asked about for its evidence, and an unusual purchase only when it is that month\'s', async () => {
    await world()
    await tx('g0', '2026-10-06', -5000, GROCERIES)   // last month, same line
    await tx('sold', '2026-10-12', -500)             // last month, small
    await tx('old', '2026-09-02', -30000, RESTAURANTS) // an outlier from September
    const recs = await run()
    expect([...byId(recs, 'overspent-category').evidence.transactionIds].sort()).toEqual(['g1', 'g2', 'g3'])
    expect(byId(recs, 'small-purchases-add-up').evidence.transactionIds).not.toContain('sold')
    expect(byId(recs, 'unusual-spend').evidence.transactionIds).toEqual(['r1'])
  })

  it('names a savings rhythm only when some months saved and some did not', async () => {
    await world()
    for (const m of ['2026-06', '2026-08', '2026-10']) await tx(`more${m}`, `${m}-20`, -300, ROUNDUP, { kind: 'roundup' })
    expect((await run()).map((r) => r.id)).not.toContain('savings-inconsistent') // every month saved
    await db.transactions.toCollection().filter((t) => t.kind === 'roundup').modify({ deletedAt: 9 })
    expect((await run()).map((r) => r.id)).not.toContain('savings-inconsistent') // none did
  })

  it('does not count a month still running as a month without savings', async () => {
    await world()
    // December is the running month (today is the 5th) and holds a purchase but no saving yet. Counted, it would make
    // four months without savings instead of three.
    await tx('dec', '2026-12-02', -2000, RESTAURANTS)
    const asked = await recommendationsFor('2026-12', TODAY, COMPUTED_AT)
    const rec = byId(asked, 'savings-inconsistent')
    expect(rec.noticed).toContain('3 of the 6 months')
    expect(rec.noticed).toContain('the other 3')
    expect(rec.noticed).toContain('Between June 2026 and November 2026')
  })

  it('says nothing for a month with nothing to say', async () => {
    expect(await run()).toEqual([])
  })

  it('uses no causal, jargon or shaming wording in any field, for any recommendation', async () => {
    // The scan reads the project's one set of lists; it is only worth anything if those lists are not vacuous.
    expect(BANNED_LISTS).toHaveLength(3)
    expect(() => assertNotVacuous(BANNED_LISTS)).not.toThrow()
    expect(WORDING_LISTS.map((l) => l.name)).toEqual(['meansAssumption', 'shamingWords'])
    expect(() => assertNotVacuous(WORDING_LISTS)).not.toThrow()
    for (const list of BANNED_LISTS) {
      expect(list.pattern.test(list.forbids)).toBe(true)
      expect(list.pattern.test(list.allows)).toBe(false)
    }
    const patterns = [causalWords, jargonWords, noJargon, ...WORDING_LISTS.map((l) => l.pattern)]
    const offending = (r: Recommendation): string[] =>
      wordsOf(r).flatMap((text) => patterns.flatMap((p) => (p.exec(text) ? [`${p.source.slice(0, 12)}: ${text}`] : [])))

    // The detector catches a poisoned recommendation in each field, so a clean result below means something.
    await world()
    const recs = await run()
    const clean = byId(recs, 'overspent-category')
    for (const poisoned of [
      { ...clean, noticed: 'Spending went up because of the weekend.' },
      { ...clean, why: 'This is a percentile of your month.' },
      { ...clean, todo: 'Fix the model.' },
      { ...clean, why: 'You should not have spent it.' },
      { ...clean, todo: 'You could just stop buying coffee.' },
      { ...clean, evidence: { ...clean.evidence, summary: 'It is due to stress.' } },
    ]) expect(offending(poisoned).length).toBeGreaterThan(0)

    expect(recs).toHaveLength(6)
    expect(recs.flatMap(wordsOf).length).toBe(24)
    for (const r of recs) expect(offending(r)).toEqual([])
  })

  it('leaves no unfilled placeholder in any field', async () => {
    await world()
    const text = (await run()).flatMap(wordsOf).join(' ')
    expect(text.length).toBeGreaterThan(500)
    expect(text).not.toMatch(/\bNaN\b|undefined|\[object/)
    // Nothing in the app supports a claim about people in general: the advice speaks only about the owner's own records.
    expect(text).not.toMatch(/\b(common|most people|many people|typically|everyone)\b/i)
  })
})

describe('liveEvidence', () => {
  it('drops evidence whose transaction has since been deleted, rather than showing a blank row', async () => {
    await world()
    const rec = byId(await run(), 'overspent-category')
    expect(rec.evidence.transactionIds).toHaveLength(3)

    const intact = await liveEvidence(rec.evidence)
    expect(intact.rows.map((r) => r.id).sort()).toEqual(['g1', 'g2', 'g3'])
    expect(intact.dropped).toBe(0)

    await db.transactions.update('g2', { deletedAt: 99 }) // soft-deleted after the advice was generated
    await db.transactions.delete('g3')                     // and one removed outright
    const shown = await liveEvidence(rec.evidence)
    expect(shown.rows.map((r) => r.id)).toEqual(['g1'])
    expect(shown.dropped).toBe(2)
    for (const row of shown.rows) {
      expect(row.description.trim().length).toBeGreaterThan(0)
      expect(row.valueDate).toBe('2026-11-06')
      expect(row.amountCents).toBe(-5000)
    }
  })

  it('shows the bank date and amount, with the owner\'s own description', async () => {
    await world()
    await annotate('g1', { descriptionOverride: 'Mercado del barrio', amountCentsOverride: -1, dateOverride: '2026-01-01' })
    const rec = byId(await run(), 'overspent-category')
    const row = (await liveEvidence(rec.evidence)).rows.find((r) => r.id === 'g1')
    expect(row).toEqual({ id: 'g1', valueDate: '2026-11-06', amountCents: -5000, description: 'Mercado del barrio' })
  })

  it('returns no rows, not a thrown error, when every transaction is gone', async () => {
    const out = await liveEvidence({ transactionIds: ['nope'], summary: 'x' })
    expect(out).toEqual({ rows: [], dropped: 1 })
  })
})

/** Ten small purchases in December, so a later month has the same situation as November. */
async function smallInDecember(): Promise<void> {
  for (let i = 1; i <= 10; i++) await tx(`d${i}`, `2026-12-0${i === 10 ? 4 : i}`, -500)
}
