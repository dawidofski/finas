import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dayMood, moodQueue, setWorthwhileDelayDays, worthwhileDelayDays, worthwhileQueue } from './queues'
import { db } from '../db/db'
import { seedDatabase } from '../db/seed'
import { writeAnnotation } from '../db/annotations'
import type { TransactionKind, TransactionRow } from '../db/schema'
import { setDayMood } from '../mood/day'

const GROCERIES: [string, string] = ['Alimentación', 'Supermercados y alimentación'] // essential
const RESTAURANTS: [string, string] = ['Ocio y viajes', 'Cafeterías y restaurantes'] // discretionary
const TRANSFER: [string, string] = ['Movimientos excluidos', 'Traspaso entre cuentas']

let seq = 0
const tx = async (id: string, valueDate: string, o: { ing?: [string, string] | null; kind?: TransactionKind; deletedAt?: number | null } = {}) => {
  const ing = o.ing === undefined ? RESTAURANTS : o.ing
  const row: TransactionRow = {
    id, accountId: 'acc.1', valueDate, amountCents: -1000, balanceCents: 0, description: `Movimiento ${id}`, comment: null,
    ingCategory: ing?.[0] ?? null, ingSubcategory: ing?.[1] ?? null, kind: o.kind ?? 'spend',
    dedupKey: `k.${id}`, importId: 'imp.1', fileSeq: ++seq, roundupParentId: null, createdAt: 1, deletedAt: o.deletedAt ?? null,
  }
  await db.transactions.add(row)
}
const ids = async () => (await moodQueue()).map((t) => t.id)

beforeEach(async () => {
  seq = 0
  await db.delete(); await db.open(); await seedDatabase()
})

describe('moodQueue', () => {
  it('queues only transactions that warrant a mood', async () => {
    await tx('ok', '2026-11-01')
    await tx('groceries', '2026-11-01', { ing: GROCERIES })
    await tx('transfer', '2026-11-01', { ing: TRANSFER, kind: 'internal' })
    await tx('internal-kind-only', '2026-11-01', { kind: 'internal' })
    await tx('roundup', '2026-11-01', { kind: 'roundup' })
    await tx('uncategorised', '2026-11-02', { ing: null })
    expect(await ids()).toEqual(['ok', 'uncategorised'])
  })

  it('judges essential by the owner category, not the bank one', async () => {
    await tx('bank-says-essential', '2026-11-01', { ing: GROCERIES })
    await tx('bank-says-fun', '2026-11-02')
    await writeAnnotation('bank-says-essential', { categoryId: 'cat.restaurants' }, 'owner')
    await writeAnnotation('bank-says-fun', { categoryId: 'cat.groceries' }, 'owner')
    expect(await ids()).toEqual(['bank-says-essential'])
  })

  it('classifies by the category alone: the vestigial subcategoryId is not a second opinion (§39.5)', async () => {
    await tx('fun', '2026-11-01') // restaurants, discretionary
    await writeAnnotation('fun', { subcategoryId: 'cat.groceries' }, 'owner') // an essential leaf nothing writes today
    expect(await ids()).toEqual(['fun'])
  })

  it('does not ask about income', async () => {
    await tx('pay', '2026-11-01', { ing: null, kind: 'income' })
    await tx('spend', '2026-11-02')
    expect(await ids()).toEqual(['spend'])
    expect(await dayMood('2026-11-01', 'mood.happy')).toBe(0)
  })

  it('honours an owner type override to internal', async () => {
    await tx('a', '2026-11-01')
    await tx('b', '2026-11-02')
    await writeAnnotation('b', { typeOverride: 'internal' }, 'owner')
    expect(await ids()).toEqual(['a'])
  })

  it('excludes transactions that already have a mood', async () => {
    await tx('answered', '2026-11-01')
    await tx('open', '2026-11-02')
    await writeAnnotation('answered', { moodId: 'mood.happy' }, 'owner')
    expect(await ids()).toEqual(['open'])
  })

  it('excludes soft-deleted transactions, whatever annotation they carry', async () => {
    await tx('live', '2026-11-01')
    await tx('gone', '2026-11-01', { deletedAt: 5 })
    await tx('gone-annotated', '2026-11-01', { deletedAt: 5 })
    await writeAnnotation('gone-annotated', { note: 'x' }, 'owner')
    expect(await ids()).toEqual(['live'])
  })

  it('does not touch a deleted row, and its mood counts for nothing', async () => {
    await tx('gone', '2026-11-01', { deletedAt: 5 })
    await tx('live', '2026-11-01')
    await writeAnnotation('gone', { moodId: 'mood.sad' }, 'owner')
    expect(await ids()).toEqual(['live'])
    expect(await dayMood('2026-11-01', 'mood.happy')).toBe(1)
    expect((await db.annotations.get('gone'))?.moodId).toBe('mood.sad')
  })

  it('respects the setting that turns prompting off', async () => {
    await tx('a', '2026-11-01')
    expect(await ids()).toEqual(['a'])
    await db.settings.update('singleton', { moodPrompting: { enabled: false } })
    expect(await ids()).toEqual([])
    await db.settings.update('singleton', { moodPrompting: { enabled: true } })
    expect(await ids()).toEqual(['a'])
  })

  it('is oldest first by resolved date, then statement order', async () => {
    await tx('late', '2026-11-09')
    await tx('mid-b', '2026-11-05')
    await tx('mid-a', '2026-11-05')
    await tx('early', '2026-11-02')
    await tx('moved', '2026-11-20')
    await writeAnnotation('moved', { dateOverride: '2026-11-01' }, 'owner')
    expect(await ids()).toEqual(['moved', 'early', 'mid-b', 'mid-a', 'late'])
  })

  it('writes nothing by being read, so a skipped transaction stays unanswered', async () => {
    await tx('a', '2026-11-01')
    await moodQueue()
    expect(await db.annotations.count()).toBe(0)
  })
})

describe('dayMood', () => {
  it('applies a day-level mood only to the unannotated transactions of that day', async () => {
    await tx('blank-1', '2026-11-03')
    await tx('blank-2', '2026-11-03')
    await tx('chosen', '2026-11-03')
    await tx('other-day', '2026-11-04')
    await tx('essential', '2026-11-03', { ing: GROCERIES })
    await writeAnnotation('chosen', { moodId: 'mood.guilty' }, 'owner')

    expect(await dayMood('2026-11-03', 'mood.relaxed')).toBe(2)

    const mood = async (id: string) => (await db.annotations.get(id))?.moodId ?? null
    expect(await mood('blank-1')).toBe('mood.relaxed')
    expect(await mood('blank-2')).toBe('mood.relaxed')
    expect(await mood('chosen')).toBe('mood.guilty')
    expect(await mood('other-day')).toBeNull()
    expect(await mood('essential')).toBeNull()
    expect(await ids()).toEqual(['other-day'])
  })

  it('uses the resolved date of a moved transaction', async () => {
    await tx('moved', '2026-11-10')
    await writeAnnotation('moved', { dateOverride: '2026-11-03' }, 'owner')
    expect(await dayMood('2026-11-10', 'mood.sad')).toBe(0)
    expect(await dayMood('2026-11-03', 'mood.sad')).toBe(1)
  })

  it('keeps the rest of the annotation when it sets the mood', async () => {
    await tx('a', '2026-11-03')
    await writeAnnotation('a', { note: 'with a friend', worthwhile: true }, 'owner')
    await dayMood('2026-11-03', 'mood.happy')
    expect(await db.annotations.get('a')).toMatchObject({ note: 'with a friend', worthwhile: true, moodId: 'mood.happy' })
  })

  it('refuses a mood that does not exist', async () => {
    await tx('a', '2026-11-03')
    await expect(dayMood('2026-11-03', 'mood.nope')).rejects.toThrow(/Unknown mood/)
    expect(await db.annotations.count()).toBe(0)
  })
})

describe('dayMood atomicity', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('changes no row at all when a write fails partway through the day', async () => {
    await tx('a', '2026-11-03')
    await tx('b', '2026-11-03')
    await tx('c', '2026-11-03')
    const realPut = db.annotations.put.bind(db.annotations)
    let calls = 0
    vi.spyOn(db.annotations, 'put').mockImplementation(((...args: Parameters<typeof realPut>) => {
      calls++
      return calls === 2 ? Promise.reject(new Error('disk full')) : realPut(...args)
    }) as typeof db.annotations.put)

    await expect(dayMood('2026-11-03', 'mood.happy')).rejects.toThrow()
    expect(calls).toBeGreaterThanOrEqual(2) // the first write really happened inside the transaction
    vi.restoreAllMocks()
    expect(await db.annotations.count()).toBe(0)
    expect(await ids()).toEqual(['a', 'b', 'c'])
  })
})

const TODAY = '2026-11-16' // seven days old is 2026-11-09
const wids = async (olderThanDays?: number) => (await worthwhileQueue({ olderThanDays, today: TODAY })).map((t) => t.id)

describe('worthwhileQueue', () => {
  it('queues discretionary spending at least seven days old with a mood or a reason and no judgement', async () => {
    await tx('mood', '2026-11-01')
    await tx('reason', '2026-11-02')
    await tx('both', '2026-11-03')
    await tx('exactly-seven', '2026-11-09')
    await writeAnnotation('mood', { moodId: 'mood.happy' }, 'owner')
    await writeAnnotation('reason', { purchaseReasonId: 'reason.planned' }, 'owner')
    await writeAnnotation('both', { moodId: 'mood.sad', purchaseReasonId: 'reason.planned' }, 'owner')
    await writeAnnotation('exactly-seven', { moodId: 'mood.happy' }, 'owner')
    expect(await wids()).toEqual(['mood', 'reason', 'both', 'exactly-seven'])
  })

  it('queues a purchase on a day with a day mood even with no annotation, but not one with neither mood nor reason', async () => {
    await tx('felt', '2026-11-01')
    await tx('other-day', '2026-11-02')
    await tx('felt-but-young', '2026-11-14')
    await setDayMood('2026-11-01', 'mood.happy')
    await setDayMood('2026-11-14', 'mood.happy')
    expect(await wids()).toEqual(['felt'])
  })

  it('looks the day mood up on the bank date, not an owner-corrected one', async () => {
    await tx('moved', '2026-11-01')
    await writeAnnotation('moved', { dateOverride: '2026-11-03' }, 'owner')
    await setDayMood('2026-11-03', 'mood.happy')
    expect(await wids()).toEqual([])
    await setDayMood('2026-11-01', 'mood.happy')
    expect(await wids()).toEqual(['moved'])
  })

  it('excludes spending younger than the threshold', async () => {
    await tx('six-days', '2026-11-10')
    await tx('today', TODAY)
    await tx('old', '2026-11-01')
    for (const id of ['six-days', 'today', 'old']) await writeAnnotation(id, { moodId: 'mood.happy' }, 'owner')
    expect(await wids()).toEqual(['old'])
  })

  it('uses the resolved date, so a moved transaction is judged by where the owner put it', async () => {
    await tx('moved', '2026-11-01')
    await writeAnnotation('moved', { moodId: 'mood.happy', dateOverride: '2026-11-14' }, 'owner')
    expect(await wids()).toEqual([])
  })

  it('excludes a transaction with neither a mood nor a reason: that is triage, not hindsight', async () => {
    await tx('bare', '2026-11-01')
    await tx('note-only', '2026-11-01')
    await writeAnnotation('note-only', { note: 'x' }, 'owner')
    expect(await wids()).toEqual([])
  })

  it('excludes a transaction already judged, either way', async () => {
    await tx('yes', '2026-11-01')
    await tx('no', '2026-11-01')
    await tx('open', '2026-11-01')
    await writeAnnotation('yes', { moodId: 'mood.happy', worthwhile: true }, 'owner')
    await writeAnnotation('no', { moodId: 'mood.happy', worthwhile: false }, 'owner')
    await writeAnnotation('open', { moodId: 'mood.happy' }, 'owner')
    expect(await wids()).toEqual(['open'])
  })

  it('returns a transaction whose judgement was cleared', async () => {
    await tx('a', '2026-11-01')
    await writeAnnotation('a', { moodId: 'mood.happy', worthwhile: true }, 'owner')
    expect(await wids()).toEqual([])
    await writeAnnotation('a', { worthwhile: null }, 'owner')
    expect(await wids()).toEqual(['a'])
  })

  it('excludes soft-deleted transactions, whatever annotation they carry', async () => {
    await tx('live', '2026-11-01')
    await tx('gone', '2026-11-01', { deletedAt: 5 })
    await writeAnnotation('live', { moodId: 'mood.happy' }, 'owner')
    await writeAnnotation('gone', { moodId: 'mood.happy', purchaseReasonId: 'reason.planned' }, 'owner')
    expect(await wids()).toEqual(['live'])
  })

  it('composes the shared predicate: essentials, internal, round-up and income are never asked about', async () => {
    await tx('essential', '2026-11-01', { ing: GROCERIES })
    await tx('internal', '2026-11-01', { kind: 'internal' })
    await tx('roundup', '2026-11-01', { kind: 'roundup' })
    await tx('income', '2026-11-01', { ing: null, kind: 'income' })
    await tx('ok', '2026-11-01')
    for (const id of ['essential', 'internal', 'roundup', 'income', 'ok']) await writeAnnotation(id, { moodId: 'mood.happy' }, 'owner')
    expect(await wids()).toEqual(['ok'])
  })

  it('honours a changed delay setting', async () => {
    await tx('a', '2026-11-01') // 15 days
    await tx('b', '2026-11-11') // 5 days
    await writeAnnotation('a', { moodId: 'mood.happy' }, 'owner')
    await writeAnnotation('b', { moodId: 'mood.happy' }, 'owner')
    expect(await worthwhileDelayDays()).toBe(7)
    expect(await wids(await worthwhileDelayDays())).toEqual(['a'])
    await setWorthwhileDelayDays(3)
    expect(await worthwhileDelayDays()).toBe(3)
    expect(await wids(await worthwhileDelayDays())).toEqual(['a', 'b'])
    await setWorthwhileDelayDays(30)
    expect(await wids(await worthwhileDelayDays())).toEqual([])
  })

  it('defaults to seven days when no delay is passed, and ignores an unusable stored delay', async () => {
    await tx('a', '2026-11-10')
    await writeAnnotation('a', { moodId: 'mood.happy' }, 'owner')
    expect(await wids()).toEqual([])
    await db.settings.update('singleton', { worthwhileDelayDays: -4 })
    expect(await worthwhileDelayDays()).toBe(7)
    await expect(setWorthwhileDelayDays(1.5)).rejects.toThrow(/Invalid delay/)
  })

  it('orders oldest first by resolved date, then statement order', async () => {
    await tx('late', '2026-11-08')
    await tx('mid-b', '2026-11-05')
    await tx('mid-a', '2026-11-05')
    await tx('early', '2026-11-02')
    for (const id of ['late', 'mid-b', 'mid-a', 'early']) await writeAnnotation(id, { moodId: 'mood.happy' }, 'owner')
    expect(await wids()).toEqual(['early', 'mid-b', 'mid-a', 'late'])
  })

  it('does not depend on mood prompting being on, and writes nothing by being read', async () => {
    await tx('a', '2026-11-01')
    await writeAnnotation('a', { moodId: 'mood.happy' }, 'owner')
    await db.settings.update('singleton', { moodPrompting: { enabled: false } })
    const before = await db.annotations.get('a')
    expect(await wids()).toEqual(['a'])
    expect(await wids()).toEqual(['a'])
    expect(await db.annotations.get('a')).toEqual(before)
  })
})

