import { exportBundle } from '../db/backup'
import { db } from '../db/db'
import { getSettings } from '../db/seed'
import { epochMsToIso } from '../lib/dates'
import { forgetTarget, rememberTarget, targetHandle, type BackupTarget, type PermissionState } from './handleStore'

/**
 * One backup file on the phone, written over once a day.
 *
 * The owner picks the file once; the browser hands the app a way back to that same file, which is kept (handleStore)
 * and used on every later launch. Writing replaces what was there, so the file is always the latest and nothing piles
 * up. At most one write per day: the day of the last one is kept in the settings row and compared with today's.
 *
 * WHAT IS WRITTEN is the plain backup, the same text the Download backup button gives, and it is **not encrypted**:
 * the encrypted one needs a passphrase, and asking for it every day is not something that can run on its own. Every
 * screen that offers this says so.
 *
 * Nothing leaves the device: the file is written through the browser, to a place the owner chose.
 *
 * The clock is not read here. `today` (a UTC day) and `at` (the instant) are handed in by the caller, as everywhere else.
 */

/** The name the file picker starts with. The owner may change it; what matters is the file, not its name. */
export const SUGGESTED_NAME = 'finance-backup-latest.json'

interface PickerWindow {
  showSaveFilePicker?: (options?: { suggestedName?: string; types?: Array<{ description: string; accept: Record<string, string[]> }> }) => Promise<BackupTarget>
}

const picker = (): PickerWindow['showSaveFilePicker'] =>
  (typeof window === 'undefined' ? undefined : (window as unknown as PickerWindow).showSaveFilePicker)

/** Whether this browser can hand the app a file to write over. Chrome on Android can; some browsers cannot. */
export const canChooseFile = (): boolean => typeof picker() === 'function'

export type DailyState =
  /** This browser cannot write over a file, so there is nothing to offer. */
  | { kind: 'unsupported' }
  /** No file has been chosen: the daily backup is off. */
  | { kind: 'off' }
  /** A file is chosen and can be written without asking again. */
  | { kind: 'ready'; name: string; lastDay: string | null }
  /** A file is chosen, and the browser wants the owner to allow writing to it again. */
  | { kind: 'needs-tap'; name: string; lastDay: string | null }

export type RunOutcome =
  /** The file was written over just now. */
  | 'written'
  /** Today's backup was already made; nothing was read or written. */
  | 'already-today'
  | 'off'
  | 'unsupported'
  /** The browser wants permission, and only a tap of the owner's can give it. */
  | 'needs-tap'
  | 'failed'

/** The day of the last daily backup, as a UTC day, or null when there has not been one. */
async function lastDayOf(): Promise<string | null> {
  const at = (await getSettings()).backup.lastBackupAt
  return at === null ? null : epochMsToIso(at)
}

/**
 * Asks the browser where this file stands. A browser that does not ask about permission at all (an older way of doing
 * it) has no `queryPermission`, and the only way to find out is to write: that counts as ready, and a refusal there is
 * reported as a failure rather than guessed at here.
 */
async function permissionOf(handle: BackupTarget, ask: boolean): Promise<PermissionState> {
  const current = handle.queryPermission === undefined ? 'granted' : await handle.queryPermission({ mode: 'readwrite' })
  if (current === 'granted' || !ask || handle.requestPermission === undefined) return current
  return handle.requestPermission({ mode: 'readwrite' })
}

export async function dailyState(): Promise<DailyState> {
  if (!canChooseFile()) return { kind: 'unsupported' }
  const handle = await targetHandle()
  if (handle === null) return { kind: 'off' }
  const lastDay = await lastDayOf()
  let allowed: PermissionState
  try { allowed = await permissionOf(handle, false) } catch { return { kind: 'needs-tap', name: handle.name, lastDay } }
  return allowed === 'granted'
    ? { kind: 'ready', name: handle.name, lastDay }
    : { kind: 'needs-tap', name: handle.name, lastDay }
}

/**
 * Writes today's backup over the chosen file, unless today's has already been made.
 *
 * `ask` is false when the app runs this by itself on opening: a browser that wants permission again can only be asked
 * from something the owner tapped, so that run reports `needs-tap` and the screen offers the tap. With `ask` true (the
 * owner tapped), the browser is asked, and a refusal is reported rather than retried.
 *
 * The database is read only once the day has been checked, so an ordinary launch reads one small row and stops.
 */
export async function runDailyBackup(today: string, at: number, { ask = false }: { ask?: boolean } = {}): Promise<RunOutcome> {
  if (!canChooseFile()) return 'unsupported'
  const handle = await targetHandle()
  if (handle === null) return 'off'
  if (await lastDayOf() === today) return 'already-today'
  try {
    if (await permissionOf(handle, ask) !== 'granted') return 'needs-tap'
    const text = JSON.stringify(await exportBundle(), null, 2)
    const file = await handle.createWritable()
    await file.write(text)
    await file.close()
  } catch {
    return 'failed'
  }
  // Only once the file is closed: a day marked as done over a write that failed would hide the failure until tomorrow.
  await db.settings.update('singleton', { backup: { lastBackupAt: at } })
  return 'written'
}

export type ChoiceOutcome = { ok: true; name: string } | { ok: false; reason: 'cancelled' | 'not-kept' | 'unsupported' }

/**
 * Opens the browser's own file picker and keeps what it gives back. The owner creates the file (or picks one to write
 * over) wherever they like, a folder that syncs elsewhere included. Cancelling is not a failure and changes nothing.
 */
export async function chooseFile(): Promise<ChoiceOutcome> {
  const open = picker()
  if (open === undefined) return { ok: false, reason: 'unsupported' }
  let handle: BackupTarget
  try {
    handle = await open({ suggestedName: SUGGESTED_NAME, types: [{ description: 'Backup file', accept: { 'application/json': ['.json'] } }] })
  } catch {
    return { ok: false, reason: 'cancelled' }   // the owner closed the picker, or the browser refused to open it
  }
  return await rememberTarget(handle) ? { ok: true, name: handle.name } : { ok: false, reason: 'not-kept' }
}

/** Forgets the file. The file itself is left exactly as it is, on the phone. */
export async function stopDaily(): Promise<void> {
  await forgetTarget()
}
