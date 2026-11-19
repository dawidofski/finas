import { db } from '../db/db'
import { getSettings } from '../db/seed'
import { addDays } from '../lib/dates'

/**
 * The owner's mood for a whole day, kept on the settings row (`dayMoods`: ISO date -> mood id). No table of its own,
 * so it travels in a backup with the rest of the settings.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function isIsoDate(date: string): boolean {
  if (!DATE_RE.test(date)) return false
  try { return addDays(date, 0) === date } catch { return false }
}

/** Pure. The one rule for "the mood of a purchase": its own if it has one, else the day's (by its bank date), else none. */
export function moodFor(ownMoodId: string | null, valueDate: string, days: ReadonlyMap<string, string>): string | null {
  return ownMoodId ?? days.get(valueDate) ?? null
}

/** Every day the owner has given a mood, as date -> mood id. Reads at call time. */
export async function dayMoods(): Promise<ReadonlyMap<string, string>> {
  const row = await db.settings.get('singleton')
  return new Map(Object.entries(row?.dayMoods ?? {}))
}

export async function dayMoodOf(date: string): Promise<string | null> {
  return (await dayMoods()).get(date) ?? null
}

/** Sets the mood of one day; null clears it. Refuses a date that is not a real YYYY-MM-DD and a mood that does not exist. */
export async function setDayMood(date: string, moodId: string | null): Promise<void> {
  if (!isIsoDate(date)) throw new Error(`Invalid date, expected YYYY-MM-DD: ${date}`)
  await db.transaction('rw', db.settings, db.moods, async () => {
    if (moodId !== null && (await db.moods.get(moodId)) === undefined) throw new Error(`Unknown mood ${moodId}`)
    const settings = await getSettings()
    const next: Record<string, string> = { ...(settings.dayMoods ?? {}) }
    if (moodId === null) delete next[date]
    else next[date] = moodId
    await db.settings.update('singleton', { dayMoods: next })
  })
}
