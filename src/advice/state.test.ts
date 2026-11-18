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

describe('recommendation state', () => {
  it('suppresses a recommendation only after it has been rejected twice', async () => {
    expect(SUPPRESS_AFTER_REJECTIONS).toBe(2)
    await recordShown('k', 'f1', T0)
    await recordRejected('k', T0 + 1)
    expect((await db.recommendationState.get('k'))?.status).toBe('rejected')
    expect((await withheldKeys(fp('k', 'f1'), T0 + 2)).has('k')).toBe(false) // "not now" is not "not this"
    await recordRejected('k', T0 + 3)
    const row = await db.recommendationState.get('k')
    expect(row?.status).toBe('suppressed')
    expect(row?.rejectedCount).toBe(2)
    expect((await withheldKeys(fp('k', 'f1'), T0 + 4)).has('k')).toBe(true)
  })

  it('keeps a rejection across a reload, because it is stored and not held in memory', async () => {
    await recordRejected('k', T0)
    await recordRejected('k', T0 + 1)
    db.close()
    await db.open()
    expect((await withheldKeys(fp('k', 'f1'), T0 + 2)).has('k')).toBe(true)
  })

  it('suppresses by a key that does not change when the underlying figure does', async () => {
    // Keys are produced by a later task; what this module owns is that it keys on exactly the string it is given.
    const keyFor = (_monthFigureCents: number) => 'cut:Ocio:Bares'
    expect(keyFor(4_200)).toBe(keyFor(9_900)) // same advice, two months' figures, same string
    await recordRejected(keyFor(4_200), T0)
    await recordRejected(keyFor(4_200), T0 + 1)
    expect((await withheldKeys(fp(keyFor(9_900), 'other'), T0 + 2)).has(keyFor(9_900))).toBe(true)
    // and it never derives one: a different string is a different recommendation
    expect((await withheldKeys(fp('cut:Ocio:Bares:9900', 'f'), T0 + 2)).size).toBe(0)
    expect((await db.recommendationState.toArray()).map(r => r.key)).toEqual(['cut:Ocio:Bares'])
  })

  it('keeps a twice-rejected recommendation away even when its evidence has changed', async () => {
    await recordShown('k', 'f1', T0)
    await recordRejected('k', T0 + 1)
    await recordRejected('k', T0 + 2)
    expect((await withheldKeys(fp('k', 'f2-new-transactions'), T0 + 3)).has('k')).toBe(true)
    await recordShown('k', 'f2-new-transactions', T0 + 4)
    const shown = await db.recommendationState.get('k')
    expect(shown?.status).toBe('suppressed') // showing never un-suppresses
    expect(shown?.evidenceFingerprint).toBe('f1') // nor rewrites the evidence the owner dismissed
    expect((await withheldKeys(fp('k', 'f2-new-transactions'), T0 + 5)).has('k')).toBe(true)
  })

  it('offers accepted advice again only when the evidence is a different occurrence', async () => {
    await recordShown('k', 'f1', T0)
    await recordAccepted('k', T0 + 1)
    expect((await withheldKeys(fp('k', 'f1'), T0 + 2)).has('k')).toBe(true)
    expect((await withheldKeys(fp('k', 'f2'), T0 + 2)).has('k')).toBe(false)
    expect((await withheldKeys(new Map(), T0 + 2)).has('k')).toBe(false) // only keys asked about are judged
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
    await recordAccepted('k', T0 + 1)
    await recordShown('k', 'f2', T0 + 2)
    const row = await db.recommendationState.get('k')
    expect(row?.status).toBe('active')
    expect(row?.evidenceFingerprint).toBe('f2')
  })
})
