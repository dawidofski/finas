import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DailyBackupCard, DailyBackupSettings } from './DailyBackup'
import * as handles from '../backup/handleStore'
import type { BackupTarget, PermissionState } from '../backup/handleStore'
import { db } from '../db/db'
import { seedDatabase, getSettings } from '../db/seed'
import { guardWording } from '../test/wording'

const DAY = '2026-11-19'
const AT = Date.UTC(2026, 10, 19, 9, 30, 0)

/** The file the browser would hand over, and a stand-in for where it is remembered (a real one cannot be stored here). */
let written: string[] = []
let current: BackupTarget | null = null
function target(permission: PermissionState = 'granted', onRequest: PermissionState = 'granted'): BackupTarget {
  return {
    name: 'finance-backup-latest.json',
    createWritable: async () => ({ write: async (d: string) => { written.push(d) }, close: async () => {} }),
    queryPermission: async () => permission,
    requestPermission: async () => onRequest,
  }
}

beforeEach(async () => {
  written = []; current = null
  await db.delete(); await db.open(); await seedDatabase()
  ;(window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker = vi.fn(async () => target())
  vi.spyOn(handles, 'targetHandle').mockImplementation(async () => current)
  vi.spyOn(handles, 'rememberTarget').mockImplementation(async (h) => { current = h; return true })
  vi.spyOn(handles, 'forgetTarget').mockImplementation(async () => { current = null })
})
afterEach(() => {
  cleanup(); vi.restoreAllMocks()
  delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker
})
guardWording(3)

describe('the daily backup on the Dashboard', () => {
  it('makes today’s backup on opening and says nothing at all about it', async () => {
    current = target()
    const { container } = render(<DailyBackupCard today={DAY} at={AT} />)
    await waitFor(() => expect(written).toHaveLength(1))
    expect(container.textContent).toBe('')
    expect((await getSettings()).backup.lastBackupAt).toBe(AT)
  })

  it('shows nothing when no file has been chosen', async () => {
    const { container } = render(<DailyBackupCard today={DAY} at={AT} />)
    await waitFor(async () => expect(await db.settings.count()).toBe(1))
    expect(container.textContent).toBe('')
  })

  it('asks for one tap when the browser wants permission again, and writes once it is given', async () => {
    current = target('prompt', 'granted')
    render(<DailyBackupCard today={DAY} at={AT} />)
    expect((await screen.findByRole('heading', { level: 2, name: 'Your daily backup' })).textContent).toBe('Your daily backup')
    expect(document.body.textContent).toMatch(/asking to allow writing to your backup file again/)
    expect(written).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: 'Back up now' }))
    await waitFor(() => expect(written).toHaveLength(1))
    // The card has done its job and gets out of the way.
    await waitFor(() => expect(screen.queryByRole('heading', { level: 2, name: 'Your daily backup' })).toBeNull())
  })

  it('says the file could not be written, without claiming to know what became of it', async () => {
    current = { name: 'gone.json', createWritable: async () => { throw new Error('gone') }, queryPermission: async () => 'granted' }
    render(<DailyBackupCard today={DAY} at={AT} />)
    expect(await screen.findByText(/could not be written, so the file is as it was/)).toBeInTheDocument()
    expect(document.body.textContent).toMatch(/may have been moved, renamed or deleted/)
    expect((await getSettings()).backup.lastBackupAt).toBeNull()
  })
})

describe('setting the daily backup up', () => {
  const settings = () => render(<DailyBackupSettings today={DAY} at={AT} />)

  it('explains what it does and offers to choose the file', async () => {
    settings()
    expect(await screen.findByRole('button', { name: 'Choose where the daily backup goes' })).toBeInTheDocument()
    expect(document.body.textContent).toMatch(/writ(es|ing) over that same file each time/)
    expect(document.body.textContent).toMatch(/not encrypted/)
  })

  it('writes the first backup as soon as the file is chosen, and then names the file', async () => {
    settings()
    fireEvent.click(await screen.findByRole('button', { name: 'Choose where the daily backup goes' }))
    expect((await screen.findByRole('status')).textContent).toBe('Saving to finance-backup-latest.json. The first backup is in it now.')
    expect(written).toHaveLength(1)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Choose another file' })).toBeInTheDocument())
    expect(document.body.textContent).toMatch(/One backup a day is saved to finance-backup-latest\.json/)
    expect(document.body.textContent).toMatch(/Last saved on 19\/11\/2026/)
  })

  it('changes nothing when the file picker is closed without choosing', async () => {
    (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker = vi.fn().mockRejectedValue(new DOMException('aborted', 'AbortError'))
    settings()
    fireEvent.click(await screen.findByRole('button', { name: 'Choose where the daily backup goes' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Choose where the daily backup goes' })).toBeInTheDocument())
    expect(written).toEqual([])
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('turns off, leaving the file where it is', async () => {
    current = target()
    settings()
    fireEvent.click(await screen.findByRole('button', { name: 'Turn it off' }))
    expect((await screen.findByRole('status')).textContent).toMatch(/The file already on your phone is left as it is/)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Choose where the daily backup goes' })).toBeInTheDocument())
    expect(current).toBeNull()
  })

  it('says plainly when the browser cannot do this at all, and points at what does work', async () => {
    delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker
    settings()
    expect(await screen.findByText(/does not let the app write over a file you choose/)).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
  })
})
