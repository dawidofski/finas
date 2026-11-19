import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db/db'
import { seedDatabase } from '../db/seed'
import { dayMoodOf, dayMoods, moodFor, setDayMood } from './day'

beforeEach(async () => {
  await db.delete(); await db.open(); await seedDatabase()
})

describe('the mood of a day', () => {
  it('is none until one is set', async () => {
    expect(await dayMoodOf('2026-11-16')).toBeNull()
    expect((await dayMoods()).size).toBe(0)
  })

  it('is set, read back, and replaced', async () => {
    await setDayMood('2026-11-16', 'mood.happy')
    await setDayMood('2026-11-17', 'mood.sad')
    expect(await dayMoodOf('2026-11-16')).toBe('mood.happy')
    expect([...(await dayMoods())]).toEqual([['2026-11-16', 'mood.happy'], ['2026-11-17', 'mood.sad']])
    await setDayMood('2026-11-16', 'mood.bored')
    expect(await dayMoodOf('2026-11-16')).toBe('mood.bored')
  })

  it('is cleared with null, leaving the other days alone', async () => {
    await setDayMood('2026-11-16', 'mood.happy')
    await setDayMood('2026-11-17', 'mood.sad')
    await setDayMood('2026-11-16', null)
    expect(await dayMoodOf('2026-11-16')).toBeNull()
    expect(await dayMoodOf('2026-11-17')).toBe('mood.sad')
  })

  it('refuses a date that is not YYYY-MM-DD, and a mood that does not exist', async () => {
    await expect(setDayMood('16-11-2026', 'mood.happy')).rejects.toThrow(/date/i)
    await expect(setDayMood('2026-02-30', 'mood.happy')).rejects.toThrow(/date/i)
    await expect(setDayMood('2026-11-16', 'mood.nope')).rejects.toThrow(/mood/i)
    expect((await dayMoods()).size).toBe(0)
  })
})

describe('moodFor', () => {
  const days = new Map([['2026-11-16', 'mood.sad']])
  it('keeps the purchase\'s own mood', () => expect(moodFor('mood.happy', '2026-11-16', days)).toBe('mood.happy'))
  it('falls back to the mood of its bank date', () => expect(moodFor(null, '2026-11-16', days)).toBe('mood.sad'))
  it('is none when neither exists', () => expect(moodFor(null, '2026-11-17', days)).toBeNull())
})
