import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../db/db'
import { seedDatabase } from '../db/seed'
import type { AnnotationRow, TransactionRow } from '../db/schema'
import { addDays } from '../lib/dates'
import { categorySavings, moodFrequency, paydayTrend, salaryLifestyle } from './trend'

let uid = 0
const TODAY = '2027-06-30'
const SHOP: [string, string] = ['Compras', 'Compras (otros)']          // discretionary
const FOOD: [string, string] = ['Alimentación', 'Supermercados y alimentación'] // essential

const tx = async (
  id: string, valueDate: string, amountCents: number, over: Partial<TransactionRow> = {}, ing: [string, string] | null = null,
): Promise<void> => {
  await db.transactions.add({
    id, accountId: 'acc.1', valueDate, amountCents, balanceCents: 0, description: 'Movimiento inventado', comment: null,
    ingCategory: ing?.[0] ?? null, ingSubcategory: ing?.[1] ?? null, kind: amountCents > 0 ? 'income' : 'spend',
    dedupKey: `k.${++uid}`, importId: 'imp.1', fileSeq: uid, roundupParentId: null, createdAt: 1, deletedAt: null, ...over,
  })
}
const ann = (transactionId: string, over: Partial<AnnotationRow>): Promise<unknown> =>
  db.annotations.add({
    transactionId, categoryId: null, subcategoryId: null, merchantId: null, typeOverride: null, paymentMethod: null,
    note: null, moodId: null, purchaseReasonId: null, worthwhile: null, reviewed: false, dateOverride: null,
    amountCentsOverride: null, descriptionOverride: null, updatedAt: 1, ...over,
  })

beforeEach(async () => {
  uid = 0
  await db.delete(); await db.open(); await seedDatabase()
})

describe('paydayTrend', () => {
  // Three paydays, each late in its month so the series is four days: offsets 0, 1, 2, 3 by the bank's dates.
  // Oct 28..31, Nov 27..30, Dec 28..31. Every month spends 40.00, 30.00, 20.00, 10.00 on offsets 0..3, so pooled
  // x = 0,1,2,3 three times over and y = 4000,3000,2000,1000 three times over: the y ranks are the x ranks reversed,
  // tie for tie, so rho = -1 exactly = -10000 bp. n = 12; 10000^2 * 11 = 1.1e9 >= 32906^2 = 1.0827e9, so p<0.001.
  const seedPaydays = async (months: [string, number][]): Promise<void> => {
    for (const [paydayDate, start] of months) {
      await tx(`pay.${paydayDate}`, paydayDate, 200000, { kind: 'income' })
      for (let off = 0; off < 4; off++) {
        const day = `${paydayDate.slice(0, 8)}${String(start + off).padStart(2, '0')}`
        await tx(`sp.${paydayDate}.${off}`, day, -(4000 - off * 1000))
      }
    }
  }

  it('correlates days since payday against that days spending, over the bank dates', async () => {
    await seedPaydays([['2026-10-28', 28], ['2026-11-27', 27], ['2026-12-28', 28]])
    // The owner "corrects" the last day of October to look like payday itself. The bank's date stands, so nothing moves.
    await ann('sp.2026-10-28.3', { dateOverride: '2026-10-28' })
    const r = await paydayTrend('2026-10', '2026-12', TODAY, 1000)
    expect(r).toEqual({ effectBp: -10000, bracket: 'p<0.001', n: 12, period: { from: '2026-10-28', to: '2026-12-31' } })
  })

  it('counts income events, not months with a payday, against the gate of three payments', async () => {
    // Two months, three payments: Oct 28 and Nov 27 are the paydays (the largest of their months), and a second, smaller
    // payment lands on Nov 29. The gate is worded in payments, so it has 3 and is met; counting months it would have 2.
    await seedPaydays([['2026-10-28', 28], ['2026-11-27', 27]])
    await tx('second.pay', '2026-11-29', 5000, { kind: 'income' })
    const r = await paydayTrend('2026-10', '2026-12', TODAY, 1000)
    expect(Array.isArray(r)).toBe(false)
  })

  it('leaves out the days that have not happened in the running month, rather than reading them as zero spending', async () => {
    // Oct 28 and Nov 27 are as above: y = 4000, 3000, 2000, 1000 on offsets 0..3. December's payday is Dec 5 and today is
    // Dec 10, so the days that HAVE happened are offsets 0..4 (Dec 5..9), spending 1000, 2000, 3000, 4000, 5000. Today
    // (Dec 10, offset 5) is unfinished and holds a 90.00 spend that must not count either.
    // Pooled n = 13, x ranks (average): 0 -> 2, 1 -> 5, 2 -> 8, 3 -> 11, 4 -> 13; y has the same tie shape, same ranks.
    // Mean rank 7. Sxx = Syy = 3*25 + 3*4 + 3*1 + 3*16 + 36 = 174.
    // Sxy: Oct and Nov, each (-5*4) + (-2*1) + (1*-2) + (4*-5) = -44, so -88; December (25 + 4 + 1 + 16 + 36) = 82. Sxy = -6.
    // rho = -6 / 174 = -0.03448 = -345 bp; n = 13 is past the floor of ten and nowhere near a critical, so 'none'.
    // With the 22 unlived days (offsets 5..26) read as zero spending, rho would be -0.81 over n = 35 and a finding.
    await seedPaydays([['2026-10-28', 28], ['2026-11-27', 27]])
    await tx('pay.dec', '2026-12-05', 200000, { kind: 'income' })
    for (let off = 0; off < 5; off++) await tx(`sp.dec.${off}`, `2026-12-0${5 + off}`, -(1000 + off * 1000))
    await tx('sp.today', '2026-12-10', -9000)
    const r = await paydayTrend('2026-10', '2026-12', '2026-12-10', 1000)
    // The period is the bank dates actually covered: the first payday to the last finished day.
    expect(r).toEqual({ effectBp: -345, bracket: 'none', n: 13, period: { from: '2026-10-28', to: '2026-12-09' } })
  })

  it('withholds below three payments received, naming what is short', async () => {
    await seedPaydays([['2026-10-28', 28], ['2026-11-27', 27]])
    const r = await paydayTrend('2026-10', '2026-12', TODAY, 1000)
    expect(r).toHaveLength(1)
    expect(r).toMatchObject([{ have: 2, need: 3 }])
    expect(JSON.stringify(r)).toContain('1 more payment is needed')
  })
})

describe('salaryLifestyle', () => {
  const month = async (m: string, income: number, wants: number, needs: number): Promise<void> => {
    await tx(`pay.${m}`, `${m}-02`, income, { kind: 'income' })
    await tx(`want.${m}`, `${m}-10`, -wants, {}, SHOP)
    await tx(`need.${m}`, `${m}-11`, -needs, {}, FOOD)
  }

  it('compares discretionary share across two income levels with at least two months each', async () => {
    // High level (3000.00): shares 3000 bp and 3500 bp.
    await month('2026-01', 300000, 30000, 70000)
    await month('2026-02', 300000, 35000, 65000)
    // A month with spending but no income of its own, all of it on needs (share 0). Its income would be the trailing
    // average of the two before it, 3000.00: an estimate that lands in the high level. It must be no part of any level;
    // admitted, the high months would be 3000, 3500, 0 and r = (4 wins - 2 losses) / 6 = +3333 instead of +10000.
    await tx('need.2026-03', '2026-03-11', -50000, {}, FOOD)
    // Low level (2000.00): shares 20000/100000 = 2000 bp and 25000/100000 = 2500 bp. Every high month is above every
    // low month: wins = 2*2 = 4 of 4 pairs, so r = (4 - 0) / 4 = +1 = +10000 bp, and uDoubled = 2*4 = 8.
    await month('2026-04', 200000, 20000, 80000)
    await month('2026-05', 200000, 25000, 75000)
    const r = await salaryLifestyle('2026-01', '2026-05', TODAY, 1000)
    // Four months a side is under the floor of eight, so the effect is real and the bracket is 'none'.
    expect(r).toEqual({ effectBp: 10000, bracket: 'none', n: 4, period: { from: '2026-01-01', to: '2026-05-31' } })
  })

  it('leaves the running month out entirely, whatever income it already has', async () => {
    await month('2026-01', 200000, 20000, 80000) // 2000 bp
    await month('2026-02', 200000, 25000, 75000) // 2500 bp
    await month('2026-03', 300000, 30000, 70000) // 3000 bp
    await month('2026-04', 300000, 35000, 65000) // 3500 bp
    // May is the running month (today is May 20): income already landed, nothing spent on wants yet, share 0. Admitted,
    // the high level would be 3500, 3000, 0 against 2500, 2000: wins 4, losses 2 of 6, r = +3333 instead of +10000.
    await month('2026-05', 300000, 0, 20000)
    const r = await salaryLifestyle('2026-01', '2026-05', '2026-05-20', 1000)
    expect(r).toEqual({ effectBp: 10000, bracket: 'none', n: 4, period: { from: '2026-01-01', to: '2026-04-30' } })
  })

  it('reads negative when the share spent on wants fell as income rose', async () => {
    await month('2026-01', 200000, 40000, 60000) // 4000 bp
    await month('2026-02', 200000, 45000, 55000) // 4500 bp
    await month('2026-03', 300000, 20000, 80000) // 2000 bp
    await month('2026-04', 300000, 25000, 75000) // 2500 bp
    // The higher-income months come first, and every one of them is below every lower-income month: r = -1.
    const r = await salaryLifestyle('2026-01', '2026-04', TODAY, 1000)
    expect(r).toMatchObject({ effectBp: -10000, n: 4 })
  })

  it('withholds with only one income level of two months, naming what is short', async () => {
    await month('2026-01', 200000, 20000, 80000)
    await month('2026-02', 205000, 25000, 75000) // within 10 % of the first: the same level
    await month('2026-03', 300000, 30000, 70000) // a second level, but a single month
    const r = await salaryLifestyle('2026-01', '2026-03', TODAY, 1000)
    expect(r).toMatchObject([{ have: 1, need: 2 }])
    expect(JSON.stringify(r)).toContain('income levels')
  })
})

describe('moodFrequency', () => {
  // Each week goes to ONE side, by the majority of its mood-tagged purchases; a tie is left out. Weeks start on Mondays.
  // Weeks 0..7 are LOW-majority: 3,4,3,5,4,3,4,5 low purchases plus one good one each, so weekly totals 4,5,4,6,5,4,5,6
  // = 39 purchases. Weeks 8..27 are GOOD-majority: two good purchases each, totals all 2 = 40 purchases.
  // Raw totals say the good weeks bought as much or more (40 against 39); per week every low week (>= 4) beats every
  // good week (2), so a = low, b = good: wins = 8*20 = 160 of 160 pairs, r = +1 = +10000, uDoubled = 320.
  // n1 = 8, n2 = 20, V = 8*20*29 = 4640, D = 320 - 160 = 160, C = 159:
  // 3e8 * 159^2 = 7.584e12 >= 32906^2 * 4640 = 5.024e12, so p<0.001.
  // Weeks 28..32 are TIED: four low and four good purchases, total 8. Left out of both sides. Had they gone to the good
  // side its values would be twenty 2s and five 8s: wins = 160 of 200 pairs, losses 40, r = +6000; D = 320 - 200 = 120,
  // C = 119, 3e8 * 119^2 = 4.248e12 against V = 8*25*34 = 6800: 25759^2 * 6800 = 4.512e12 is above it and
  // 19600^2 * 6800 = 2.612e12 below, so only p<0.05 - a different bracket and a different effect.
  const LOW = [3, 4, 3, 5, 4, 3, 4, 5]
  const monday = (w: number): string => addDays('2026-01-05', 7 * w)
  const seedWeeks = async (): Promise<void> => {
    for (let w = 0; w < LOW.length; w++) {
      const count = LOW[w] ?? 0
      for (let k = 0; k < count; k++) {
        // Week 0's third purchase is on the SUNDAY (offset 6): it belongs to the week that began the Monday before.
        const off = w === 0 && k === 2 ? 6 : w === 0 && k === 0 ? 1 : k // week 0 has no Monday purchase: its period starts Tuesday
        const id = `l.${w}.${k}`
        await tx(id, addDays(monday(w), off), -1500)
        await ann(id, { moodId: k % 2 === 0 ? 'mood.stressed' : 'mood.sad' })
      }
      await tx(`lg.${w}`, addDays(monday(w), 5), -1500); await ann(`lg.${w}`, { moodId: 'mood.happy' })
    }
    for (let w = 8; w < 28; w++) {
      for (const off of [0, 2]) {
        const id = `g.${w}.${off}`
        await tx(id, addDays(monday(w), off), -1500)
        await ann(id, { moodId: 'mood.happy' })
      }
    }
    for (let w = 28; w < 33; w++) {
      for (let k = 0; k < 4; k++) {
        await tx(`tl.${w}.${k}`, addDays(monday(w), k), -1500); await ann(`tl.${w}.${k}`, { moodId: 'mood.sad' })
        await tx(`tg.${w}.${k}`, addDays(monday(w), k), -1500); await ann(`tg.${w}.${k}`, { moodId: 'mood.happy' })
      }
    }
  }

  it('compares purchase frequency between mood days as a rate over the weeks observed', async () => {
    await seedWeeks()
    // The owner re-dates one purchase to December. The bank's week stands, so week 1 still counts it.
    await db.annotations.update('l.1.0', { dateOverride: '2026-12-01' })
    // Neutral and "Other" moods have no side to be on: they must add neither weeks nor purchases.
    await tx('n.1', '2026-10-05', -1500); await ann('n.1', { moodId: 'mood.neutral' })
    await tx('o.1', '2026-10-12', -1500); await ann('o.1', { moodId: 'mood.other' })
    const r = await moodFrequency(1000)
    expect(r).toEqual({
      effectBp: 10000, bracket: 'p<0.001', n: 28, period: { from: '2026-01-06', to: '2026-07-15' },
      lowMood: { weeks: 8, purchases: 39 }, goodMood: { weeks: 20, purchases: 40 }, tiedWeeks: 5,
    })
  })

  it('withholds below eight weeks with a mood recorded, naming what is short', async () => {
    await tx('a', '2026-01-05', -1500); await ann('a', { moodId: 'mood.happy' })
    const r = await moodFrequency(1000)
    expect(r).toMatchObject([{ have: 1, need: 8 }])
    expect(JSON.stringify(r)).toContain('7 more weeks are needed')
  })
})

describe('categorySavings', () => {
  // Five months with data, each with one discretionary spend and one round-up saving (a roundup outflow is savings).
  // Spend ranks 1..5 (100.00 .. 500.00), saved 300, 500, 100, 400, 200 => saved ranks 3, 5, 1, 4, 2.
  // d = x - y = -2, -3, 2, 0, 3; sum d^2 = 4 + 9 + 4 + 0 + 9 = 26; no ties, so rho = 1 - 6*26 / (5*24) = -0.3 = -3000 bp.
  const SPENT = [10000, 20000, 30000, 40000, 50000]
  const SAVED = [30000, 50000, 10000, 40000, 20000]
  const seedFive = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) {
      const m = `2026-0${i + 2}`
      await tx(`shop.${m}`, `${m}-10`, -(SPENT[i] ?? 0), {}, SHOP)
      await tx(`save.${m}`, `${m}-12`, -(SAVED[i] ?? 0), { kind: 'roundup' })
    }
  }

  it('correlates category spending against savings across at least four months', async () => {
    await seedFive()
    const r = await categorySavings('2026-02', '2026-06', TODAY, 1000)
    // Five months: past the gate of four, under the bracket floor of ten. A real effect, bracket 'none', not an error.
    expect(r).toMatchObject({ months: 5, period: { from: '2026-02-01', to: '2026-06-30' } })
    expect((r as { categories: unknown[] }).categories).toEqual([
      { categoryId: 'cat.shopping', label: expect.any(String), effectBp: -3000, bracket: 'none' },
    ])
  })

  it('leaves a month with no records out of every correlation rather than treating it as zero', async () => {
    await seedFive()
    // January has NO records. Read as (spent 0, saved 0) it would be the lowest on both axes: the six pairs would have
    // x ranks 1..6 and y ranks 1,4,6,2,5,3 with the same d^2 sum of 26, so rho = 1 - 6*26 / (6*35) = +0.2571 = +2571 bp.
    // Left out, as it must be, it is the -3000 above: the gap month would flip the sign.
    const r = await categorySavings('2026-01', '2026-06', TODAY, 1000)
    expect(r).toMatchObject({ months: 5, period: { from: '2026-02-01', to: '2026-06-30' } })
    expect((r as { categories: { effectBp: number }[] }).categories[0]?.effectBp).toBe(-3000)
  })

  it('does not count the running month toward the four months, or into the correlation', async () => {
    await seedFive() // Feb..Jun 2026
    // Today is June 15: June is the running month. The four whole months give x ranks 1..4, y ranks 2, 4, 1, 3:
    // d = -1, -2, 2, 1, sum d^2 = 10, rho = 1 - 6*10 / (4*15) = 0. With June (the -3000 above) it would be five months.
    const four = await categorySavings('2026-02', '2026-06', '2026-06-15', 1000)
    expect(four).toMatchObject({ months: 4, period: { from: '2026-02-01', to: '2026-05-31' } })
    expect((four as { categories: { effectBp: number }[] }).categories[0]?.effectBp).toBe(0)
    // Today is May 15: Feb, Mar, Apr are whole; May and June do not count, so three months is short of four.
    const three = await categorySavings('2026-02', '2026-06', '2026-05-15', 1000)
    expect(three).toMatchObject([{ have: 3, need: 4 }])
  })

  it('withholds below four months, naming what is short', async () => {
    for (let i = 0; i < 3; i++) await tx(`s${i}`, `2026-0${i + 1}-10`, -1000, {}, SHOP)
    const r = await categorySavings('2026-01', '2026-03', TODAY, 1000)
    expect(r).toMatchObject([{ have: 3, need: 4 }])
    expect(JSON.stringify(r)).toContain('1 more month is needed')
  })
})

describe('every relationship, with nothing recorded', () => {
  it('withholds each one below its own minimum, naming what is short', async () => {
    const results = [
      [await paydayTrend('2026-01', '2026-03', TODAY, 1), 3, 'payments received'],
      [await salaryLifestyle('2026-01', '2026-03', TODAY, 1), 2, 'income levels'],
      [await moodFrequency(1), 8, 'weeks with a mood recorded'],
      [await categorySavings('2026-01', '2026-03', TODAY, 1), 4, 'months of spending'],
    ] as const
    for (const [r, need, what] of results) {
      expect(Array.isArray(r)).toBe(true)
      expect(r).toMatchObject([{ have: 0, need }])
      expect(JSON.stringify(r)).toContain(what)
    }
  })
})
