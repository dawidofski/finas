import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db/db'
import { seedDatabase } from '../db/seed'
import type { AnnotationRow, TransactionRow } from '../db/schema'
import { addDays } from '../lib/dates'
import { BATTERY } from './battery'
import { moodAmount, stressDiscretionary, weekend, type RankFinding } from './rank'

// 2026-01-03 is a Saturday (2026-11-21 is, and 46 weeks = 322 days earlier); 2026-01-05 is a Monday.
const tx = (id: string, over: Partial<TransactionRow> = {}): TransactionRow => ({
  id, accountId: 'acc', valueDate: '2026-01-05', amountCents: -1000,
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
const finding = (r: unknown): RankFinding => {
  if (Array.isArray(r)) throw new Error(`expected a finding, got gates ${JSON.stringify(r)}`)
  return r as RankFinding
}
const gateText = (id: string, i: number, data: object): string =>
  BATTERY.find(r => r.id === id)!.gates({
    discretionarySpendsWithMood: 0, moodGroupsOfTen: 0, weeksOfMoodCoverage: 0, stressedSpends: 0, unstressedSpends: 0,
    impulseTaggedSpends: 0, spendsWithReasonAndWorthwhile: 0, weekendsObserved: 0, incomeEvents: 0, fullMonths: 0,
    incomeLevelsWithTwoMonths: 0, monthsObserved: 0, ...data,
  })[i]!.what
const addWeeks = (iso: string, w: number): string => addDays(iso, 7 * w)

let cat: string
beforeEach(async () => {
  await db.delete(); await db.open(); await seedDatabase()
  cat = (await db.categories.toArray()).find(c => c.kind === 'discretionary')!.id
})

/** 30 discretionary spends: 10 Sad (-1), 10 Neutral (0), 10 Happy (+2), amounts 1.00 .. 30.00 rising with mood. */
async function seedMoodSpends(opts: { happyOverrideCents?: number; extraOther?: number } = {}): Promise<void> {
  const moods = ['mood.sad', 'mood.neutral', 'mood.happy']
  const txs: TransactionRow[] = []
  const anns: AnnotationRow[] = []
  for (let k = 1; k <= 30; k++) {
    const mood = moods[Math.floor((k - 1) / 10)]!
    txs.push(tx(`m${k}`, { amountCents: -100 * k, valueDate: '2026-02-02' }))
    anns.push(ann(`m${k}`, {
      moodId: mood, categoryId: cat,
      amountCentsOverride: mood === 'mood.happy' && opts.happyOverrideCents !== undefined ? opts.happyOverrideCents : null,
    }))
  }
  for (let k = 1; k <= (opts.extraOther ?? 0); k++) {
    // Amounts that would wreck the ranking if the Other mood were read as valence 0.
    txs.push(tx(`o${k}`, { amountCents: -100 * 500 * k }))
    anns.push(ann(`o${k}`, { moodId: 'mood.other', categoryId: cat }))
  }
  await db.transactions.bulkAdd(txs)
  await db.annotations.bulkAdd(anns)
}

describe('moodAmount', () => {
  it('correlates mood valence against the bank amount, not an amount the owner corrected', async () => {
    // The owner "corrected" every Happy purchase to 0.01. Reading the resolved amount would collapse the correlation.
    await seedMoodSpends({ happyOverrideCents: -1 })
    const r = finding(await moodAmount(1))
    // Spearman on ranks. x = valence ranks: Sad avg 5.5, Neutral 15.5, Happy 25.5 (10 each); y = amount ranks 1..30.
    // mean 15.5. Sxx = 10*(10^2 + 0 + 10^2) = 2000. Syy = 30*(30^2-1)/12 = 2247.5.
    // Sxy = (-10)*(sum(1..10)-155) + 10*(sum(21..30)-155) = (-10)(-100) + 10(100) = 2000.
    // rho = 2000 / sqrt(2000 * 2247.5) = 2000 / 2120.14 = 0.94333 -> 9433 bp.
    expect(Math.abs(r.effectBp - 9433)).toBeLessThanOrEqual(1)
    expect(r.n).toBe(30)
    // n = 30, rho .943: far beyond the 1 % critical value, so it is a finding. Which finer bracket is critical.ts's business.
    expect(r.bracket).not.toBe('none')
  })

  it('treats a mood with no valence as unusable rather than as zero', async () => {
    // Five "Other" purchases (valence null) with huge amounts. As valence 0 they would join the Neutral group:
    // n would be 35 and rho would move. As unusable they change nothing.
    await seedMoodSpends({ extraOther: 5 })
    const r = finding(await moodAmount(1))
    expect(r.n).toBe(30)
    expect(Math.abs(r.effectBp - 9433)).toBeLessThanOrEqual(1)
  })

  it('does not count null-valence purchases towards its minimum', async () => {
    // 29 usable + 5 Other: counting the Others as usable would reach 30 and pass the gate.
    await seedMoodSpends({ extraOther: 5 })
    await db.annotations.update('m30', { moodId: 'mood.other' })
    const r = await moodAmount(1)
    expect(Array.isArray(r)).toBe(true)
    expect(r).toEqual([expect.objectContaining({ have: 29, need: 30 })])
  })

  it('leaves purchases outside a discretionary category out of the correlation', async () => {
    // Five uncategorised Neutral purchases with enormous amounts: if they were counted n would be 35 and rho would move.
    await seedMoodSpends()
    const txs: TransactionRow[] = []; const anns: AnnotationRow[] = []
    for (let k = 1; k <= 5; k++) { txs.push(tx(`u${k}`, { amountCents: -100 * 900 * k })); anns.push(ann(`u${k}`, { moodId: 'mood.neutral' })) }
    await db.transactions.bulkAdd(txs); await db.annotations.bulkAdd(anns)
    const r = finding(await moodAmount(1))
    expect(r.n).toBe(30)
    expect(Math.abs(r.effectBp - 9433)).toBeLessThanOrEqual(1)
  })

  it('withholds each relationship below its own minimum, naming what is short', async () => {
    const txs: TransactionRow[] = []; const anns: AnnotationRow[] = []
    for (let i = 0; i < 5; i++) { txs.push(tx(`a${i}`)); anns.push(ann(`a${i}`, { moodId: 'mood.happy', categoryId: cat })) }
    await db.transactions.bulkAdd(txs); await db.annotations.bulkAdd(anns)
    const r = await moodAmount(1)
    expect(r).toEqual([
      { have: 5, need: 30, what: gateText('mood-amount', 0, { discretionarySpendsWithMood: 5 }) },
      { have: 0, need: 2, what: gateText('mood-amount', 1, { moodGroupsOfTen: 0 }) },
    ])
  })
})

describe('stressDiscretionary', () => {
  it('compares stressed against non-stressed spends and reports the effect size', async () => {
    // Stressed amounts 10..19 (x100 cents), calm 5..14. a = stressed, b = calm.
    // Pairs 100. a>b iff j < 5+i: i=0..4 give 5,6,7,8,9 = 35; i=5..9 give 10 each = 50 -> wins 85.
    // ties: j = 5+i for i=0..4 -> 5. losses = 100-85-5 = 10. r = (85-10)/100 = +0.75 -> 7500 bp (stressed spent more).
    // Normal approximation: U = 85 + 5/2 = 87.5, mean 50, sd sqrt(10*10*21/12) = 13.23,
    // z = (37.5 - 0.5)/13.23 = 2.80 > 2.576, so p < 0.01.
    const txs: TransactionRow[] = []; const anns: AnnotationRow[] = []
    for (let i = 0; i < 10; i++) {
      txs.push(tx(`s${i}`, { amountCents: -(1000 + 100 * i) })); anns.push(ann(`s${i}`, { moodId: 'mood.stressed' }))
      txs.push(tx(`c${i}`, { amountCents: -(500 + 100 * i) })); anns.push(ann(`c${i}`, { moodId: 'mood.happy' }))
    }
    await db.transactions.bulkAdd(txs); await db.annotations.bulkAdd(anns)
    const r = finding(await stressDiscretionary(1))
    expect(r.effectBp).toBe(7500)
    expect(r.bracket).toBe('p<0.01')
    expect(r.n).toBe(20)
  })

  it('withholds when either side is short, naming what is short', async () => {
    const txs: TransactionRow[] = []; const anns: AnnotationRow[] = []
    for (let i = 0; i < 10; i++) { txs.push(tx(`s${i}`)); anns.push(ann(`s${i}`, { moodId: 'mood.stressed' })) }
    for (let i = 0; i < 9; i++) { txs.push(tx(`c${i}`)); anns.push(ann(`c${i}`, { moodId: 'mood.happy' })) }
    await db.transactions.bulkAdd(txs); await db.annotations.bulkAdd(anns)
    const r = await stressDiscretionary(1)
    expect(r).toEqual([{ have: 9, need: 10, what: gateText('stress-discretionary', 1, { stressedSpends: 10, unstressedSpends: 9 }) }])
  })

  it('reports the period it covered, from the bank dates', async () => {
    // Bank dates run 2026-01-03 .. 2026-02-21; the owner's typed dates (2020 and 2030) must not widen it.
    const txs: TransactionRow[] = []; const anns: AnnotationRow[] = []
    for (let i = 0; i < 10; i++) {
      const date = i === 0 ? '2026-01-03' : i === 9 ? '2026-02-21' : '2026-01-20'
      txs.push(tx(`s${i}`, { valueDate: date }))
      anns.push(ann(`s${i}`, { moodId: 'mood.stressed', dateOverride: i === 0 ? '2020-01-01' : '2030-12-31' }))
      txs.push(tx(`c${i}`, { valueDate: '2026-01-25' })); anns.push(ann(`c${i}`, { moodId: 'mood.happy' }))
    }
    await db.transactions.bulkAdd(txs); await db.annotations.bulkAdd(anns)
    const r = finding(await stressDiscretionary(1))
    expect(r.period).toEqual({ from: '2026-01-03', to: '2026-02-21' })
  })
})

describe('weekend', () => {
  /** Eight Saturdays of large spends (50.00+) and Mondays of small ones (10.00+). */
  async function seedWeekends(swapDates: boolean, weekdaySpends = 8): Promise<void> {
    const txs: TransactionRow[] = []; const anns: AnnotationRow[] = []
    for (let i = 0; i < 8; i++) {
      const sat = addWeeks('2026-01-03', i); const mon = addWeeks('2026-01-05', i)
      txs.push(tx(`w${i}`, { valueDate: sat, amountCents: -(5000 + 100 * i) }))
      anns.push(ann(`w${i}`, { dateOverride: swapDates ? mon : null }))
      if (i < weekdaySpends) {
        txs.push(tx(`d${i}`, { valueDate: mon, amountCents: -(1000 + 100 * i) }))
        anns.push(ann(`d${i}`, { dateOverride: swapDates ? sat : null }))
      }
    }
    await db.transactions.bulkAdd(txs); await db.annotations.bulkAdd(anns)
  }

  it('uses the bank date to decide a weekend, whatever date the owner typed', async () => {
    // Bank: the large spends are on Saturdays. The owner "moved" each onto a Monday and each small one onto a Saturday.
    // Resolved dates would put the small spends on the weekend and report r = -10000.
    // Every weekend value exceeds every weekday value: wins 64, losses 0, r = +10000; uDoubled 128 = 2 * pairs.
    // Normal approximation: mean 32, sd sqrt(8*8*17/12) = 9.52, z = (32 - 0.5)/9.52 = 3.31 > 2.576, so p < 0.01.
    await seedWeekends(true)
    const r = finding(await weekend(1))
    expect(r.effectBp).toBe(10000) // positive: weekend purchases were the larger
    expect(r.bracket).not.toBe('none') // z = 3.31, past the 1 % critical value
    expect(r.n).toBe(16)
  })

  it('puts Saturday and Sunday on the weekend side and Friday on the weekday side', async () => {
    // 8 Saturdays (50.00+) and 8 Sundays (60.00+) against 8 Fridays (5.00+) and 8 Mondays (10.00+).
    // Every weekend value exceeds every weekday value: r = +10000 only if Friday is a weekday and Sunday a weekend day.
    // 2026-01-02 is a Friday, 2026-01-04 a Sunday.
    const txs: TransactionRow[] = []; const anns: AnnotationRow[] = []
    for (let i = 0; i < 8; i++) {
      const rows: Array<[string, string, number]> = [
        [`sa${i}`, addWeeks('2026-01-03', i), 5000 + 100 * i], [`su${i}`, addWeeks('2026-01-04', i), 6000 + 100 * i],
        [`fr${i}`, addWeeks('2026-01-02', i), 500 + 100 * i], [`mo${i}`, addWeeks('2026-01-05', i), 1000 + 100 * i],
      ]
      for (const [id, valueDate, cents] of rows) { txs.push(tx(id, { valueDate, amountCents: -cents })); anns.push(ann(id)) }
    }
    await db.transactions.bulkAdd(txs); await db.annotations.bulkAdd(anns)
    const r = finding(await weekend(1))
    expect(r.effectBp).toBe(10000)
    expect(r.n).toBe(32)
  })

  it('counts a Sunday-only weekend as a weekend', async () => {
    // Eight Sundays (50.00+) against eight Mondays (10.00+): all weekend values larger, r = +10000. If Sunday were not a
    // weekend there would be no weekend group at all and nothing to report.
    const txs: TransactionRow[] = []; const anns: AnnotationRow[] = []
    for (let i = 0; i < 8; i++) {
      txs.push(tx(`su${i}`, { valueDate: addWeeks('2026-01-04', i), amountCents: -(5000 + 100 * i) })); anns.push(ann(`su${i}`))
      txs.push(tx(`mo${i}`, { valueDate: addWeeks('2026-01-05', i), amountCents: -(1000 + 100 * i) })); anns.push(ann(`mo${i}`))
    }
    await db.transactions.bulkAdd(txs); await db.annotations.bulkAdd(anns)
    expect(finding(await weekend(1)).effectBp).toBe(10000)
  })

  it('returns a real effect with no bracket when the groups are below the statistical floor', async () => {
    // Eight weekends meet the gate, but only 3 weekday spends: below the 8-per-group floor. All 8 weekend values
    // exceed all 3 weekday values, so r = +10000, and the bracket is 'none': an effect not yet certain, not an error.
    await seedWeekends(false, 3)
    const r = finding(await weekend(1))
    expect(r.effectBp).toBe(10000)
    expect(r.bracket).toBe('none')
  })

  it('withholds below its minimum of weekends, naming what is short', async () => {
    // Seven Saturdays, their Sundays and some Mondays: 7 weekends observed, 8 needed. A Sunday adds no weekend.
    const txs: TransactionRow[] = []; const anns: AnnotationRow[] = []
    for (let i = 0; i < 7; i++) {
      txs.push(tx(`w${i}`, { valueDate: addWeeks('2026-01-03', i) })); anns.push(ann(`w${i}`))
      txs.push(tx(`u${i}`, { valueDate: addWeeks('2026-01-04', i) })); anns.push(ann(`u${i}`))
      txs.push(tx(`d${i}`, { valueDate: addWeeks('2026-01-05', i) })); anns.push(ann(`d${i}`))
    }
    await db.transactions.bulkAdd(txs); await db.annotations.bulkAdd(anns)
    expect(await weekend(1)).toEqual([{ have: 7, need: 8, what: gateText('weekend', 0, { weekendsObserved: 7 }) }])
  })
})
