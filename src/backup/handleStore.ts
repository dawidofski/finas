/**
 * Where the daily backup's destination file is remembered: one value, in a small database of this application's own.
 *
 * NOT in the Dexie tables and NOT in the settings row, on purpose. The settings row travels inside every backup file,
 * and a pointer to a file on this phone means nothing on another device — restoring one would hand a second device a
 * target it cannot write to. It cannot live in `localStorage` either: the browser hands the app an object, not text,
 * and only IndexedDB keeps such an object whole.
 *
 * Every call is wrapped: in a private window, or with site data blocked, even opening a database can throw. A failure
 * to read means "no file chosen"; a failure to write is reported to the caller, which tells the owner.
 */

/** What the app needs of the file the browser hands it. A real file handle has all of this and more. */
export interface BackupTarget {
  readonly name: string
  /** Replaces the file's contents: `keepExistingData` is left off, so what was there is written over. */
  createWritable(options?: { keepExistingData?: boolean }): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>
  queryPermission?(descriptor: { mode: 'readwrite' }): Promise<PermissionState>
  requestPermission?(descriptor: { mode: 'readwrite' }): Promise<PermissionState>
}

export type PermissionState = 'granted' | 'denied' | 'prompt'

const DB_NAME = 'finance-backup-target'
const STORE = 'target'
const KEY = 'daily'

function openStore(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    let request: IDBOpenDBRequest
    try { request = indexedDB.open(DB_NAME, 1) } catch { resolve(null); return }
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => resolve(null)
    request.onblocked = () => resolve(null)
  })
}

function run<T>(mode: IDBTransactionMode, act: (store: IDBObjectStore) => IDBRequest, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    void openStore().then((db) => {
      if (db === null) { resolve(fallback); return }
      try {
        const request = act(db.transaction(STORE, mode).objectStore(STORE))
        request.onsuccess = () => { resolve(request.result as T); db.close() }
        request.onerror = () => { resolve(fallback); db.close() }
      } catch { resolve(fallback); db.close() }
    })
  })
}

/** The file chosen for the daily backup, or null when none has been chosen (or it cannot be read back). */
export async function targetHandle(): Promise<BackupTarget | null> {
  return (await run<BackupTarget | null>('readonly', (s) => s.get(KEY), null)) ?? null
}

/** False when the browser refused to keep it, which means the choice would be forgotten at the next start. */
export async function rememberTarget(handle: BackupTarget): Promise<boolean> {
  const key = await run<IDBValidKey | null>('readwrite', (s) => s.put(handle, KEY), null)
  return key !== null
}

export async function forgetTarget(): Promise<void> {
  await run<unknown>('readwrite', (s) => s.delete(KEY), null)
}
