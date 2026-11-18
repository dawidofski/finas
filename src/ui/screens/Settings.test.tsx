import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, within, fireEvent, act, configure } from '@testing-library/react'
import Settings from './Settings'
import { db } from '../../db/db'
import { seedDatabase, getSettings } from '../../db/seed'
import * as backup from '../../db/backup'
import { guardWording } from '../../test/wording'
import { appSpoken } from '../../test/spoken'
import { violations } from '../../test/bannedWords'
import * as backupFile from '../../db/backupFile'
import { encryptBundle } from '../../db/encryptedBackup'
import { PASSPHRASE_MESSAGES } from '../../lib/passphrase'

vi.mock('../../db/backupFile', async importOriginal => {
  const actual = await importOriginal<typeof import('../../db/backupFile')>()
  return { ...actual, openEncryptedBackup: vi.fn(actual.openEncryptedBackup) }
})

// Wrap the real engine in spies: the tests exercise real inspect/restore against the real (fake-indexeddb) database.
vi.mock('../../db/backup', async importOriginal => {
  const actual = await importOriginal<typeof import('../../db/backup')>()
  return { ...actual, inspectBundle: vi.fn(actual.inspectBundle), restoreBundle: vi.fn(actual.restoreBundle), exportBundle: vi.fn(actual.exportBundle) }
})

const readBlob = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const r = new FileReader()
  r.onload = () => resolve(String(r.result))
  r.onerror = () => reject(r.error)
  r.readAsText(blob)
})

// A key derivation takes about a second (the real count, no shortcut), longer when the machine is busy: the default one second
// for findBy and waitFor would make every test that waits on one pass or fail by the clock.
configure({ asyncUtilTimeout: 10000 })

const REPORT = { name: /what this restore would do/i }

beforeEach(async () => {
  await db.delete()
  await db.open()
  await seedDatabase()
  vi.mocked(backup.inspectBundle).mockClear()
  vi.mocked(backup.restoreBundle).mockClear()
  vi.mocked(backupFile.openEncryptedBackup).mockClear()
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

const fileOf = (text: string, name = 'backup.json') => new File([text], name, { type: 'application/json' })
const pick = (file: File) => fireEvent.change(screen.getByLabelText(/backup file/i), { target: { files: [file] } })
const click = (name: RegExp) => fireEvent.click(screen.getByRole('button', { name }))
const choose = (name: RegExp) => fireEvent.click(screen.getByRole('radio', { name }))

async function validBundleText() {
  return JSON.stringify(await backup.exportBundle())
}

guardWording(40)

describe('Settings backup', () => {
  it('downloads a bundle whose filename carries the date, and revokes the object URL after the click', async () => {
    const events: string[] = []
    let blob: Blob | undefined
    const create = vi.fn((b: Blob) => { blob = b; events.push('create'); return 'blob:fake-1' })
    const revoke = vi.fn((u: string) => { events.push(`revoke:${u}`) })
    // jsdom has neither function. Stubbing them (and the anchor click) means nothing is written to disk.
    Object.defineProperty(URL, 'createObjectURL', { value: create, configurable: true, writable: true })
    Object.defineProperty(URL, 'revokeObjectURL', { value: revoke, configurable: true, writable: true })
    let clicked: { download: string; href: string } | undefined
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      events.push('click')
      clicked = { download: this.download, href: this.href }
    })
    // The revoke must be deferred: capture the delayed callback instead of waiting real seconds for it.
    const realSetTimeout = globalThis.setTimeout
    const deferred: Array<() => void> = []
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) => {
      if (ms === 5000) { // REVOKE_DELAY_MS; RTL's own 1000 ms timers must keep running
        deferred.push(fn); return 0 }
      return realSetTimeout(fn, ms, ...rest)
    }) as unknown as typeof setTimeout)
    render(<Settings />)
    click(/download plain backup/i)
    await waitFor(() => expect(deferred).toHaveLength(1))
    expect(revoke).not.toHaveBeenCalled()
    expect(events).toEqual(['create', 'click'])
    deferred[0]!()

    expect(clicked?.download).toMatch(/^finance-backup-\d{4}-\d{2}-\d{2}\.json$/)
    expect(clicked?.href).toBe('blob:fake-1')
    expect(events).toEqual(['create', 'click', 'revoke:blob:fake-1'])
    const parsed = JSON.parse(await readBlob(blob!))
    expect(parsed.format).toBe('finance-export')
    expect(Object.keys(parsed.tables)).toContain('settings')
  })

  it('tells the owner in a sentence when the backup cannot be created, without developer wording', async () => {
    vi.mocked(backup.exportBundle).mockRejectedValueOnce(new Error('IDBKeyRange: DataError at table transactions'))
    render(<Settings />)
    click(/download plain backup/i)
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/backup could not be created/i)
    expect(alert).not.toHaveTextContent(/IDB|DataError|transactions/)
  })

  it('shows the dry-run report before writing anything', async () => {
    const text = await validBundleText()
    render(<Settings />)
    pick(fileOf(text))
    const table = await screen.findByRole('table', REPORT)
    expect(within(table).getByRole('columnheader', { name: /new rows/i })).toBeTruthy()
    expect(within(table).getByRole('row', { name: /categories/i })).toBeTruthy()
    expect(backup.inspectBundle).toHaveBeenCalledTimes(1)
    expect(backup.restoreBundle).not.toHaveBeenCalled()
  })

  it('requires an explicit confirm before restoring', async () => {
    const text = await validBundleText()
    render(<Settings />)
    pick(fileOf(text))
    await screen.findByRole('table', REPORT)
    expect(backup.restoreBundle).not.toHaveBeenCalled()
    click(/confirm merge/i)
    await waitFor(() => expect(backup.restoreBundle).toHaveBeenCalledTimes(1))
    expect((await screen.findByRole('status')).textContent).toMatch(/restore finished/i)
  })

  it.each(['merge', 'replace'] as const)('passes the same mode (%s) to inspect and to restore', async mode => {
    const text = await validBundleText()
    render(<Settings />)
    choose(new RegExp(mode, 'i'))
    pick(fileOf(text))
    await screen.findByRole('table', REPORT)
    click(new RegExp(`confirm ${mode}`, 'i'))
    await waitFor(() => expect(backup.restoreBundle).toHaveBeenCalledTimes(1))
    const inspected = vi.mocked(backup.inspectBundle).mock.calls[0]!
    const restored = vi.mocked(backup.restoreBundle).mock.calls[0]!
    expect(inspected[1]).toBe(mode)
    expect(restored[1]).toBe(mode)
    expect(restored[0]).toBe(inspected[0]) // the very bundle that was previewed
  })

  it('discards the preview when the mode changes, so a merge preview can never confirm a replace', async () => {
    const text = await validBundleText()
    render(<Settings />)
    pick(fileOf(text))
    await screen.findByRole('table', REPORT)
    choose(/replace/i)
    expect(screen.queryByRole('table', REPORT)).toBeNull()
    expect(screen.queryByRole('button', { name: /confirm/i })).toBeNull()
    expect(backup.restoreBundle).not.toHaveBeenCalled()
  })

  it('renders a refusal reason and detail verbatim, and writes nothing', async () => {
    const bundle = await backup.exportBundle()
    const newer = { ...bundle, schemaVersion: bundle.schemaVersion + 1 }
    const before = await db.categories.count()
    const expected = await backup.inspectBundle(newer, 'merge')
    expect(expected.refusedReason).toBe('newer-schema')
    render(<Settings />)
    pick(fileOf(JSON.stringify(newer)))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(expected.detail!)
    expect(alert.textContent).toContain('newer-schema')
    expect(screen.queryByRole('button', { name: /confirm/i })).toBeNull()
    expect(backup.restoreBundle).not.toHaveBeenCalled()
    expect(await db.categories.count()).toBe(before)
  })

  it('presents a file that is not JSON as a refusal rather than crashing', async () => {
    render(<Settings />)
    pick(fileOf('this is not json {'))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/not valid JSON/i)
    expect(backup.inspectBundle).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /confirm/i })).toBeNull()
  })

  it('presents an unreadable file as a refusal rather than crashing', async () => {
    vi.spyOn(FileReader.prototype, 'readAsText').mockImplementation(function (this: FileReader) {
      queueMicrotask(() => this.onerror?.(new ProgressEvent('error') as ProgressEvent<FileReader>))
    })
    render(<Settings />)
    pick(fileOf('{}'))
    expect((await screen.findByRole('alert')).textContent).toMatch(/could not read/i)
    expect(backup.inspectBundle).not.toHaveBeenCalled()
  })

  it('shows the salt-mismatch refusal for a merge from another installation', async () => {
    await getSettings()
    const bundle = await backup.exportBundle()
    const rows = bundle.tables['settings'] as Array<{ privacy: { accountSalt: string } }>
    rows[0]!.privacy.accountSalt = 'a-different-installation'
    const expected = await backup.inspectBundle(bundle, 'merge')
    expect(expected.refusedReason).toBe('salt-mismatch')
    render(<Settings />)
    pick(fileOf(JSON.stringify(bundle)))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(expected.detail!)
    expect(alert.textContent).toContain('salt-mismatch')
  })

  it('warns that replace overwrites, and offers merge', () => {
    render(<Settings />)
    expect((screen.getByRole('radio', { name: /merge/i }) as HTMLInputElement).checked).toBe(true)
    expect(screen.queryByText(/replace makes this device match the backup/i)).toBeNull()
    choose(/replace/i)
    expect(screen.getByText(/replace makes this device match the backup/i)).toBeTruthy()
    expect(screen.getByRole('radio', { name: /merge/i })).toBeTruthy()
  })

  it('surfaces the unchecked list rather than hiding it', async () => {
    const text = await validBundleText()
    render(<Settings />)
    pick(fileOf(text))
    await screen.findByRole('table', REPORT)
    const expected = await backup.inspectBundle(JSON.parse(text), 'merge')
    expect(expected.unchecked!.length).toBeGreaterThan(0)
    for (const line of expected.unchecked!) expect(screen.getByText(line)).toBeTruthy()
  })

  it('reports a differing row as a conflict, separate from new rows', async () => {
    const bundle = await backup.exportBundle()
    const cats = bundle.tables['categories'] as Array<Record<string, unknown>>
    cats[0] = { ...cats[0]!, name: 'Changed elsewhere' }
    render(<Settings />)
    pick(fileOf(JSON.stringify(bundle)))
    const table = await screen.findByRole('table', REPORT)
    const row = within(table).getByRole('row', { name: /categories/i })
    const cells = within(row).getAllByRole('cell').map(c => c.textContent)
    expect(cells[0]).toBe(String(cats.length)) // in backup
    expect(cells[1]).toBe('0') // new rows
    expect(cells[2]).toBe('1') // conflicts, local row kept
  })
})

// A passphrase made of plain words, obviously not anyone's real one.
const PASS = 'quokka lantern pebble tuesday'
const field = (name: RegExp) => screen.getByLabelText(name) as HTMLInputElement
const type = (name: RegExp, value: string) => fireEvent.change(field(name), { target: { value } })
const PASS_LABEL = /^passphrase$/i
const AGAIN_LABEL = /type the passphrase again/i
const DOWNLOAD_ENCRYPTED = /download encrypted backup/i

/** Stubs the download so nothing is written to disk, and records what was offered. */
function captureDownload() {
  const seen: { blob?: Blob; name?: string; created: number } = { created: 0 }
  Object.defineProperty(URL, 'createObjectURL', { value: (b: Blob) => { seen.blob = b; seen.created++; return 'blob:fake-enc' }, configurable: true, writable: true })
  Object.defineProperty(URL, 'revokeObjectURL', { value: () => {}, configurable: true, writable: true })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { seen.name = this.download })
  return seen
}

describe('Settings encrypted backup download', () => {
  it('says before any download that a forgotten passphrase means nobody can open the backup', () => {
    render(<Settings />)
    const noteEl = screen.getAllByRole('note').find(n => /forget/i.test(n.textContent ?? ''))!
    const warning = noteEl.textContent ?? ''
    expect(warning).toMatch(/opens only with the passphrase you choose now/i)
    expect(warning).toMatch(/does not keep your passphrase and cannot recover it/i)
    expect(warning).toMatch(/nobody can open that backup/i)
    // Above the fields, and shown with no download behind it: there is no stored "already seen it" flag to hide it.
    expect(noteEl.compareDocumentPosition(field(PASS_LABEL)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(localStorage.length + sessionStorage.length).toBe(0)
  })

  it('asks for the passphrase twice and downloads nothing until both match and are long enough', async () => {
    const seen = captureDownload()
    render(<Settings />)
    const attempts: Array<[string, string, 'too-short' | 'mismatch' | 'edge-space']> = [
      ['short one', 'short one', 'too-short'],
      [PASS, `${PASS} x`, 'mismatch'],
      [` ${PASS}`, ` ${PASS}`, 'edge-space'],
    ]
    for (const [a, b, why] of attempts) {
      type(PASS_LABEL, a); type(AGAIN_LABEL, b)
      click(DOWNLOAD_ENCRYPTED)
      await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(PASSPHRASE_MESSAGES[why]))
      expect(field(PASS_LABEL)).toHaveAttribute('aria-invalid', 'true')
      expect(document.activeElement).toBe(why === 'mismatch' ? field(AGAIN_LABEL) : field(PASS_LABEL))
      expect(backup.exportBundle).not.toHaveBeenCalled()
      expect(seen.created).toBe(0)
    }
    type(PASS_LABEL, PASS); type(AGAIN_LABEL, PASS)
    click(DOWNLOAD_ENCRYPTED)
    expect(await screen.findByRole('status')).toHaveTextContent(/encrypted backup was downloaded/i)
    expect(seen.created).toBe(1)
    expect(screen.queryByRole('alert')).toBeNull()
  }, 20000)

  it('downloads an encrypted file that opens with the passphrase and restores to the same data', async () => {
    const seen = captureDownload()
    render(<Settings />)
    type(PASS_LABEL, PASS); type(AGAIN_LABEL, PASS)
    click(DOWNLOAD_ENCRYPTED)
    await screen.findByRole('status')
    expect(screen.getAllByRole('note').some(n => /nobody can open that backup/i.test(n.textContent ?? ''))).toBe(true) // still said after a download: every time, no flag
    expect(seen.name).toMatch(/^finance-backup-\d{4}-\d{2}-\d{2}-encrypted\.json$/)
    const text = await readBlob(seen.blob!)
    expect(text).not.toContain(PASS)
    expect(text).not.toContain('"schemaVersion"') // nothing but the envelope header is in clear
    const file = backupFile.readBackupFile(text)
    expect(file.kind).toBe('encrypted')
    if (file.kind !== 'encrypted') return
    const opened = await backupFile.openEncryptedBackup(file.envelope, PASS)
    expect(opened.ok).toBe(true)
    if (!opened.ok) return
    const bundle = opened.bundle as { tables: Record<string, unknown[]> }
    const now = await backup.exportBundle()
    expect(bundle.tables).toEqual(now.tables)
    // And it is a bundle the existing restore accepts: empty a table, replace from the opened file, the rows are back.
    const before = await db.categories.count()
    expect(before).toBeGreaterThan(0)
    await db.categories.clear()
    const report = await backup.restoreBundle(opened.bundle, 'replace')
    expect(report.ok).toBe(true)
    expect(await db.categories.count()).toBe(before)
  }, 20000)

  it('still offers the plain backup, labelled as not encrypted, with its warning', () => {
    render(<Settings />)
    const plain = screen.getByRole('button', { name: /download plain backup \(not encrypted\)/i })
    expect((plain.previousElementSibling as HTMLElement).textContent).toMatch(/not encrypted: anyone who gets this file can read it/i)
    // The encrypted one is the primary button; the storage note names it.
    expect(screen.getByRole('button', { name: DOWNLOAD_ENCRYPTED })).toHaveClass('btn-primary')
    expect(plain).not.toHaveClass('btn-primary')
    expect(screen.getAllByRole('note')[0]).toHaveTextContent(/download the encrypted backup instead/i)
  })

  it('leaves no trace of the passphrase in storage, the URL, the console or the fields afterwards', async () => {
    const seen = captureDownload()
    const spies = (['log', 'info', 'warn', 'error'] as const).map(k => vi.spyOn(console, k).mockImplementation(() => {}))
    render(<Settings />)
    expect(field(PASS_LABEL)).not.toHaveAttribute('name')
    expect(field(AGAIN_LABEL)).not.toHaveAttribute('name')
    expect(field(PASS_LABEL)).toHaveAttribute('type', 'password')
    expect(field(PASS_LABEL)).toHaveAttribute('autocomplete', 'new-password')
    expect(field(AGAIN_LABEL)).toHaveAttribute('autocomplete', 'new-password')
    type(PASS_LABEL, PASS); type(AGAIN_LABEL, PASS)
    click(DOWNLOAD_ENCRYPTED)
    await screen.findByRole('status')
    expect(seen.created).toBe(1)
    expect(field(PASS_LABEL).value).toBe('')
    expect(field(AGAIN_LABEL).value).toBe('')
    expect(field(PASS_LABEL)).not.toHaveAttribute('name')
    expect(field(AGAIN_LABEL)).not.toHaveAttribute('name')
    const stored = JSON.stringify([
      await Promise.all(db.tables.map(async t => [t.name, await t.toArray()])),
      { ...localStorage }, { ...sessionStorage },
    ])
    expect(stored.length).toBeGreaterThan(1000) // a search over an empty dump would pass on anything
    expect(stored).not.toContain('quokka')
    expect(location.href).not.toContain('quokka')
    expect(document.body.innerHTML).not.toContain('quokka')
    for (const spy of spies) expect(JSON.stringify(spy.mock.calls)).not.toContain('quokka')
  }, 20000)

  it('keeps focus and is not left busy when encryption fails', async () => {
    const seen = captureDownload()
    vi.mocked(backup.exportBundle).mockRejectedValueOnce(new Error('IDBKeyRange: DataError at table transactions'))
    render(<Settings />)
    type(PASS_LABEL, PASS); type(AGAIN_LABEL, PASS)
    const button = () => screen.getByRole('button', { name: /download encrypted backup|making the backup/i })
    button().focus()
    click(DOWNLOAD_ENCRYPTED)
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/encrypted backup could not be created.*Nothing on this device was changed/)
    expect(alert).not.toHaveTextContent(/IDB|DataError|transactions/)
    await waitFor(() => expect(button()).toHaveAttribute('aria-disabled', 'false'))
    expect(document.activeElement).toBe(button())
    expect(field(PASS_LABEL).value).toBe('') // cleared even on failure
    expect(seen.created).toBe(0)
    // Usable again: the same controls work without reloading.
    type(PASS_LABEL, PASS); type(AGAIN_LABEL, PASS)
    click(DOWNLOAD_ENCRYPTED)
    await screen.findByRole('status')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(seen.created).toBe(1)
  }, 20000)

  it('uses no causal, shaming or jargon wording in the new copy, and none of the engine terms', async () => {
    captureDownload()
    const states: Record<string, string> = {}
    const say = () => appSpoken(document.body)
    render(<Settings />)
    states['form and warning'] = say()
    type(PASS_LABEL, 'short'); type(AGAIN_LABEL, 'short')
    click(DOWNLOAD_ENCRYPTED)
    await screen.findByRole('alert')
    states['too short'] = say()
    type(PASS_LABEL, PASS); type(AGAIN_LABEL, `${PASS}!`)
    click(DOWNLOAD_ENCRYPTED)
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(PASSPHRASE_MESSAGES.mismatch))
    states['mismatch'] = say()
    vi.mocked(backup.exportBundle).mockRejectedValueOnce(new Error('boom'))
    type(PASS_LABEL, PASS); type(AGAIN_LABEL, PASS)
    click(DOWNLOAD_ENCRYPTED)
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/could not be created/))
    await waitFor(() => expect(screen.getByRole('button', { name: DOWNLOAD_ENCRYPTED })).toHaveAttribute('aria-disabled', 'false'))
    states['failed'] = say()
    type(PASS_LABEL, PASS); type(AGAIN_LABEL, PASS)
    click(DOWNLOAD_ENCRYPTED)
    await screen.findByRole('status')
    states['downloaded'] = say()
    expect(Object.keys(states)).toHaveLength(5)
    for (const [state, said] of Object.entries(states)) {
      expect(said, state).toMatch(/passphrase/i) // a scan over a page without the new copy proves nothing
      expect(violations(said), state).toEqual([])
      expect(said, state).not.toMatch(/\b(AES|PBKDF2|salt|IV|decrypt\w*|authentication tag)\b/i)
    }
  }, 20000)
})

describe('Settings restore of an encrypted backup', () => {
  const OPEN_LABEL = /passphrase for this backup/i
  const OPEN_BUTTON = /open backup/i

  /** The text of an encrypted file made from the current database, the way the download makes it (one derivation). */
  async function encryptedText(edit?: (bundle: Awaited<ReturnType<typeof backup.exportBundle>>) => void) {
    const bundle = await backup.exportBundle()
    edit?.(bundle)
    return encryptBundle(bundle, PASS)
  }
  /** A well-formed envelope that was never sealed with anything: enough to reach the passphrase step with no derivation. */
  const sealedNothing = (version = 1) => JSON.stringify({
    format: 'finance-encrypted', version, kdf: 'PBKDF2-SHA-256', iterations: 600000, cipher: 'AES-256-GCM',
    salt: btoa('0123456789abcdef'), iv: btoa('0123456789ab'), data: btoa('0123456789abcdef0123'),
  })
  const reachPassphraseStep = async (text: string) => {
    pick(fileOf(text))
    return (await screen.findByLabelText(OPEN_LABEL)) as HTMLInputElement
  }

  it('asks for a passphrase for an encrypted file, and shows the dry run once it opens', async () => {
    const text = await encryptedText()
    render(<Settings />)
    const input = await reachPassphraseStep(text)
    expect(input).toHaveAttribute('type', 'password')
    expect(input).toHaveAttribute('autocomplete', 'current-password')
    expect(input).not.toHaveAttribute('name')
    expect(document.activeElement).toBe(input)
    // Choosing the file opens nothing: no attempt with an empty passphrase, no message, no preview.
    expect(backupFile.openEncryptedBackup).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(backup.inspectBundle).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: PASS } })
    click(OPEN_BUTTON)
    expect(await screen.findByRole('table', REPORT)).toBeTruthy()
    expect(backupFile.openEncryptedBackup).toHaveBeenCalledTimes(1)
    expect(backup.inspectBundle).toHaveBeenCalledTimes(1)
    expect(vi.mocked(backup.inspectBundle).mock.calls[0]![1]).toBe('merge')
    expect(screen.queryByLabelText(OPEN_LABEL)).toBeNull() // the field is gone once the file is open
  }, 20000)

  it('writes nothing until confirm, exactly as for a plain file', async () => {
    const text = await encryptedText()
    await db.categories.clear() // so the backup has rows this device does not
    await db.analyticsCache.add({ key: 'k', engineVersion: 1, inputsHash: 'h', computedAt: 1, payload: { shape: 1, value: 'k' } })
    render(<Settings />)
    fireEvent.change(await reachPassphraseStep(text), { target: { value: PASS } })
    click(OPEN_BUTTON)
    await screen.findByRole('table', REPORT)
    expect(await db.categories.count()).toBe(0)
    expect(await db.analyticsCache.count()).toBe(1)
    expect(backup.restoreBundle).not.toHaveBeenCalled()
    // The preview holds the opened backup and not the passphrase: confirming asks for nothing more and nothing shows it.
    expect(document.body.innerHTML).not.toContain('quokka')
    click(/confirm merge/i)
    expect((await screen.findByRole('status')).textContent).toMatch(/restore finished/i)
    expect(backup.restoreBundle).toHaveBeenCalledTimes(1)
    expect(vi.mocked(backup.restoreBundle).mock.calls[0]![0]).toBe(vi.mocked(backup.inspectBundle).mock.calls[0]![0]) // the previewed bundle
    expect(JSON.stringify(vi.mocked(backup.restoreBundle).mock.calls)).not.toContain('quokka')
    expect(await db.categories.count()).toBeGreaterThan(0)
    expect(await db.analyticsCache.count()).toBe(0) // any restore clears the remembered figures
    expect(document.body.innerHTML).not.toContain('quokka')
  }, 20000)

  it('shows one message for a wrong passphrase or a damaged file, claims neither, and lets the owner try again', async () => {
    const text = await encryptedText()
    render(<Settings />)
    const input = await reachPassphraseStep(text)
    fireEvent.change(input, { target: { value: 'not the one that was used' } })
    click(OPEN_BUTTON)
    const wrong = (await screen.findByRole('alert')).textContent ?? ''
    expect(wrong).toMatch(/passphrase may differ/i)
    expect(wrong).toMatch(/file may have changed or been damaged/i)
    expect(wrong).toMatch(/cannot tell which/i)
    expect(wrong).toMatch(/nothing was changed/i)
    expect(wrong).not.toMatch(/wrong passphrase|corrupt/i)
    expect(backup.inspectBundle).not.toHaveBeenCalled()
    // Usable again without choosing the file again.
    await waitFor(() => expect(screen.getByRole('button', { name: OPEN_BUTTON })).toHaveAttribute('aria-disabled', 'false'))
    fireEvent.change(screen.getByLabelText(OPEN_LABEL), { target: { value: PASS } })
    click(OPEN_BUTTON)
    await screen.findByRole('table', REPORT)
    expect(screen.queryByRole('alert')).toBeNull()
    // The right passphrase with a changed file gives the very same message: the two cannot be told apart, so none is claimed.
    const parsed = JSON.parse(text) as { data: string }
    const changed = JSON.stringify({ ...parsed, data: `${parsed.data[0] === 'A' ? 'B' : 'A'}${parsed.data.slice(1)}` })
    fireEvent.change(await reachPassphraseStep(changed), { target: { value: PASS } })
    click(OPEN_BUTTON)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(wrong))
    expect(screen.queryByRole('table', REPORT)).toBeNull()
  }, 20000)

  it('asks for no passphrase for a file from a newer version, and says to update the app', async () => {
    render(<Settings />)
    pick(fileOf(sealedNothing(2)))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/newer version of the app/i)
    expect(alert.textContent).toMatch(/update the app/i)
    expect(alert.textContent).toMatch(/nothing was changed/i)
    expect(screen.queryByLabelText(OPEN_LABEL)).toBeNull()
    expect(screen.queryByRole('button', { name: OPEN_BUTTON })).toBeNull()
    expect(backupFile.openEncryptedBackup).not.toHaveBeenCalled()
    expect(backup.inspectBundle).not.toHaveBeenCalled()
  })

  it('refuses a merge of an encrypted backup from another installation, and points to replace', async () => {
    await getSettings()
    const text = await encryptedText(bundle => {
      const rows = bundle.tables['settings'] as Array<{ privacy: { accountSalt: string } }>
      rows[0]!.privacy.accountSalt = 'a-different-installation'
    })
    const before = await db.categories.count()
    render(<Settings />)
    fireEvent.change(await reachPassphraseStep(text), { target: { value: PASS } })
    click(OPEN_BUTTON)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('salt-mismatch')
    expect(alert.textContent).toMatch(/use replace mode to restore it/i)
    expect(screen.queryByRole('button', { name: /confirm/i })).toBeNull()
    expect(backup.restoreBundle).not.toHaveBeenCalled()
    expect(await db.categories.count()).toBe(before)
  }, 20000)

  it('says that closing the page before it finishes changes nothing', async () => {
    const text = await encryptedText()
    render(<Settings />)
    fireEvent.change(await reachPassphraseStep(text), { target: { value: PASS } })
    click(OPEN_BUTTON)
    await screen.findByRole('table', REPORT)
    const confirmButton = screen.getByRole('button', { name: /confirm merge/i })
    const line = confirmButton.parentElement!.previousElementSibling as HTMLElement // the line sits right above the buttons
    expect(line.textContent).toMatch(/close this page before the restore finishes, nothing is changed/i)
  }, 20000)

  it('discards an opened backup when the mode changes, so a merge preview never confirms a replace', async () => {
    // Before it is opened: the file waiting for its passphrase goes away.
    render(<Settings />)
    await reachPassphraseStep(sealedNothing())
    choose(/replace/i)
    expect(screen.queryByLabelText(OPEN_LABEL)).toBeNull()
    expect(screen.queryByRole('button', { name: OPEN_BUTTON })).toBeNull()
    // After it is opened: the preview goes away and nothing can confirm.
    const bundle = await backup.exportBundle()
    vi.mocked(backupFile.openEncryptedBackup).mockResolvedValueOnce({ ok: true, bundle })
    fireEvent.change(await reachPassphraseStep(sealedNothing()), { target: { value: PASS } })
    click(OPEN_BUTTON)
    await screen.findByRole('table', REPORT)
    choose(/merge/i)
    expect(screen.queryByRole('table', REPORT)).toBeNull()
    expect(screen.queryByRole('button', { name: /confirm/i })).toBeNull()
    expect(screen.queryByLabelText(OPEN_LABEL)).toBeNull()
    expect(backup.restoreBundle).not.toHaveBeenCalled()
  })

  it('does not show a preview for an open that finishes after the owner has moved on', async () => {
    let release!: (r: { ok: true; bundle: unknown }) => void
    vi.mocked(backupFile.openEncryptedBackup).mockImplementationOnce(() => new Promise(r => { release = r }))
    render(<Settings />)
    fireEvent.change(await reachPassphraseStep(sealedNothing()), { target: { value: PASS } })
    click(OPEN_BUTTON)
    await waitFor(() => expect(backupFile.openEncryptedBackup).toHaveBeenCalledTimes(1))
    choose(/replace/i) // the owner moves on while the open is still running
    await act(async () => { release({ ok: true, bundle: await backup.exportBundle() }) })
    expect(backup.inspectBundle).not.toHaveBeenCalled()
    expect(screen.queryByRole('table', REPORT)).toBeNull()
    expect(screen.queryByRole('button', { name: /confirm/i })).toBeNull()
  })

  it('keeps focus on the passphrase field after a failed attempt, and clears it', async () => {
    render(<Settings />)
    const input = await reachPassphraseStep(sealedNothing())
    fireEvent.change(input, { target: { value: PASS } })
    click(OPEN_BUTTON)
    await screen.findByRole('alert')
    await waitFor(() => expect(screen.getByRole('button', { name: OPEN_BUTTON })).toHaveAttribute('aria-disabled', 'false'))
    expect(screen.getByLabelText(OPEN_LABEL)).toBe(input) // the same field, still there
    expect(input.value).toBe('')
    expect(document.activeElement).toBe(input)
    expect(document.body.innerHTML).not.toContain('quokka')
  }, 20000)

  it('uses no causal, shaming or jargon wording in the new restore copy, and none of the engine terms', async () => {
    const states: Record<string, string> = {}
    const say = () => appSpoken(document.body)
    render(<Settings />)
    const input = await reachPassphraseStep(sealedNothing())
    states['asking for the passphrase'] = say()
    fireEvent.change(input, { target: { value: PASS } })
    click(OPEN_BUTTON)
    await screen.findByRole('alert')
    states['could not be opened'] = say()
    pick(fileOf(sealedNothing(2)))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/newer version/i))
    states['newer version'] = say()
    const bundle = await backup.exportBundle()
    vi.mocked(backupFile.openEncryptedBackup).mockResolvedValueOnce({ ok: true, bundle })
    fireEvent.change(await reachPassphraseStep(sealedNothing()), { target: { value: PASS } })
    click(OPEN_BUTTON)
    await screen.findByRole('table', REPORT)
    states['preview'] = say()
    expect(states['preview']).toMatch(/close this page before the restore finishes/i)
    expect(states['asking for the passphrase']).toMatch(/This backup is encrypted/)
    for (const [state, said] of Object.entries(states)) {
      expect(violations(said), state).toEqual([])
      expect(said, state).not.toMatch(/\b(AES|PBKDF2|salt|IV|decrypt\w*|authentication tag)\b/i)
    }
  }, 20000)
})

describe('Settings accounts and privacy (spec 39.1, 14.1)', () => {
  const account = (id: string, label: string, last4: string | null, createdAt: number) =>
    ({ id, fingerprint: createdAt.toString(16).repeat(64), label, last4, currency: 'EUR', createdAt, archived: false })

  it('turns storeLast4 off and relabels existing accounts', async () => {
    await db.accounts.bulkAdd([
      account('acc.a', 'Cuenta 1234', '1234', 1), // the automatic label spells the digits out
      account('acc.b', 'Nómina', '5678', 2), // the owner's own name stays theirs
      account('acc.c', 'Cuenta 1', null, 3), // already without digits; never touched
    ])
    render(<Settings />)
    const toggle = await screen.findByRole('switch', { name: /last four digits/i })
    expect(toggle).toBeChecked()
    fireEvent.click(toggle)
    expect(await screen.findByText(/removed from 2 accounts/)).toBeInTheDocument()
    // The notice appears partway through: the toggle then re-reads the accounts, which is what rewrites the name
    // fields below. Without this wait the "Cuenta 1234 is gone" assertion at the end of this test passes only if the
    // reload happens to have landed during the awaits above — true today, by luck, and not a thing to rely on.
    await waitFor(() => expect(screen.getByRole('switch', { name: /last four digits/i })).toBeEnabled())

    expect((await getSettings()).privacy.storeLast4).toBe(false)
    const rows = Object.fromEntries((await db.accounts.toArray()).map((a) => [a.id, a]))
    // CLEARED, not merely no longer written: a flag that only stopped new writes would leave these on screen and in every backup.
    expect(rows['acc.a']).toMatchObject({ last4: null, label: 'Cuenta 2' }) // numbered by position, and never onto a label in use
    expect(rows['acc.b']).toMatchObject({ last4: null, label: 'Nómina' })
    expect(rows['acc.c']).toMatchObject({ last4: null, label: 'Cuenta 1' })
    expect(screen.queryByDisplayValue('Cuenta 1234')).toBeNull()
    expect(screen.getByRole('switch', { name: /last four digits/i })).not.toBeChecked()
  })

  it('leaves everything as it was when the write fails, and says so', async () => {
    await db.accounts.add(account('acc.a', 'Cuenta 1234', '1234', 1))
    vi.spyOn(db.accounts, 'update').mockRejectedValueOnce(new Error('disk full'))
    render(<Settings />)
    fireEvent.click(await screen.findByRole('switch', { name: /last four digits/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent('disk full')
    // One transaction: the flag did not change either.
    expect((await getSettings()).privacy.storeLast4).toBe(true)
    expect((await db.accounts.get('acc.a'))?.last4).toBe('1234')
  })

  it('accepts an owner-chosen account label and refuses one that looks like an account number', async () => {
    await db.accounts.add(account('acc.a', 'Cuenta 1234', '1234', 1))
    render(<Settings />)
    const field = await screen.findByLabelText('Name for account 1')
    fireEvent.change(field, { target: { value: '  Cuenta nómina ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }))
    expect(await screen.findByText('Saved.')).toBeInTheDocument()
    expect((await db.accounts.get('acc.a'))?.label).toBe('Cuenta nómina')
    // A successful rename reloads the accounts above this field, which rewrites the field from the stored row. Waiting
    // for it is not only hygiene: it pins that the field ends up showing the name the database actually kept, trimmed,
    // rather than the untrimmed text that was typed. Without the wait that reload lands after the test has finished.
    await waitFor(() => expect(field).toHaveValue('Cuenta nómina'))

    // The guard's own wording, read from the guard itself rather than copied: there is one rule and it is not repeated here.
    const guardMessage = await db.accounts.update('acc.a', { label: '9999 0418 4502 0005 1332' }).then(() => '', (e: Error) => e.message)
    expect(guardMessage).toMatch(/looks like an account number/)
    for (const shaped of ['9999 0418 4502 0005 1332', 'ES00 9999 0418 4502 0005 1332', '999904184502000513']) {
      fireEvent.change(field, { target: { value: shaped } })
      fireEvent.click(screen.getByRole('button', { name: 'Save name' }))
      expect(await screen.findByRole('alert')).toHaveTextContent(guardMessage)
      expect((await db.accounts.get('acc.a'))?.label).toBe('Cuenta nómina')
      // The refusal is shown before the form has finished: it clears `busy` afterwards. Waiting for the button to come
      // back settles that update and pins that a refused save leaves the form usable instead of stuck disabled.
      await waitFor(() => expect(screen.getByRole('button', { name: 'Save name' })).toBeEnabled())
    }
    // An empty name is not a name. That is the only thing this screen decides for itself.
    fireEvent.change(field, { target: { value: '   ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Give the account a name.')
    expect((await db.accounts.get('acc.a'))?.label).toBe('Cuenta nómina')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save name' })).toBeEnabled())
    // The screen reloads its accounts fire-and-forget after a rename (`onRenamed={() => { void load() }}`), so past
    // the waits above there is no further visible change to key on. This flushes what is still in flight under act(),
    // which is the supported way to settle it. Used here only because the component gives nothing else to await —
    // everywhere else in this file the wait is on something the owner would actually see.
    await act(async () => {})
  })

  it('says plainly that a name the owner typed keeps its digits, and that the guard speaks to the owner', async () => {
    await db.accounts.add(account('acc.a', 'Cuenta nómina 5566', '5566', 1))
    render(<Settings />)
    expect(await screen.findByText(/A name you typed yourself is left exactly as you wrote it/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('switch', { name: /last four digits/i }))
    await screen.findByText(/removed from 1 account/)
    // The notice appears partway through: the toggle then re-reads the accounts and clears `busy`. Waiting for the
    // switch to come back settles both, and pins that the control is usable again after the privacy change.
    await waitFor(() => expect(screen.getByRole('switch', { name: /last four digits/i })).toBeEnabled())
    // The digits in a typed label are the owner's to keep; only the stored last4 went.
    expect(await db.accounts.get('acc.a')).toMatchObject({ last4: null, label: 'Cuenta nómina 5566' })
    fireEvent.change(screen.getByLabelText('Name for account 1'), { target: { value: '9999 0418 4502 0005 1332' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('That name looks like an account number, so it was not used. Choose a plain name such as "Savings" or "Cuenta principal".')
  })

  it('has no account-number rule of its own', () => {
    for (const file of ['../../db/privacy.ts', 'Settings.tsx']) {
      const src = readFileSync(resolve(import.meta.dirname, file), 'utf8')
      expect(src).not.toMatch(/IBAN|\\d\{12|digitCount|LONG_DIGITS/)
    }
  })
})

describe('Settings recalculate figures (spec 7.1)', () => {
  const tx = (id: string) => ({
    id, accountId: 'acc.a', valueDate: '2026-03-01', amountCents: -1250, balanceCents: 10000, description: `Shop ${id}`, comment: null,
    ingCategory: null, ingSubcategory: null, kind: 'expense', dedupKey: `dk-${id}`, importId: 'imp.1', fileSeq: 1,
    roundupParentId: null, createdAt: 5, deletedAt: null,
  })
  const note = (transactionId: string) => ({
    transactionId, categoryId: null, subcategoryId: null, merchantId: null, typeOverride: null, paymentMethod: null,
    note: 'bought on impulse', moodId: null, purchaseReasonId: null, worthwhile: true, reviewed: true, dateOverride: null,
    amountCentsOverride: null, descriptionOverride: 'My own words', updatedAt: 77,
  })
  const figure = (key: string) => ({ key, engineVersion: 1, inputsHash: 'h', computedAt: 1, payload: { shape: 1, value: key } })
  const button = () => screen.getByRole('button', { name: /recalculate figures|recalculating/i })

  async function seedOwnerData() {
    await db.transactions.bulkAdd([tx('t1'), tx('t2')] as never)
    await db.annotations.bulkAdd([note('t1'), note('t2')] as never)
    await db.learningEvents.bulkAdd([
      { id: 'e1', at: 10, type: 'merchant_named', payload: { merchant: 'Bakery' }, outcome: null },
      { id: 'e2', at: 20, type: 'merchant_named', payload: { merchant: 'Bike shop' }, outcome: 'improved' },
    ] as never)
    await db.analyticsCache.bulkAdd([figure('a'), figure('b'), figure('c')])
  }
  const durable = async () => JSON.stringify([
    await db.transactions.orderBy('id').toArray(), await db.annotations.orderBy('transactionId').toArray(), await db.learningEvents.orderBy('id').toArray(),
  ])

  it('rebuilds the analytics and says how many figures were cleared', async () => {
    await seedOwnerData()
    render(<Settings />)
    fireEvent.click(button())
    expect(await screen.findByText(/3 remembered figures were cleared/)).toBeInTheDocument()
    await waitFor(() => expect(button()).toHaveAttribute('aria-disabled', 'false'))
    expect(await db.analyticsCache.count()).toBe(0)
  })

  it('says so, rather than staying silent, when there was nothing to clear', async () => {
    render(<Settings />)
    fireEvent.click(button())
    expect(await screen.findByText(/No figures were remembered/)).toBeInTheDocument()
    await waitFor(() => expect(button()).toHaveAttribute('aria-disabled', 'false'))
  })

  it('touches no transaction, annotation or learning event when it rebuilds', async () => {
    await seedOwnerData()
    // A vacuous pass is the risk: prove the fixture really holds rows in all three tables first.
    expect(await db.transactions.count()).toBe(2)
    expect(await db.annotations.count()).toBe(2)
    expect(await db.learningEvents.count()).toBe(2)
    const before = await durable()
    render(<Settings />)
    fireEvent.click(button())
    await screen.findByText(/3 remembered figures were cleared/)
    await waitFor(() => expect(button()).toHaveAttribute('aria-disabled', 'false'))
    expect(await durable()).toBe(before) // full contents, not counts
  })

  it('says what the action is for, without jargon', async () => {
    render(<Settings />)
    const heading = screen.getByRole('heading', { name: /recalculate figures/i })
    const text = [heading.nextElementSibling, heading.nextElementSibling?.nextElementSibling].map(e => e?.textContent ?? '').join(' ')
    expect(text).toMatch(/in case a figure ever looks wrong or out of date/)
    expect(text).toMatch(/Nothing you entered is touched/)
    // It used to offer "a figure still shows an old name after you renamed a mood, a reason, a category or a merchant".
    // There is no screen that renames any of those, so the copy must not send the owner looking for one.
    expect(text).not.toMatch(/renam/i)
    expect(text).not.toMatch(/cache|digest|engine|version|invalidat|hash/i)
    fireEvent.click(button())
    const status = await screen.findByRole('status')
    expect(status.textContent).not.toMatch(/cache|digest|engine|version|invalidat|hash/i)
    await waitFor(() => expect(button()).toHaveAttribute('aria-disabled', 'false'))
  })

  it('keeps focus on the control and does not leave it stuck busy', async () => {
    await seedOwnerData()
    let release!: (n: number) => void
    const gate = new Promise<number>(r => { release = r })
    const toCollection = vi.spyOn(db.analyticsCache, 'toCollection')
    toCollection.mockImplementationOnce((() => ({ delete: () => gate })) as never)
    render(<Settings />)
    button().focus()
    fireEvent.click(button())
    await waitFor(() => expect(button()).toHaveAttribute('aria-disabled', 'true'))
    expect(button()).not.toBeDisabled()
    expect(document.activeElement).toBe(button())
    fireEvent.click(button()) // a second press while busy is ignored
    expect(toCollection).toHaveBeenCalledTimes(1)
    release(3)
    await screen.findByText(/3 remembered figures were cleared/)
    await waitFor(() => expect(button()).toHaveAttribute('aria-disabled', 'false'))
    expect(document.activeElement).toBe(button())

    // A failure must not strand the control either, and must say nothing was changed.
    toCollection.mockImplementationOnce((() => ({ delete: () => Promise.reject(new Error('IDB boom')) })) as never)
    fireEvent.click(button())
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/could not be recalculated.*Nothing you entered was changed/)
    expect(alert).not.toHaveTextContent(/IDB|boom/)
    await waitFor(() => expect(button()).toHaveAttribute('aria-disabled', 'false'))
    fireEvent.click(button()) // and it works again; the spied runs never deleted anything, so the three rows are still there
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    await screen.findByText(/3 remembered figures were cleared/)
    expect(await db.analyticsCache.count()).toBe(0)
    await waitFor(() => expect(button()).toHaveAttribute('aria-disabled', 'false'))
  })
})
