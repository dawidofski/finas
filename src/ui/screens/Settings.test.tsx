import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, within, fireEvent, act } from '@testing-library/react'
import Settings from './Settings'
import { db } from '../../db/db'
import { seedDatabase, getSettings } from '../../db/seed'
import * as backup from '../../db/backup'
import { guardWording } from '../../test/wording'

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

const REPORT = { name: /what this restore would do/i }

beforeEach(async () => {
  await db.delete()
  await db.open()
  await seedDatabase()
  vi.mocked(backup.inspectBundle).mockClear()
  vi.mocked(backup.restoreBundle).mockClear()
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

const fileOf = (text: string, name = 'backup.json') => new File([text], name, { type: 'application/json' })
const pick = (file: File) => fireEvent.change(screen.getByLabelText(/backup file/i), { target: { files: [file] } })
const click = (name: RegExp) => fireEvent.click(screen.getByRole('button', { name }))
const choose = (name: RegExp) => fireEvent.click(screen.getByRole('radio', { name }))

async function validBundleText() {
  return JSON.stringify(await backup.exportBundle())
}

guardWording(10)

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
    click(/download backup/i)
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
    click(/download backup/i)
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
