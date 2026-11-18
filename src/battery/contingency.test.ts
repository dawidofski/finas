import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db/db'
import { seedDatabase } from '../db/seed'
import type { AnnotationRow, TransactionRow } from '../db/schema'
import { CHI_SCALE } from './stats'
import { CHI_TABLE_MAX_DF, chiSquareBracket } from './critical'
import { boredomImpulse, reasonWorthwhile, type ContingencyResult, type Withheld } from './contingency'

// Every expected figure below is worked by hand, with real arithmetic, in the comment above it. Tests may use floats;
// the module may not. chiSquareScaled rounds each cell's term to one unit of 1/CHI_SCALE, so a hand value that is not
// exact is compared within a couple of units; V is floored, so it is compared within one basis point.

let seq = 0
const tx = (id: string, over: Partial<TransactionRow> = {}): TransactionRow => ({
  id, accountId: 'acc', valueDate: '2026-11-16', amountCents: -1000,
  balanceCents: 50000, description: 'SHOP', comment: null,
  ingCategory: null, ingSubcategory: null,
  kind: 'spend', dedupKey: `K${id}`, importId: 'imp', fileSeq: 1, roundupParentId: null,
  createdAt: 1, deletedAt: null, ...over,
})
const ann = (transactionId: string, over: Partial<AnnotationRow> = {}): AnnotationRow => ({
  transactionId, categoryId: null, subcategoryId: null, merchantId: null, typeOverride: null, paymentMethod: null,
  note: null, moodId: null, purchaseReasonId: null, worthwhile: null, reviewed: false, dateOverride: null,
  amountCentsOverride: null, descriptionOverride: null, updatedAt: 1, ...over,
})

interface Group {
  n: number
  reason?: string | null
  mood?: string | null
  worthwhile?: boolean | null
  amountCents?: number
  kind?: TransactionRow['kind']
  /** The bank's valueDate. */
  date?: string
  /** The owner's correction of the date, which must never move a period. */
  dateOverride?: string
  annotate?: boolean
}
/** Adds `n` spends per group, each with the annotation the group describes. */
async function put(groups: Group[]): Promise<void> {
  const txs: TransactionRow[] = []
  const anns: AnnotationRow[] = []
  for (const g of groups) {
    for (let i = 0; i < g.n; i++) {
      const id = `t${(seq += 1)}`
      txs.push(tx(id, { amountCents: g.amountCents ?? -1000, kind: g.kind ?? 'spend', valueDate: g.date ?? '2026-11-16' }))
      if (g.annotate === false) continue
      anns.push(ann(id, { purchaseReasonId: g.reason ?? null, moodId: g.mood ?? null, worthwhile: g.worthwhile ?? null, dateOverride: g.dateOverride ?? null }))
    }
  }
  await db.transactions.bulkAdd(txs)
  await db.annotations.bulkAdd(anns)
}

const asResult = (o: unknown): ContingencyResult => {
  expect(o).not.toBeInstanceOf(Array)
  expect(o).not.toHaveProperty('withheld')
  return o as ContingencyResult
}
const asWithheld = (o: unknown): Withheld => {
  expect(o).toHaveProperty('withheld', true)
  return o as Withheld
}
const counts = (r: ContingencyResult) => Object.fromEntries(r.rows.map((x) => [x.key, x.counts]))

beforeEach(async () => {
  seq = 0
  await db.delete(); await db.open(); await seedDatabase()
})

const E = 'reason.essential'
const I = 'reason.impulse'

describe('reasonWorthwhile', () => {
  it('builds the table from the owners reasons and hindsight answers, counting only answered spends', async () => {
    await put([
      { n: 12, reason: E, worthwhile: true }, { n: 3, reason: E, worthwhile: false },
      { n: 5, reason: I, worthwhile: true }, { n: 12, reason: I, worthwhile: false },
      // None of these may touch the table or the count: no hindsight answer, no reason, no annotation at all, and money in.
      { n: 3, reason: I, worthwhile: null }, { n: 2, reason: null, worthwhile: true }, { n: 4, annotate: false },
      { n: 2, reason: E, worthwhile: false, amountCents: 2500 },
      // Money out but not a spend (a transfer the owner answered by mistake): not a purchase, so not in the table.
      { n: 3, reason: E, worthwhile: false, kind: 'income' },
    ])
    const r = asResult(await reasonWorthwhile(1))
    // Rows essential [12 yes, 3 no] (15) and impulse [5, 12] (17); columns yes 17, no 15; N = 32; df = 1.
    // Expected counts: 15*17/32 = 7.97, 15*15/32 = 7.03, 17*17/32 = 9.03, 17*15/32 = 7.97, all at least 5.
    // For a 2x2, chi-square = N(ad - bc)^2 / (r1 r2 c1 c2) = 32 * (12*12 - 3*5)^2 / (15*17*17*15)
    //   = 32 * 129^2 / 65025 = 532512 / 65025 = 8.189343.
    // V = sqrt(8.189343 / (32 * 1)) = sqrt(0.255917) = 0.50588, so 5058 bp.
    // df-1 criticals: 3.8415 (p<0.05), 6.6349 (p<0.01), 10.8276 (p<0.001). 8.189343 is between the last two: p<0.01 exactly.
    expect(r.n).toBe(32)
    expect(counts(r)).toEqual({ [E]: [12, 3], [I]: [5, 12] })
    expect(r.df).toBe(1)
    expect(Math.abs(r.chiScaled - Math.round(8.189343 * CHI_SCALE))).toBeLessThanOrEqual(2)
    expect(Math.abs(r.vBp - 5058)).toBeLessThanOrEqual(1)
    expect(r.bracket).toBe('p<0.01')
    expect(r.verdict).toBe('tested')
  })

  it('reports Cramers V beside the bracket, so strength and certainty are separate', async () => {
    // Certain and tiny: 2000 spends, essential [535 yes, 465 no], impulse [465, 535]. Every expected count is 500.
    // chi-square = 2000 * (535*535 - 465*465)^2 / 1000^4 = 2000 * 70000^2 / 10^12 = 2000 * 4.9e9 / 1e12 = 9.8, above the
    // df-1 critical 6.6349 and below 10.8276, so exactly p<0.01. V = sqrt(9.8 / 2000) = sqrt(0.0049) = 0.07, so exactly 700 bp: a relationship the
    // owner can be sure of that barely matters.
    await put([
      { n: 535, reason: E, worthwhile: true }, { n: 465, reason: E, worthwhile: false },
      { n: 465, reason: I, worthwhile: true }, { n: 535, reason: I, worthwhile: false },
    ])
    const tiny = asResult(await reasonWorthwhile(1))
    expect(tiny.chiScaled).toBe(98000)
    expect(tiny.vBp).toBe(700)
    expect(tiny.bracket).toBe('p<0.01')

    // Sizeable and uncertain: 30 spends, essential [9, 6], impulse [6, 9]; every expected count 7.5.
    // chi-square = 30 * (9*9 - 6*6)^2 / 15^4 = 30 * 2025 / 50625 = 1.2, below 3.8415, so no bracket.
    // V = sqrt(1.2 / 30) = sqrt(0.04) = 0.2, exactly 2000 bp. A real figure with bracket 'none' is an answer, not an error.
    await db.annotations.clear(); await db.transactions.clear()
    await put([
      { n: 9, reason: E, worthwhile: true }, { n: 6, reason: E, worthwhile: false },
      { n: 6, reason: I, worthwhile: true }, { n: 9, reason: I, worthwhile: false },
    ])
    const sizeable = asResult(await reasonWorthwhile(2))
    expect(sizeable.chiScaled).toBe(12000)
    expect(sizeable.vBp).toBe(2000)
    expect(sizeable.bracket).toBe('none')
    // The two numbers moved in opposite directions, which a single score could not show.
    expect(sizeable.vBp).toBeGreaterThan(tiny.vBp)
  })

  it('withholds the result when a row or column of the table is empty', async () => {
    // Thirty-one spends, every one judged worthwhile: the "not worthwhile" column is empty, its expected counts are zero,
    // and chi-square would divide by zero. The honest answer is no figure, not a number computed around the gap.
    await put([{ n: 16, reason: E, worthwhile: true }, { n: 15, reason: I, worthwhile: true }])
    const w = asWithheld(await reasonWorthwhile(1))
    expect(w.n).toBe(31)
    expect(w).not.toHaveProperty('vBp')
    expect(w).not.toHaveProperty('bracket')
  })

  it('counts a removed reason under its own label rather than dropping its spends', async () => {
    // reason.ghost has no row in purchaseReasons: the owner removed it, but fifteen spends still carry it.
    // Rows essential [12, 3] (15), ghost [8, 7] (15), impulse [5, 12] (17); columns yes 25, no 22; N = 47; df = 2.
    // Expected counts (row*col/47): 7.98, 7.02 / 7.98, 7.02 / 9.04, 7.96, all at least 5.
    // chi-square = N * sum(O^2 / (row*col)) - N, with the six terms
    //   144/375 + 9/330 + 64/375 + 49/330 + 25/425 + 144/374
    //   = 0.384000 + 0.027273 + 0.170667 + 0.148485 + 0.058824 + 0.385027 = 1.174276
    //   chi-square = 47 * 1.174276 - 47 = 55.190972 - 47 = 8.190972.
    // That is between the df-2 criticals 5.9915 and 9.2103, so p<0.05. V = sqrt(8.190972 / 47) = sqrt(0.174276) = 0.41747, 4174 bp.
    // Dropping the ghost's spends would leave the 32-spend table of the first test, chi-square 8.1893 at df 1: a different
    // figure at a different df. Merging them into another reason would leave two rows.
    await put([
      { n: 12, reason: E, worthwhile: true }, { n: 3, reason: E, worthwhile: false },
      { n: 5, reason: I, worthwhile: true }, { n: 12, reason: I, worthwhile: false },
      { n: 8, reason: 'reason.ghost', worthwhile: true }, { n: 7, reason: 'reason.ghost', worthwhile: false },
    ])
    const r = asResult(await reasonWorthwhile(1))
    expect(r.n).toBe(47)
    expect(counts(r)).toEqual({ [E]: [12, 3], 'reason.ghost': [8, 7], [I]: [5, 12] })
    expect(r.rows.find((x) => x.key === 'reason.ghost')?.label).toBe('Removed reason')
    expect(r.rows.find((x) => x.key === E)?.label).toBe('Essential')
    expect(r.df).toBe(2)
    expect(Math.abs(r.chiScaled - Math.round(8.190972 * CHI_SCALE))).toBeLessThanOrEqual(3)
    expect(Math.abs(r.vBp - 4174)).toBeLessThanOrEqual(1)
    expect(r.bracket).toBe('p<0.05')
  })

  it('keeps an archived reasons own label, since archiving hides it from pickers and never deletes it', async () => {
    await db.purchaseReasons.update('reason.reward', { archived: true })
    await put([
      { n: 12, reason: E, worthwhile: true }, { n: 3, reason: E, worthwhile: false },
      { n: 5, reason: 'reason.reward', worthwhile: true }, { n: 12, reason: 'reason.reward', worthwhile: false },
    ])
    const r = asResult(await reasonWorthwhile(1))
    expect(r.rows.find((x) => x.key === 'reason.reward')?.label).toBe('Reward')
    expect(counts(r)['reason.reward']).toEqual([5, 12])
  })

  it('withholds below thirty spends with both fields, naming how many more are needed', async () => {
    await put([
      { n: 15, reason: E, worthwhile: true }, { n: 10, reason: I, worthwhile: false },
      { n: 6, reason: I, worthwhile: null }, { n: 6, reason: null, worthwhile: true }, // not both fields: not counted
    ])
    const o = await reasonWorthwhile(1)
    expect(o).toBeInstanceOf(Array)
    const gates = o as { have: number; need: number; what: string }[]
    expect(gates).toHaveLength(1)
    expect(gates[0]).toMatchObject({ have: 25, need: 30 })
    expect(gates[0]!.what).toContain('5 more purchases are needed')
  })

  it('gives a bracket of none, not a finding, when the expected counts are too small to trust', async () => {
    // Six reasons of five spends each; three are all worthwhile and three all not: perfect association, the largest
    // possible chi-square. N = 30, columns 15 and 15, every expected count 5*15/30 = 2.5, below 5 in every cell.
    // chi-square = N * min(rows-1, cols-1) = 30, V = sqrt(30 / (30 * 1)) = 1, 10000 bp. At df 5 the critical is 15.0863,
    // so the bracket WOULD be p<0.01 if nothing checked the expected counts: the approximation does not hold here.
    const reasons = ['reason.essential', 'reason.planned', 'reason.impulse', 'reason.convenience', 'reason.reward', 'reason.other']
    await put(reasons.map((reason, i) => ({ n: 5, reason, worthwhile: i < 3 })))
    const r = asResult(await reasonWorthwhile(1))
    expect(r.df).toBe(5)
    expect(r.chiScaled).toBe(300000)
    expect(r.vBp).toBe(10000)
    expect(r.verdict).toBe('sparse')
    expect(r.bracket).toBe('none')
  })

  it('gives a bracket of none when one cell expects less than one spend, even if few cells are small', async () => {
    // Five reasons of 19 spends skewed alternately, [15 yes, 4 no] / [4, 15] / [15, 4] / [4, 15] / [15, 4], plus a sixth
    // reason with a single spend [1, 0]. N = 96, columns yes 54 and no 42. The single spend expects 1*54/96 = 0.56 and
    // 1*42/96 = 0.44, both below 1, while the other ten cells expect 19*54/96 = 10.7 and 19*42/96 = 8.3. Only 2 of 12 cells
    // (17%) are under 5, within the 20% allowed, so only the below-1 rule withholds the bracket.
    // chi-square = 96 * sum(O^2 / (row*col)) - 96, with row*col = 19*54 = 1026 (yes) and 19*42 = 798 (no) for the big rows:
    //   [15,4] 225/1026 + 16/798 = 0.219298 + 0.020050 = 0.239348 (three of them)
    //   [4,15] 16/1026 + 225/798 = 0.015595 + 0.281955 = 0.297550 (two of them)
    //   [1,0]  1/54 = 0.018519
    //   sum = 0.718044 + 0.595100 + 0.018519 = 1.331663; chi-square = 96 * 1.331663 - 96 = 127.83965 - 96 = 31.83965.
    // At df 5 that is far above the p<0.01 critical 15.0863, so without the rule the bracket would be p<0.01.
    await put([
      { n: 15, reason: 'reason.essential', worthwhile: true }, { n: 4, reason: 'reason.essential', worthwhile: false },
      { n: 4, reason: 'reason.planned', worthwhile: true }, { n: 15, reason: 'reason.planned', worthwhile: false },
      { n: 15, reason: 'reason.impulse', worthwhile: true }, { n: 4, reason: 'reason.impulse', worthwhile: false },
      { n: 4, reason: 'reason.convenience', worthwhile: true }, { n: 15, reason: 'reason.convenience', worthwhile: false },
      { n: 15, reason: 'reason.reward', worthwhile: true }, { n: 4, reason: 'reason.reward', worthwhile: false },
      { n: 1, reason: 'reason.other', worthwhile: true },
    ])
    const r = asResult(await reasonWorthwhile(1))
    expect(r.n).toBe(96)
    expect(r.df).toBe(5)
    expect(Math.abs(r.chiScaled - Math.round(31.83965 * CHI_SCALE))).toBeLessThanOrEqual(10)
    expect(r.verdict).toBe('sparse')
    expect(r.bracket).toBe('none')
  })

  it('reports the period of the spends it counted, by bank date, not the owners corrected date', async () => {
    // Counted: 12 + 3 + 5 + 12 = 32 spends. Bank dates run 2026-03-05 (first group) to 2026-09-20 (last group).
    // One counted spend carries a dateOverride of 2027-01-01 and one of 2025-01-01: if the period read the resolved date it
    // would be 2025-01-01 to 2027-01-01. Uncounted spends (no hindsight answer, no reason, no annotation) sit at 2020 and
    // 2030 and must not widen it either.
    await put([
      { n: 12, reason: E, worthwhile: true, date: '2026-03-05' }, { n: 3, reason: E, worthwhile: false, date: '2026-04-10' },
      { n: 5, reason: I, worthwhile: true, date: '2026-06-01', dateOverride: '2027-01-01' },
      { n: 12, reason: I, worthwhile: false, date: '2026-09-20' },
      { n: 1, reason: I, worthwhile: false, date: '2026-07-01', dateOverride: '2025-01-01' },
      { n: 2, reason: I, worthwhile: null, date: '2020-01-01' }, { n: 2, reason: null, worthwhile: true, date: '2030-01-01' },
      { n: 2, annotate: false, date: '2030-06-01' },
    ])
    const r = asResult(await reasonWorthwhile(1))
    expect(r.n).toBe(33)
    expect(r.period).toEqual({ from: '2026-03-05', to: '2026-09-20' })
  })

  it('reports the period on a boredom result and on a withheld table', async () => {
    await put([
      { n: 15, mood: 'mood.bored', reason: I, date: '2026-02-01' }, { n: 5, mood: 'mood.bored', reason: E, date: '2026-02-02' },
      { n: 5, mood: 'mood.sad', reason: I, date: '2026-05-30' }, { n: 15, mood: 'mood.happy', reason: E, date: '2026-04-15' },
    ])
    expect(asResult(await boredomImpulse(1)).period).toEqual({ from: '2026-02-01', to: '2026-05-30' })

    // Thirty-one spends all judged worthwhile: withheld for the empty column, and still says what span it looked at.
    await db.annotations.clear(); await db.transactions.clear()
    await put([{ n: 16, reason: E, worthwhile: true, date: '2026-08-01' }, { n: 15, reason: I, worthwhile: true, date: '2026-08-09' }])
    expect(asWithheld(await reasonWorthwhile(2)).period).toEqual({ from: '2026-08-01', to: '2026-08-09' })
  })

  it('pins the p<0.001 rung: a strong, certain table', async () => {
    // Essential [20 yes, 5 no], impulse [5, 20]; N = 50, every expected count 12.5; df 1.
    // chi-square = 50 * (20*20 - 5*5)^2 / 25^4 = 50 * 375^2 / 390625 = 50 * 140625 / 390625 = 18.0, above the df-1
    // p<0.001 critical 10.8276. V = sqrt(18 / 50) = sqrt(0.36) = 0.6, exactly 6000 bp.
    await put([
      { n: 20, reason: E, worthwhile: true }, { n: 5, reason: E, worthwhile: false },
      { n: 5, reason: I, worthwhile: true }, { n: 20, reason: I, worthwhile: false },
    ])
    const r = asResult(await reasonWorthwhile(1))
    expect(r.chiScaled).toBe(180000)
    expect(r.vBp).toBe(6000)
    expect(r.bracket).toBe('p<0.001')
    expect(r.verdict).toBe('tested')
  })

  it('still tests at df 20, the widest the critical table carries', async () => {
    // The reason count follows the critical table: with two columns df = reasons - 1, so CHI_TABLE_MAX_DF + 1 reasons sit
    // exactly at the ceiling (21 while the table ends at df 20). The figures below are for that size.
    // Twenty-one reasons, ten worthwhile and ten not each: N = 420, every row 20, columns 210 and 210, every expected
    // count 20*210/420 = 10 and every observed count 10, so chi-square is exactly 0 and V is 0. df = 20 is the last the
    // table answers, so this is tested (a real, unremarkable absence), not refused.
    const ids = Array.from({ length: CHI_TABLE_MAX_DF + 1 }, (_, i) => `reason.gone-${i}`)
    await put(ids.flatMap((reason) => [{ n: 10, reason, worthwhile: true }, { n: 10, reason, worthwhile: false }]))
    const r = asResult(await reasonWorthwhile(1))
    expect(r.df).toBe(CHI_TABLE_MAX_DF)
    expect(r.chiScaled).toBe(0)
    expect(r.verdict).toBe('tested')
    expect(r.bracket).toBe('none')
  })

    // Reasons = CHI_TABLE_MAX_DF + 2, so df = reasons - 1 = CHI_TABLE_MAX_DF + 1: one past the table, wherever it ends. The
    // figures in the next lines are for a table that ends at df 20 (22 reasons, N = 44, df 21).
  it('refuses past the critical table instead of throwing or calling it unremarkable', async () => {
    // Twenty-two distinct reasons (the seed has eight; fourteen are removed ids), two answered spends each: one worthwhile,
    // one not. N = 44, df = 21, one more than the table carries. Every column sum is 22 and every row sum 2, so every
    // expected count is 2*22/44 = 1, and every cell is O = 1 against E = 1: chi-square is exactly 0 and V is 0. The point is
    // the verdict: df 21 has no critical, and the result says so rather than throwing or reading 'none' as a finding.
    const ids = Array.from({ length: CHI_TABLE_MAX_DF + 2 }, (_, i) => `reason.gone-${i}`)
    await put(ids.flatMap((reason) => [{ n: 1, reason, worthwhile: true }, { n: 1, reason, worthwhile: false }]))
    const r = asResult(await reasonWorthwhile(1))
    expect(r.n).toBe(2 * (CHI_TABLE_MAX_DF + 2))
    expect(r.df).toBe(CHI_TABLE_MAX_DF + 1)
    expect(r.chiScaled).toBe(0)
    expect(r.vBp).toBe(0)
    expect(r.verdict).toBe('too-many-categories')
    // The module's own ceiling must match the table's: df 20 answers, df 21 throws.
    expect(chiSquareBracket(0, CHI_TABLE_MAX_DF)).toBe('none')
    expect(() => chiSquareBracket(0, CHI_TABLE_MAX_DF + 1)).toThrow(RangeError)
  })
})

describe('boredomImpulse', () => {
  it('builds the table from mood and reason, over spends that carry both', async () => {
    // Bored [15 impulse, 5 not], any other mood [5, 15]; N = 40; every expected count 10; df = 1.
    // chi-square = 40 * (15*15 - 5*5)^2 / 20^4 = 40 * 40000 / 160000 = 10, above 6.6349 and below 10.8276, so exactly p<0.01.
    // V = sqrt(10 / 40) = 0.5, exactly 5000 bp.
    await put([
      { n: 15, mood: 'mood.bored', reason: I }, { n: 5, mood: 'mood.bored', reason: E },
      { n: 3, mood: 'mood.sad', reason: I }, { n: 2, mood: 'mood.happy', reason: I }, { n: 15, mood: 'mood.happy', reason: E },
      // Not counted: a mood with no reason, a reason with no mood.
      { n: 4, mood: 'mood.bored', reason: null }, { n: 4, mood: null, reason: I },
    ])
    const r = asResult(await boredomImpulse(1))
    expect(r.n).toBe(40)
    expect(counts(r)).toEqual({ 'mood.bored': [15, 5], 'mood.not-bored': [5, 15] })
    expect(r.chiScaled).toBe(100000)
    expect(r.vBp).toBe(5000)
    expect(r.bracket).toBe('p<0.01')
  })

  it('withholds below twenty impulse-tagged spends, naming how many more are needed', async () => {
    await put([{ n: 19, mood: 'mood.bored', reason: I }, { n: 30, mood: 'mood.happy', reason: E }])
    const gates = (await boredomImpulse(1)) as { have: number; need: number; what: string }[]
    expect(gates).toHaveLength(1)
    expect(gates[0]).toMatchObject({ have: 19, need: 20 })
    expect(gates[0]!.what).toContain('1 more purchase is needed')
  })

  it('withholds the result when nobody was bored, since a row of the table is empty', async () => {
    await put([{ n: 20, mood: 'mood.happy', reason: I }, { n: 10, mood: 'mood.sad', reason: E }])
    const w = asWithheld(await boredomImpulse(1))
    expect(w.n).toBe(30)
  })
})
