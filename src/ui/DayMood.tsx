import { useEffect, useState, type ReactNode } from 'react'
import { dayMoodOf, setDayMood } from '../mood/day'
import { addDays } from '../lib/dates'
import MoodRow from './annotations/MoodRow'
import './day-mood.css'

/**
 * The mood for the day, noted once instead of on every payment. Today's row is saved the moment it is tapped; tapping the
 * chosen mood again, or Clear, removes it. Yesterday gets a row of its own only while it has no mood, for the evening
 * somebody forgot. `today` is a prop: nothing here reads a clock.
 */
export default function DayMood({ today }: { today: string }): ReactNode {
  const yesterday = addDays(today, -1)
  const [mood, setMood] = useState<{ today: string | null; yesterday: string | null } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    Promise.all([dayMoodOf(today), dayMoodOf(yesterday)]).then(
      ([t, y]) => { if (live) setMood({ today: t, yesterday: y }) },
      () => { if (live) setError('Your moods for the days could not be read just now. Nothing has been changed.') },
    )
    return () => { live = false }
  }, [today, yesterday])

  async function save(which: 'today' | 'yesterday', moodId: string | null) {
    setBusy(true); setError(null)
    try {
      await setDayMood(which === 'today' ? today : yesterday, moodId)
      setMood((m) => ({ today: m?.today ?? null, yesterday: m?.yesterday ?? null, [which]: moodId }))
    } catch {
      setError('That could not be saved, so nothing was changed. You can try again.')
    } finally { setBusy(false) }
  }

  return (
    <section className="card day-mood" aria-labelledby="day-mood-title">
      <h2 id="day-mood-title">How was today?</h2>
      <p className="muted">One tap for the whole day is enough. Tap it again to clear it.</p>
      {error !== null && <p role="alert">{error}</p>}
      {mood !== null && (
        <>
          <MoodRow value={mood.today} onChange={(id) => void save('today', id)} disabled={busy} />
          {mood.yesterday === null && (
            <section className="day-mood-yesterday" aria-label="Yesterday">
              <h3>And yesterday?</h3>
              <MoodRow value={null} onChange={(id) => void save('yesterday', id)} disabled={busy} />
            </section>
          )}
        </>
      )}
    </section>
  )
}
