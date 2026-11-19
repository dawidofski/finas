import { useEffect, useState, type ReactNode } from 'react'
import { canChooseFile, chooseFile, dailyState, runDailyBackup, stopDaily, type DailyState } from '../backup/daily'
import { formatSpanishDate } from '../lib/dates'

/**
 * The daily backup, in two places. On the Dashboard it runs by itself and shows nothing while all is well; in Settings
 * the owner chooses the file, changes it or turns it off. Both take `today` and `at` from the router, the one place the
 * clock is read.
 */

const NEEDS_TAP = 'Your browser is asking to allow writing to your backup file again. One tap does it.'
const FAILED = 'Today’s backup could not be written, so the file is as it was. The file may have been moved, renamed or deleted.'

/**
 * On the Dashboard: makes today's backup on opening, and stays out of the way. It appears only when it needs the owner
 * — a browser asking for permission again, or a write that did not work — never to report that all is well.
 */
export function DailyBackupCard({ today, at }: { today: string; at: number }): ReactNode {
  const [problem, setProblem] = useState<'needs-tap' | 'failed' | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    runDailyBackup(today, at).then(
      (outcome) => { if (live && (outcome === 'needs-tap' || outcome === 'failed')) setProblem(outcome) },
      () => { if (live) setProblem('failed') },
    )
    return () => { live = false }
  }, [today, at])

  async function again() {
    setBusy(true)
    try {
      const outcome = await runDailyBackup(today, at, { ask: true })
      setProblem(outcome === 'needs-tap' || outcome === 'failed' ? outcome : null)
    } finally { setBusy(false) }
  }

  if (problem === null) return null
  return (
    <section className="card" aria-labelledby="daily-backup-card">
      <h2 id="daily-backup-card">Your daily backup</h2>
      <p>{problem === 'needs-tap' ? NEEDS_TAP : FAILED}</p>
      <div className="actions">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => { void again() }}>
          {busy ? 'Saving…' : 'Back up now'}
        </button>
      </div>
    </section>
  )
}

/** In Settings: choosing the file, seeing where it goes, and turning it off. */
export function DailyBackupSettings({ today, at }: { today: string; at: number }): ReactNode {
  const [state, setState] = useState<DailyState | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const reload = async () => { setState(await dailyState()) }
  useEffect(() => { void reload() }, [])

  async function choose() {
    setBusy(true); setProblem(null); setNote(null)
    try {
      const chosen = await chooseFile()
      if (!chosen.ok) {
        if (chosen.reason === 'not-kept') setProblem('This browser did not keep your choice, so the backup was not set up.')
        return
      }
      // The first backup is made at once, so the owner can see the file appear rather than take it on trust.
      const outcome = await runDailyBackup(today, at, { ask: true })
      setNote(outcome === 'written'
        ? `Saving to ${chosen.name}. The first backup is in it now.`
        : outcome === 'already-today'
          ? `Saving to ${chosen.name}. Today’s backup was already made, so the next one goes in tomorrow.`
          : `Saving to ${chosen.name}, from tomorrow. Today’s could not be written yet.`)
      await reload()
    } finally { setBusy(false) }
  }

  async function backUpNow() {
    setBusy(true); setProblem(null); setNote(null)
    try {
      const outcome = await runDailyBackup(today, at, { ask: true })
      if (outcome === 'written') setNote('Written over your backup file.')
      else if (outcome === 'already-today') setNote('Today’s backup was already made.')
      else setProblem(outcome === 'needs-tap' ? NEEDS_TAP : FAILED)
      await reload()
    } finally { setBusy(false) }
  }

  async function turnOff() {
    setBusy(true); setProblem(null)
    try { await stopDaily(); setNote('Turned off. The file already on your phone is left as it is.'); await reload() } finally { setBusy(false) }
  }

  // Nothing while it is being read: a moment of "Loading" here would be noise, and role="status" is for what the owner just did.
  if (state === null) return null
  if (state.kind === 'unsupported') {
    return (
      <p>
        This browser does not let the app write over a file you choose, so a daily backup cannot be kept up to date here.
        The Download backup buttons above work as they always have. On an Android phone, Chrome can do this.
      </p>
    )
  }

  const on = state.kind !== 'off'
  return (
    <>
      <p>
        {on
          ? `One backup a day is saved to ${state.name}, on this phone. The app writes over that same file each time, so you have the latest and nothing piles up.`
          : 'The app can save one backup a day to a file on this phone, writing over that same file each time, so you have the latest and nothing piles up. It happens when you open the app.'}
      </p>
      {on && state.lastDay !== null && <p>Last saved on {formatSpanishDate(state.lastDay)}.</p>}
      {on && state.lastDay === null && <p>No daily backup has been saved yet.</p>}
      {state.kind === 'needs-tap' && <p>{NEEDS_TAP}</p>}
      <details className="tip">
        <summary>What goes in the file</summary>
        <p>
          The daily file holds the same plain backup as the Download backup button: readable by anything that can read your phone&rsquo;s storage,
          and <strong>not encrypted</strong>. Keep it somewhere you are comfortable with. The encrypted backup needs your passphrase every time,
          which is not something the app can do on its own, so take one of those by hand for the copy you keep elsewhere.
          A folder that syncs to cloud storage works as the place for the daily file, and nothing is sent anywhere by the app itself.
        </p>
      </details>
      <div className="actions">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => { void choose() }}>
          {on ? 'Choose another file' : 'Choose where the daily backup goes'}
        </button>
        {on && <button type="button" className="btn" disabled={busy} onClick={() => { void backUpNow() }}>Back up now</button>}
        {on && <button type="button" className="btn" disabled={busy} onClick={() => { void turnOff() }}>Turn it off</button>}
      </div>
      {note !== null && <p role="status">{note}</p>}
      {problem !== null && <div role="alert" className="notice notice-refusal"><p>{problem}</p></div>}
    </>
  )
}
