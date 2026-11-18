import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db/db'
import {
  SUPPRESS_AFTER_REJECTIONS, SNOOZE_DAYS,
  recordShown, recordAccepted, recordRejected, recordSnoozed, withheldKeys,
} from './state'

beforeEach(async () => { await db.delete(); await db.open() })

const DAY = 86_400_000
const T0 = 1_000_000_000_000
const fp = (key: string, f: string) => new Map([[key, f]])

/** Two rejections on two separate occasions (two periods, each shown): the only way to reach 'suppressed'. */
async function rejectTwice(key: string, f: string): Promise<void> {
  await recordShown(key, f, T0)
  await recordRejected(key)
  await recordShown(key, `${f}-later`, T0 + 1)
  await recordRejected(key)
}

describe('recommendation state', () => {
  it('suppresses a recommendation only after it has been rejected twice', async () => {
    expect(SUPPRESS_AFTER_REJECTIONS).toBe(2)
    await recordShown('k', 'f1', T0)
    await recordRejected('k')
    expect((await db.recommendationState.get('k'))?.status).toBe('rejected')
    expect((await withheldKeys(fp('k', 'f1'), T0 + 2)).has('k')).toBe(true) // "not now" holds for the occurrence it was said about
    expect((await withheldKeys(fp('k', 'f2'), T0 + 2)).has('k')).toBe(false) // and is not "not this": a later occurrence is offered
    await recordShown('k', 'f2', T0 + 3)
    await recordRejected('k')
    const row = await db.recommendationState.get('k')
    expect(row?.status).toBe('suppressed')
    expect(row?.rejectedCount).toBe(2)
    expect((await withheldKeys(fp('k', 'f2'), T0 + 4)).has('k')).toBe(true)
  })

  it('keeps a rejection across a reload, because it is stored and not held in memory', async () => {
    await rejectTwice('k', 'f1')
    db.close()
    await db.open()
    expect((await withheldKeys(fp('k', 'f1-later'), T0 + 2)).has('k')).toBe(true)
  })

  it('keys on exactly the string it is given and never derives one', async () => {
    // Keys come from a later task; what this module owns is that it uses the given string as-is.
    await rejectTwice('cut:Ocio:Bares', 'f1')
    expect((await withheldKeys(fp('cut:Ocio:Bares', 'f-next-month'), T0 + 2)).has('cut:Ocio:Bares')).toBe(true)
    expect((await withheldKeys(fp('cut:Ocio:Bares:9900', 'f1'), T0 + 2)).size).toBe(0)
    expect((await db.recommendationState.toArray()).map(r => r.key)).toEqual(['cut:Ocio:Bares'])
  })

  it('keeps a twice-rejected recommendation away even when its evidence has changed', async () => {
    await rejectTwice('k', 'f1')
    expect((await withheldKeys(fp('k', 'f2-new-transactions'), T0 + 3)).has('k')).toBe(true)
    await recordShown('k', 'f2-new-transactions', T0 + 4)
    const shown = await db.recommendationState.get('k')
    expect(shown?.status).toBe('suppressed') // showing never un-suppresses
    expect(shown?.evidenceFingerprint).toBe('f1-later') // nor rewrites the evidence the owner dismissed
    expect([shown?.shownCount, shown?.lastShownAt]).toEqual([2, T0 + 1]) // nor counts a showing that was withheld
    expect((await withheldKeys(fp('k', 'f2-new-transactions'), T0 + 5)).has('k')).toBe(true)
  })

  it('offers accepted advice again only when the evidence is a different occurrence', async () => {
    await recordShown('k', 'f1', T0)
    await recordAccepted('k')
    expect((await withheldKeys(fp('k', 'f1'), T0 + 2)).has('k')).toBe(true)
    expect((await withheldKeys(fp('k', 'f2'), T0 + 2)).has('k')).toBe(false)
    expect((await withheldKeys(new Map(), T0 + 2)).has('k')).toBe(false) // only keys asked about are judged
  })

  it('offers rejected advice whose stored fingerprint is null, since it cannot show it is the same occasion', async () => {
    await recordRejected('k') // rejected before any showing was recorded
    expect((await db.recommendationState.get('k'))?.evidenceFingerprint).toBeNull()
    expect((await withheldKeys(fp('k', 'f1'), T0)).has('k')).toBe(false)
  })

  it('withholds accepted advice whose stored fingerprint is null', async () => {
    await recordAccepted('k') // accepted before it was ever shown
    expect((await db.recommendationState.get('k'))?.evidenceFingerprint).toBeNull()
    expect((await withheldKeys(fp('k', 'f1'), T0)).has('k')).toBe(true)
  })

  it('returns a snoozed recommendation once its date has passed, and not before', async () => {
    expect(SNOOZE_DAYS).toBe(30)
    await recordShown('k', 'f1', T0)
    await recordSnoozed('k', T0)
    const until = T0 + 30 * DAY
    expect((await db.recommendationState.get('k'))?.suppressedUntil).toBe(until)
    expect((await withheldKeys(fp('k', 'f1'), until - 1)).has('k')).toBe(true)
    expect((await withheldKeys(fp('k', 'f1'), until)).has('k')).toBe(false)
    expect((await withheldKeys(fp('k', 'changed'), until - 1)).has('k')).toBe(true) // fingerprint is irrelevant to a snooze
  })

  it('leaves a still-snoozed row snoozed when it is shown, and wakes an expired one', async () => {
    await recordSnoozed('k', T0)
    await recordShown('k', 'f1', T0 + DAY)
    expect((await db.recommendationState.get('k'))?.status).toBe('snoozed')
    await recordShown('k', 'f1', T0 + 31 * DAY)
    const row = await db.recommendationState.get('k')
    expect([row?.status, row?.suppressedUntil]).toEqual(['active', null])
  })

  it('offers active advice and advice with no row', async () => {
    await recordShown('a', 'f', T0)
    const w = await withheldKeys(new Map([['a', 'f'], ['none', 'f']]), T0 + 1)
    expect(w.size).toBe(0)
    expect((await db.recommendationState.get('a'))?.shownCount).toBe(1)
    await recordShown('a', 'f', T0 + 2)
    expect((await db.recommendationState.get('a'))?.shownCount).toBe(2)
    expect((await db.recommendationState.get('a'))?.lastShownAt).toBe(T0 + 2)
  })

  it('re-activates a fresh occurrence of accepted advice when it is shown', async () => {
    await recordShown('k', 'f1', T0)
    await recordAccepted('k')
    await recordShown('k', 'f2', T0 + 2)
    const row = await db.recommendationState.get('k')
    expect(row?.status).toBe('active')
    expect(row?.evidenceFingerprint).toBe('f2')
  })

  it('ignores a double-fired rejection', async () => {
    await recordShown('k', 'same', T0)
    await recordRejected('k')
    await recordRejected('k') // double-click
    const row = await db.recommendationState.get('k')
    expect([row?.rejectedCount, row?.status]).toEqual([1, 'rejected'])
    expect((await withheldKeys(fp('k', 'same'), T0 + 1)).has('k')).toBe(true)
  })

  it('counts one rejection on each of two occasions, and not a second one on the same occasion', async () => {
    await recordShown('k', 'same', T0)
    await recordRejected('k')
    await recordShown('k', 'same', T0 + 1) // the same period shown again (a stale tab): not a new occasion
    expect((await db.recommendationState.get('k'))?.status).toBe('rejected')
    await recordRejected('k')
    expect((await db.recommendationState.get('k'))?.rejectedCount).toBe(1)
    await recordShown('k', 'other', T0 + 2)
    expect((await db.recommendationState.get('k'))?.status).toBe('active')
    await recordRejected('k')
    const row = await db.recommendationState.get('k')
    expect([row?.rejectedCount, row?.status]).toEqual([2, 'suppressed'])
  })

  it('counts a first rejection even when no showing was ever recorded', async () => {
    await recordRejected('k')
    const row = await db.recommendationState.get('k')
    expect([row?.rejectedCount, row?.status]).toEqual([1, 'rejected'])
  })

  it('does not count a rejection that follows a snooze with no showing in between', async () => {
    await recordShown('k', 'f', T0)
    await recordRejected('k')
    await recordSnoozed('k', T0 + 1)
    await recordRejected('k') // stale tab
    const row = await db.recommendationState.get('k')
    expect([row?.rejectedCount, row?.status]).toEqual([1, 'snoozed'])
  })

  it('does not count a rejection that follows an acceptance with no showing in between', async () => {
    await recordShown('k', 'f', T0)
    await recordRejected('k')
    await recordAccepted('k')
    await recordRejected('k') // stale tab
    const row = await db.recommendationState.get('k')
    expect([row?.rejectedCount, row?.status]).toEqual([1, 'accepted'])
  })

  it('treats suppressed as terminal for every writer', async () => {
    await rejectTwice('k', 'f1')
    const before = await db.recommendationState.get('k')
    await recordAccepted('k')
    expect(await db.recommendationState.get('k')).toEqual(before)
    await recordSnoozed('k', T0 + 2)
    expect(await db.recommendationState.get('k')).toEqual(before)
    await recordRejected('k')
    expect(await db.recommendationState.get('k')).toEqual(before)
    expect((await withheldKeys(fp('k', 'brand-new'), T0 + 40 * DAY)).has('k')).toBe(true)
  })
})

describe('recommendation state, malformed rows', () => {
  it('offers a snoozed row that has no date, and shown wakes it, rather than withholding it forever', async () => {
    await db.recommendationState.put({ key: 'k', status: 'snoozed', shownCount: 0, rejectedCount: 0, lastShownAt: null, suppressedUntil: null, evidenceFingerprint: null })
    expect((await withheldKeys(fp('k', 'f'), T0)).has('k')).toBe(false)
    await recordShown('k', 'f', T0)
    expect((await db.recommendationState.get('k'))?.status).toBe('active')
  })
})
