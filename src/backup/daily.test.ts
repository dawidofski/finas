import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { canChooseFile, chooseFile, dailyState, runDailyBackup, stopDaily, SUGGESTED_NAME } from './daily'
import * as handles from './handleStore'
import type { BackupTarget, PermissionState } from './handleStore'
import { db } from '../db/db'
import { seedDatabase, getSettings } from '../db/seed'
import { exportBundle } from '../db/backup'
import type { TransactionRow } from '../db/schema'

const DAY = '2026-11-19'
const AT = Date.UTC(2026, 10, 19, 9, 30, 0)
const NEXT_DAY = '2026-11-20'
const NEXT_AT = Date.UTC(2026, 10, 20, 9, 30, 0)

/** A stand-in for what the browser hands over: it records what was written to it, and what it was asked about. */
function target(over: { permission?: PermissionState; onRequest?: PermissionState; failWrite?: boolean; name?: string } = {}) {
  const written: string[] = []
  const asked: string[] = []
  const handle: BackupTarget = {
    name: over.name ?? SUGGESTED_NAME,
    createWritable: async (options) => {
      asked.push(`createWritable:${String(options?.keepExistingData)}`)
      if (over.failWrite === true) throw new Error('no longer there')
      return { write: async (data: string) => { written.push(data) }, close: async () => { asked.push('close') } }
    },
    queryPermission: async () => { asked.push('query'); return over.permission ?? 'granted' },
    requestPermission: async () => { asked.push('request'); return over.onRequest ?? 'granted' },
  }
  return { handle, written, asked }
}

const picked = (handle: BackupTarget | null) => vi.spyOn(handles, 'targetHandle').mockResolvedValue(handle)
const withPicker = (fn: unknown) => { (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker = fn }

let n = 0
const tx = (): TransactionRow => ({
  id: `t${++n}`, accountId: 'acc', valueDate: '2026-11-10', amountCents: -1234, balanceCents: 5000,
  description: 'Compra EN TIENDA EJEMPLO', comment: null, ingCategory: null, ingSubcategory: null, kind: 'spend',
  dedupKey: `K${n}`, importId: 'imp', fileSeq: n, roundupParentId: null, createdAt: 1, deletedAt: null,
})

beforeEach(async () => {
  n = 0
  await db.delete(); await db.open(); await seedDatabase()
  withPicker(async () => target().handle)
})
afterEach(() => {
  vi.restoreAllMocks()
  delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker
})

describe('whether this browser can do it at all', () => {
  it('says so when the browser offers no way to write over a file, and does nothing on a run', async () => {
    delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker
    expect(canChooseFile()).toBe(false)
    expect(await dailyState()).toEqual({ kind: 'unsupported' })
    expect(await runDailyBackup(DAY, AT)).toBe('unsupported')
    expect(await chooseFile()).toEqual({ ok: false, reason: 'unsupported' })
  })

  it('is off until a file has been chosen', async () => {
    picked(null)
    expect(canChooseFile()).toBe(true)
    expect(await dailyState()).toEqual({ kind: 'off' })
    expect(await runDailyBackup(DAY, AT)).toBe('off')
    expect((await getSettings()).backup.lastBackupAt).toBeNull()
  })
})

describe('one backup a day, over the same file', () => {
  it('writes the whole backup over the file, exactly what the plain download holds', async () => {
    await db.transactions.add(tx())
    const t = target()
    picked(t.handle)
    // Taken before the run: the export stamps the moment it was made, and the run marks the day in the settings row.
    const before = await exportBundle()
    expect(await runDailyBackup(DAY, AT)).toBe('written')
    expect(t.written).toHaveLength(1)
    // Nothing is kept from what was there: createWritable is called without keepExistingData, so the file is replaced.
    expect(t.asked).toEqual(['query', 'createWritable:undefined', 'close'])
    expect({ ...JSON.parse(t.written[0] ?? ''), exportedAt: '' }).toEqual({ ...JSON.parse(JSON.stringify(before)), exportedAt: '' })
  })

  it('does not write a second time the same day, and writes again the next day', async () => {
    const t = target()
    picked(t.handle)
    expect(await runDailyBackup(DAY, AT)).toBe('written')
    expect(await runDailyBackup(DAY, AT + 60_000)).toBe('already-today')
    expect(t.written).toHaveLength(1)
    // A day already made is answered from one small row: the records themselves are never read.
    const read = vi.spyOn(db.transactions, 'toArray')
    expect(await runDailyBackup(DAY, AT + 120_000)).toBe('already-today')
    expect(read).not.toHaveBeenCalled()   // the records themselves were never read
    read.mockRestore()
    expect(await runDailyBackup(NEXT_DAY, NEXT_AT)).toBe('written')
    expect(t.written).toHaveLength(2)
  })

  it('keeps the day it last ran, so the state can say when', async () => {
    picked(target().handle)
    await runDailyBackup(DAY, AT)
    expect((await getSettings()).backup.lastBackupAt).toBe(AT)
    expect(await dailyState()).toEqual({ kind: 'ready', name: SUGGESTED_NAME, lastDay: DAY })
  })
})

describe('when the browser wants permission again', () => {
  it('asks for nothing on a run of its own, writes nothing, and says a tap is needed', async () => {
    const t = target({ permission: 'prompt' })
    picked(t.handle)
    expect(await runDailyBackup(DAY, AT)).toBe('needs-tap')
    expect(t.asked).toEqual(['query'])
    expect(t.written).toEqual([])
    expect((await getSettings()).backup.lastBackupAt).toBeNull()
    expect(await dailyState()).toEqual({ kind: 'needs-tap', name: SUGGESTED_NAME, lastDay: null })
  })

  it('asks once the owner has tapped, and writes when they allow it', async () => {
    const t = target({ permission: 'prompt', onRequest: 'granted' })
    picked(t.handle)
    expect(await runDailyBackup(DAY, AT, { ask: true })).toBe('written')
    expect(t.asked).toEqual(['query', 'request', 'createWritable:undefined', 'close'])
    expect(t.written).toHaveLength(1)
  })

  it('writes nothing when they refuse, and does not ask again by itself', async () => {
    const t = target({ permission: 'prompt', onRequest: 'denied' })
    picked(t.handle)
    expect(await runDailyBackup(DAY, AT, { ask: true })).toBe('needs-tap')
    expect(t.written).toEqual([])
    expect((await getSettings()).backup.lastBackupAt).toBeNull()
  })

  it('takes a browser that asks about nothing at its word and writes', async () => {
    const t = target()
    const handle: BackupTarget = { name: t.handle.name, createWritable: t.handle.createWritable }
    picked(handle)
    expect(await runDailyBackup(DAY, AT)).toBe('written')
    expect(t.written).toHaveLength(1)
  })
})

describe('when the write does not work', () => {
  it('says so, leaves the day unmarked, and tries again on the next run', async () => {
    const failing = target({ failWrite: true })
    const spy = picked(failing.handle)
    expect(await runDailyBackup(DAY, AT)).toBe('failed')
    expect((await getSettings()).backup.lastBackupAt).toBeNull()
    const working = target()
    spy.mockResolvedValue(working.handle)
    expect(await runDailyBackup(DAY, AT)).toBe('written')
    expect(working.written).toHaveLength(1)
  })
})

describe('choosing the file and turning it off', () => {
  it('keeps what the picker gives, with the file name offered and the kind of file named', async () => {
    const chosen = target({ name: 'mis-ahorros.json' })
    const open = vi.fn().mockResolvedValue(chosen.handle)
    withPicker(open)
    const remember = vi.spyOn(handles, 'rememberTarget').mockResolvedValue(true)
    expect(await chooseFile()).toEqual({ ok: true, name: 'mis-ahorros.json' })
    expect(open.mock.calls[0]?.[0]).toMatchObject({ suggestedName: SUGGESTED_NAME })
    expect(remember).toHaveBeenCalledWith(chosen.handle)
  })

  it('treats a closed picker as a choice not made, and changes nothing', async () => {
    withPicker(vi.fn().mockRejectedValue(new DOMException('The user aborted a request.', 'AbortError')))
    const remember = vi.spyOn(handles, 'rememberTarget')
    expect(await chooseFile()).toEqual({ ok: false, reason: 'cancelled' })
    expect(remember).not.toHaveBeenCalled()
  })

  it('says so when the browser will not keep the choice', async () => {
    withPicker(vi.fn().mockResolvedValue(target().handle))
    vi.spyOn(handles, 'rememberTarget').mockResolvedValue(false)
    expect(await chooseFile()).toEqual({ ok: false, reason: 'not-kept' })
  })

  it('forgets the file when it is turned off', async () => {
    const forget = vi.spyOn(handles, 'forgetTarget').mockResolvedValue()
    await stopDaily()
    expect(forget).toHaveBeenCalledTimes(1)
  })
})

describe('where the file is remembered', () => {
  it('keeps it out of every backup file, in a database of its own', async () => {
    await handles.rememberTarget({ name: 'secreto.json' } as BackupTarget)
    expect(JSON.stringify(await exportBundle())).not.toContain('secreto.json')
    expect((await handles.targetHandle())?.name).toBe('secreto.json')
    await handles.forgetTarget()
    expect(await handles.targetHandle()).toBeNull()
  })

  it('treats a browser that refuses storage as having no file, without throwing', async () => {
    const open = vi.spyOn(indexedDB, 'open').mockImplementation(() => { throw new Error('blocked') })
    expect(await handles.targetHandle()).toBeNull()
    expect(await handles.rememberTarget({ name: 'x.json' } as BackupTarget)).toBe(false)
    await expect(handles.forgetTarget()).resolves.toBeUndefined()
    open.mockRestore()
  })
})
