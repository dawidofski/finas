/**
 * The owner's DeepSeek key. It is kept in `localStorage`, on purpose and for one reason: THE SETTINGS ROW TRAVELS INSIDE
 * EVERY BACKUP FILE, and a key must never be written into a file the owner may copy to another machine or a cloud folder.
 * Kept here it is in no backup, plain or encrypted, and in no database table. It is in no source file either: the owner
 * types it in, and nothing in the repository ever holds one.
 *
 * What this does NOT do: protect the key. Browser storage is readable by anything with access to this device or this
 * browser profile, and the screen says so before the key is saved.
 *
 * Every access is wrapped: with site data blocked, `localStorage` throws. A failed read means "no key"; a failed save is
 * reported to the caller, which tells the owner the key was not kept.
 */
export const COACH_KEY = 'finance.coach.deepseekKey'

export function readCoachKey(): string | null {
  try {
    const key = localStorage.getItem(COACH_KEY)
    return key !== null && key.trim() !== '' ? key : null
  } catch { return null }
}

/** False when the browser refused to keep it (or it was blank). */
export function saveCoachKey(key: string): boolean {
  const clean = key.trim()
  if (clean === '') return false
  try { localStorage.setItem(COACH_KEY, clean); return localStorage.getItem(COACH_KEY) === clean } catch { return false }
}

export function removeCoachKey(): void {
  try { localStorage.removeItem(COACH_KEY) } catch { /* nothing was kept, so nothing is left */ }
}
