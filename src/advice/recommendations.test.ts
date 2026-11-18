import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../db/db'
import { seedDatabase } from '../db/seed'
import type { AnnotationRow, TransactionRow } from '../db/schema'
import { saveAllocation } from '../budget/allocations'
import { recordAccepted, recordRejected, recordShown } from './state'
import { BANNED_LISTS, assertNotVacuous, causalWords, jargonWords, noJargon } from '../test/bannedWords'
import { moodAmount, stressDiscretionary, weekend } from '../battery/rank'
import { categorySavings, moodFrequency, paydayTrend, salaryLifestyle } from '../battery/trend'
import { boredomImpulse, reasonWorthwhile } from '../battery/contingency'
import { fingerprintOf, liveEvidence, recommendationsFor, type Recommendation, type RecommendationId } from './recommendations'

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

  it('names the transactions behind each recommendation, and only those', async () => {
    await world()
    const recs = await run()
    const ids = (id: RecommendationId) => [...byId(recs, id).evidence.transactionIds].sort()
    expect(ids('overspent-category')).toEqual(['g1', 'g2', 'g3'])
    expect(ids('small-purchases-add-up')).toEqual(Array.from({ length: 10 }, (_, i) => `s${i + 1}`).sort())
    expect(ids('unusual-spend')).toEqual(['r1'])
    expect(ids('regret-cluster')).toEqual(['r1', 'r2']) // the two marked not worth it, not the one marked worth it
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
    // No honest saving can be read off a count of small purchases, a pattern across months or a run of savings.
    for (const id of ['small-purchases-add-up', 'savings-inconsistent', 'discretionary-rising'] as const) {
      expect(byId(recs, id).impactCents).toBeNull()
    }
    // Where the bank rows do give a figure it is that figure: the overage on a line, the part above usual, what was marked not worth it.
    expect(byId(recs, 'overspent-category').impactCents).toBe(5000)  // 150,00 spent against 100,00
    expect(byId(recs, 'unusual-spend').impactCents).toBe(13000)      // 150,00 against a usual 20,00
    expect(byId(recs, 'regret-cluster').impactCents).toBe(17000)     // 150,00 + 20,00
    expect(recs.some((r) => r.impactCents === 0)).toBe(false)
  })

  it('leaves out a recommendation the owner has rejected twice, and only that one', async () => {
    await world()
    const before = await run()
    const small = byId(before, 'small-purchases-add-up')
    for (const at of [10, 20]) { await recordShown(small.key, small.evidenceFingerprint, at); await recordRejected(small.key) }
    const after = await run()
    expect(after.map((r) => r.id)).not.toContain('small-purchases-add-up')
    expect(after.map((r) => r.id).sort()).toEqual(ALL_SIX.filter((i) => i !== 'small-purchases-add-up').sort())
  })

  it('offers once rejected advice again, since one dismissal is "not now"', async () => {
    await world()
    const small = byId(await run(), 'small-purchases-add-up')
    await recordShown(small.key, small.evidenceFingerprint, 10)
    await recordRejected(small.key)
    expect((await run()).map((r) => r.id)).toContain('small-purchases-add-up')
  })

  it('hands the state module each recommendation\'s own fingerprint, so accepted advice returns only with new evidence', async () => {
    await world()
    const first = byId(await run(), 'overspent-category')
    await recordShown(first.key, first.evidenceFingerprint, 10)
    await recordAccepted(first.key)
    expect((await run()).map((r) => r.id)).not.toContain('overspent-category') // the occurrence they already acted on
    await tx('g4', '2026-11-09', -1000, GROCERIES)                              // a new purchase in the same line
    const again = byId(await run(), 'overspent-category')
    expect(again.key).toBe(first.key)
    expect(again.evidenceFingerprint).not.toBe(first.evidenceFingerprint)
    expect(again.evidence.transactionIds).toContain('g4')
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

  it('gives the same fingerprint for the same run twice, and a different one when one transaction is swapped for another of the same size', async () => {
    await world()
    const a = byId(await run(), 'overspent-category')
    expect(byId(await run(), 'overspent-category').evidenceFingerprint).toBe(a.evidenceFingerprint)
    // Swap one transaction for another of the same size: same count, same total, different evidence.
    await db.transactions.update('g3', { deletedAt: 5 })
    await tx('g9', '2026-11-08', -5000, GROCERIES)
    const swapped = byId(await run(), 'overspent-category')
    expect(swapped.evidence.transactionIds.length).toBe(a.evidence.transactionIds.length)
    expect(swapped.impactCents).toBe(a.impactCents)
    expect(swapped.evidenceFingerprint).not.toBe(a.evidenceFingerprint)
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

  it('says nothing for a month with nothing to say', async () => {
    expect(await run()).toEqual([])
  })

  it('uses no causal, jargon or shaming wording in any field, for any recommendation', async () => {
    // The scan reads the project's one set of lists; it is only worth anything if those lists are not vacuous.
    expect(BANNED_LISTS).toHaveLength(3)
    expect(() => assertNotVacuous(BANNED_LISTS)).not.toThrow()
    for (const list of BANNED_LISTS) {
      expect(list.pattern.test(list.forbids)).toBe(true)
      expect(list.pattern.test(list.allows)).toBe(false)
    }
    const patterns = [causalWords, jargonWords, noJargon]
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
      { ...clean, evidence: { ...clean.evidence, summary: 'It is due to stress.' } },
    ]) expect(offending(poisoned).length).toBeGreaterThan(0)

    expect(recs).toHaveLength(6)
    expect(recs.flatMap(wordsOf).length).toBe(24)
    for (const r of recs) expect(offending(r)).toEqual([])
  })

  it('judges nobody: no word of instruction or blame, and no unfilled placeholder', async () => {
    await world()
    const text = (await run()).flatMap(wordsOf).join(' ')
    expect(text).not.toMatch(/\b(should|must|waste|wasted|splurge|overspen[dt]|too much|careless|bad)\b/i)
    expect(text).not.toMatch(/\bNaN\b|undefined|\[object/)
  })
})

describe('fingerprintOf', () => {
  it('does not depend on the order of the ids', () => {
    expect(fingerprintOf(['a', 'b', 'c'])).toBe(fingerprintOf(['c', 'a', 'b']))
  })
  it('differs when the evidence differs: another id, fewer ids, or an id that contains the separator', () => {
    const base = fingerprintOf(['a', 'b', 'c'])
    expect(fingerprintOf(['a', 'b', 'd'])).not.toBe(base)
    expect(fingerprintOf(['a', 'b'])).not.toBe(base)
    expect(fingerprintOf(['a|b', 'c'])).not.toBe(fingerprintOf(['a', 'b|c'])) // one id containing the separator is not two ids
    expect(fingerprintOf([])).not.toBe(fingerprintOf(['']))
  })
  it('counts a repeated id once, since it is the same transaction', () => {
    expect(fingerprintOf(['a', 'a', 'b'])).toBe(fingerprintOf(['a', 'b']))
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
