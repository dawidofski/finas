import { readFileSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import Transactions, { PAGE_SIZE } from './Transactions'
import { db } from '../../db/db'
import { seedDatabase } from '../../db/seed'
import { formatEur } from '../../lib/money'
import { linkRefund } from '../../import/refunds'
import { categoryMemory, rememberedCategoryFor } from '../../learning/memory'
import { transactionRowReads } from '../../test/reads'
import { FILTERS_OPEN_KEY } from '../viewPrefs'
import type { AccountRow, TransactionRow } from '../../db/schema'
import { guardWording } from '../../test/wording'

const account = (id: string, label: string): AccountRow =>
  ({ id, fingerprint: id.padEnd(64, '0'), label, last4: null, currency: 'EUR', createdAt: 1, archived: false })

let seq = 0
const tx = (over: Partial<TransactionRow> = {}): TransactionRow => {
  seq++
  return {
    id: `tx${seq}`, accountId: 'acc1', valueDate: '2026-11-10', amountCents: -1250, balanceCents: 100000,
    description: `Invented shop ${seq}`, comment: null, ingCategory: null, ingSubcategory: null, kind: 'spend',
    dedupKey: `key${seq}`, importId: 'imp1', fileSeq: seq, roundupParentId: null, createdAt: 1, deletedAt: null, ...over,
  }
}

const GROCERIES = { ingCategory: 'Alimentación', ingSubcategory: 'Supermercados y alimentación' }

beforeEach(async () => {
  seq = 0
  await db.delete()
  await db.open()
  await seedDatabase()
  await db.accounts.bulkAdd([account('acc1', 'Cuenta 0001'), account('acc2', 'Cuenta 0002')])
})
afterEach(() => { vi.restoreAllMocks(); try { localStorage.clear() } catch { /* nothing to clear */ } })

const table = () => screen.findByRole('table', { name: 'Transactions' })
const dataRows = async () => within(await table()).getAllByRole('row').slice(1)
const descriptions = async () => (await dataRows()).map((r) => within(r).getByRole('button').textContent)
const rowOf = async (text: string) => {
  const row = (await dataRows()).find((r) => r.textContent?.includes(text))
  if (!row) throw new Error(`no row containing ${text}`)
  return row
}
const openEditor = async (text: string) => {
  fireEvent.click(within(await rowOf(text)).getByRole('button'))
  return screen.findByRole('dialog')
}
const change = (label: RegExp | string, value: string, root: HTMLElement | Document = document.body) =>
  fireEvent.change(within(root as HTMLElement).getByLabelText(label), { target: { value } })

guardWording(20, '.mood-label, .chip, .mood-btn')

describe('Transactions screen', () => {
  it('lists transactions newest first with resolved values', async () => {
    await db.transactions.bulkAdd([
      tx({ valueDate: '2026-11-08', description: 'Older day' }),
      // Same date: the LOWER fileSeq is the newer row, so it is listed first.
      tx({ valueDate: '2026-11-12', description: 'Same day, later in file', fileSeq: 9 }),
      tx({ valueDate: '2026-11-12', description: 'Same day, newer', fileSeq: 2 }),
    ])
    await db.annotations.add({
      transactionId: 'tx1', categoryId: null, subcategoryId: null, merchantId: null, typeOverride: null, paymentMethod: null,
      note: null, moodId: null, purchaseReasonId: null, worthwhile: null, reviewed: false, dateOverride: null,
      amountCentsOverride: null, descriptionOverride: 'Renamed by owner', updatedAt: 1,
    })
    render(<Transactions />)
    expect(await descriptions()).toEqual(['Same day, newer', 'Same day, later in file', 'Renamed by owner'])
  })

  it('shows an edited transaction with its override and marks it edited', async () => {
    await db.transactions.add(tx({ description: 'Bank wording', amountCents: -1000 }))
    await db.annotations.add({
      transactionId: 'tx1', categoryId: null, subcategoryId: null, merchantId: null, typeOverride: null, paymentMethod: null,
      note: null, moodId: null, purchaseReasonId: null, worthwhile: null, reviewed: false, dateOverride: null,
      amountCentsOverride: -2500, descriptionOverride: 'Owner wording', updatedAt: 1,
    })
    render(<Transactions />)
    const row = await rowOf('Owner wording')
    expect(row).toHaveTextContent(formatEur(-2500))
    expect(row).toHaveTextContent('Edited')
    expect(row).not.toHaveTextContent('Bank wording')
  })

  it('shows the derived category for a transaction the owner has not touched, and the owner choice once made', async () => {
    await db.transactions.add(tx({ ...GROCERIES, description: 'Untouched' }))
    render(<Transactions />)
    const row = await rowOf('Untouched')
    // §34.3: the inferred category is the category, labelled as inferred, and the row is not "edited".
    expect(row).toHaveTextContent('Supermercados y alimentación (from ING)')
    expect(row).not.toHaveTextContent('Edited')

    const dialog = await openEditor('Untouched')
    change(/^Category$/, 'cat.restaurants', dialog)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    const edited = await rowOf('Untouched')
    expect(edited).toHaveTextContent('Cafeterías y restaurantes')
    expect(edited).not.toHaveTextContent('(from ING)')
    expect(edited).toHaveTextContent('Edited')
  })

  it('searches description and merchant', async () => {
    await db.merchants.add({ id: 'm1', canonicalName: 'Panadería Invented', kind: 'merchant', matchPatterns: [], defaultCategoryId: null, isSubscription: false, createdAt: 1 })
    await db.transactions.bulkAdd([tx({ description: 'CAFETERIA CENTRAL' }), tx({ description: 'CARD PAYMENT 77' }), tx({ description: 'Other' })])
    await db.annotations.add({
      transactionId: 'tx2', categoryId: null, subcategoryId: null, merchantId: 'm1', typeOverride: null, paymentMethod: null,
      note: null, moodId: null, purchaseReasonId: null, worthwhile: null, reviewed: false, dateOverride: null,
      amountCentsOverride: null, descriptionOverride: null, updatedAt: 1,
    })
    render(<Transactions />)
    await table()
    change('Search', 'cafeteria') // accent-free and case-free
    expect(await descriptions()).toEqual(['CAFETERIA CENTRAL'])
    change('Search', 'panaderia') // by merchant, though the description does not contain it
    expect(await descriptions()).toEqual(['CARD PAYMENT 77'])
  })

  it('filters by account, category, kind and date range', async () => {
    await db.transactions.bulkAdd([
      tx({ description: 'A', accountId: 'acc1', valueDate: '2026-10-01', ...GROCERIES }),
      tx({ description: 'B', accountId: 'acc2', valueDate: '2026-11-05', ...GROCERIES }),
      tx({ description: 'C', accountId: 'acc1', valueDate: '2026-11-06', kind: 'income', amountCents: 5000 }),
      tx({ description: 'D', accountId: 'acc1', valueDate: '2026-11-20' }),
    ])
    render(<Transactions />)
    await table()
    change('Account', 'acc2')
    expect(await descriptions()).toEqual(['B'])
    change('Account', '')
    change('Category', 'cat.groceries')
    expect((await descriptions()).sort()).toEqual(['A', 'B'])
    change('Category', '')
    change('Kind', 'income')
    expect(await descriptions()).toEqual(['C'])
    change('Kind', '')
    change('From', '2026-11-01')
    change('To', '2026-11-10')
    expect((await descriptions()).sort()).toEqual(['B', 'C'])
  })

  it('sorts by date and by amount', async () => {
    await db.transactions.bulkAdd([
      tx({ description: 'Small', valueDate: '2026-11-01', amountCents: -100 }),
      tx({ description: 'Big', valueDate: '2026-11-02', amountCents: -9000 }),
      tx({ description: 'Pay', valueDate: '2026-11-03', amountCents: 200000, kind: 'income' }),
    ])
    render(<Transactions />)
    await table()
    expect(await descriptions()).toEqual(['Pay', 'Big', 'Small'])
    change('Order', 'oldest')
    expect(await descriptions()).toEqual(['Small', 'Big', 'Pay'])
    change('Order', 'spend')
    expect(await descriptions()).toEqual(['Big', 'Small', 'Pay'])
    change('Order', 'income')
    expect(await descriptions()).toEqual(['Pay', 'Small', 'Big'])
  })

  it('soft-deletes and restores without destroying the row', async () => {
    const original = tx({ description: 'Mistaken delete', ...GROCERIES })
    await db.transactions.bulkAdd([original, tx({ description: 'Keeper' })])
    render(<Transactions />)
    let dialog = await openEditor('Mistaken delete')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    // Only deletedAt moved; every bank value is still there.
    const stored = await db.transactions.get(original.id)
    expect(stored?.deletedAt).toEqual(expect.any(Number))
    expect({ ...stored, deletedAt: null }).toEqual(original)
    expect(await descriptions()).toEqual(['Keeper'])

    // Deleted rows can be found, which is the only route back from a mistaken delete (re-import will not resurrect them).
    change('Show', 'deleted')
    expect(await descriptions()).toEqual(['Mistaken delete'])
    dialog = await openEditor('Mistaken delete')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(await db.transactions.get(original.id)).toEqual(original)
    expect(await db.annotations.count()).toBe(0)
    change('Show', 'active')
    expect((await descriptions()).sort()).toEqual(['Keeper', 'Mistaken delete'])
  })

  it('offers Undo straight after a delete', async () => {
    const original = tx({ description: 'Oops' })
    await db.transactions.add(original)
    render(<Transactions />)
    const dialog = await openEditor('Oops')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }))
    await waitFor(async () => expect((await db.transactions.get(original.id))?.deletedAt).toBeNull())
    expect(await db.transactions.get(original.id)).toEqual(original)
  })

  it('writes every edit through writeAnnotation', async () => {
    const original = tx({ description: 'Edit me', ...GROCERIES })
    await db.transactions.add(original)
    const update = vi.spyOn(db.transactions, 'update')
    const put = vi.spyOn(db.transactions, 'put')
    render(<Transactions />)
    const dialog = await openEditor('Edit me')
    change('Description', 'Renamed', dialog)
    change('Note', 'for the party', dialog)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    expect(update).not.toHaveBeenCalled()
    expect(put).not.toHaveBeenCalled()
    expect(await db.transactions.get(original.id)).toEqual(original) // the bank row is untouched
    const ann = await db.annotations.get(original.id)
    expect(ann).toMatchObject({ descriptionOverride: 'Renamed', note: 'for the party' })
  })

  it('emits one learning event per changed field on a multi-field save, in one write', async () => {
    await db.transactions.add(tx({ description: 'Multi', ...GROCERIES }))
    const bulkAdd = vi.spyOn(db.learningEvents, 'bulkAdd')
    render(<Transactions />)
    const dialog = await openEditor('Multi')
    change('Description', 'Renamed', dialog)
    change('Note', 'a note', dialog)
    change('Amount in euros', '-20,50', dialog)
    change(/^Category$/, 'cat.restaurants', dialog)
    change('Date', '2026-11-11', dialog)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    expect(bulkAdd).toHaveBeenCalledTimes(1) // one transaction, not one per field
    const events = await db.learningEvents.toArray()
    expect(events.map((e) => e.type).sort()).toEqual(['amount', 'category', 'date', 'description', 'note'])
    expect(await db.annotations.get('tx1')).toMatchObject({
      descriptionOverride: 'Renamed', note: 'a note', amountCentsOverride: -2050, categoryId: 'cat.restaurants', dateOverride: '2026-11-11',
    })
  })

  it('emits nothing for a save that changes nothing, and refuses an unreadable amount without writing', async () => {
    await db.transactions.add(tx({ description: 'Quiet' }))
    render(<Transactions />)
    let dialog = await openEditor('Quiet')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    // Nothing about the transaction changed, and no learning event is written. The one thing recorded is that it was looked at.
    const quiet = await db.annotations.toArray()
    expect(quiet).toHaveLength(1)
    expect(quiet[0]).toMatchObject({ reviewed: true, categoryId: null, merchantId: null, note: null, amountCentsOverride: null, descriptionOverride: null })
    expect(await db.learningEvents.count()).toBe(0)

    dialog = await openEditor('Quiet')
    change('Amount in euros', 'twelve', dialog)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/amount/i)
    expect((await db.annotations.toArray())[0]?.amountCentsOverride).toBeNull()
  })

  it('puts a field back to the bank value by clearing its override', async () => {
    await db.transactions.add(tx({ description: 'Bank text' }))
    render(<Transactions />)
    let dialog = await openEditor('Bank text')
    change('Description', 'Mine', dialog)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    dialog = await openEditor('Mine')
    change('Description', 'Bank text', dialog)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect((await db.annotations.get('tx1'))?.descriptionOverride).toBeNull()
  })

  it('closes the editor on Escape and returns focus to the row that opened it', async () => {
    await db.transactions.add(tx({ description: 'Focus me' }))
    render(<Transactions />)
    const button = within(await rowOf('Focus me')).getByRole('button')
    fireEvent.click(button)
    const dialog = await screen.findByRole('dialog')
    expect(dialog.contains(document.activeElement)).toBe(true)
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(within(screen.getByRole('table')).getByRole('button', { name: 'Focus me' })))
  })

  it('formats every amount through formatEur', async () => {
    await db.transactions.bulkAdd([tx({ description: 'Rent', amountCents: -123456 }), tx({ description: 'Pay', amountCents: 5, kind: 'income' })])
    render(<Transactions />)
    expect(await rowOf('Rent')).toHaveTextContent(formatEur(-123456))
    expect(await rowOf('Rent')).toHaveTextContent('1.234,56')
    expect(await rowOf('Pay')).toHaveTextContent(formatEur(5))
    const dialog = await openEditor('Rent')
    expect(dialog).toHaveTextContent(formatEur(-123456))
  })

  it('keeps date and amount cells on one line', async () => {
    await db.transactions.add(tx())
    render(<Transactions />)
    const cells = within((await dataRows())[0]!).getAllByRole('cell')
    expect(cells[0]).toHaveClass('nowrap')
    expect(cells[2]).toHaveClass('nowrap')
    const css = readFileSync(resolvePath(import.meta.dirname, '..', 'app.css'), 'utf8')
    expect(css).toMatch(/\.nowrap\s*\{\s*white-space:\s*nowrap/)
  })

  it('says what to do next when there is nothing yet', async () => {
    render(<Transactions />)
    expect(await screen.findByText(/import your ING file/i)).toBeInTheDocument()
  })

  it('offers one category control grouped by parent, with no subcategory field', async () => {
    await db.transactions.add(tx({ description: 'Pick' }))
    render(<Transactions />)
    const dialog = await openEditor('Pick')
    expect(within(dialog).queryByLabelText(/subcategory/i)).toBeNull()
    const select = within(dialog).getByLabelText(/^Category$/)
    const group = select.querySelector('optgroup[label="Compras"]')
    expect(group?.textContent).toContain('Mascotas y veterinario')
    change(/^Category$/, 'cat.pets', dialog)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(await db.annotations.get('tx1')).toMatchObject({ categoryId: 'cat.pets', subcategoryId: null })
  })

  it('keeps the list usable with 3000 rows', async () => {
    const rows: TransactionRow[] = []
    for (let i = 0; i < 3000; i++) {
      rows.push(tx({ description: `Invented purchase ${i}`, valueDate: `2026-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}` }))
    }
    await db.transactions.bulkAdd(rows)
    render(<Transactions />)
    expect((await dataRows()).length).toBe(PAGE_SIZE)
    expect(screen.getByText(`Showing 1 to ${PAGE_SIZE} of 3000.`)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect((await dataRows()).length).toBe(PAGE_SIZE)
    expect(screen.getByText(`Page 2 of ${3000 / PAGE_SIZE}`)).toBeInTheDocument()
    // A search that matches many rows is still one page of them.
    change('Search', 'Invented purchase')
    expect((await dataRows()).length).toBe(PAGE_SIZE)
  })
})

describe('Transactions source', () => {
  it('never hand-formats money or reads it as a float', () => {
    for (const file of ['screens/Transactions.tsx', 'TransactionEditor.tsx']) {
      const src = readFileSync(resolvePath(import.meta.dirname, '..', file), 'utf8')
      expect(src).not.toMatch(/toFixed|parseFloat|toLocaleString|Intl\./)
    }
  })
})

describe('Transactions editor: amounts, payment method and category label', () => {
  it('opens the amount in the comma form the list shows, and saves 1.200 as one thousand two hundred euros', async () => {
    await db.transactions.add(tx({ description: 'Amount', amountCents: -2320 }))
    render(<Transactions />)
    const dialog = await openEditor('Amount')
    expect(within(dialog).getByLabelText('Amount in euros')).toHaveValue('-23,20')
    change('Amount in euros', '1.200', dialog)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect((await db.annotations.get('tx1'))?.amountCentsOverride).toBe(120000)
    expect(await rowOf('Amount')).toHaveTextContent(formatEur(120000))
  })

  it('writes nothing when the field is saved as populated, and when the grouped spelling of the same figure is typed', async () => {
    await db.transactions.add(tx({ description: 'Same', amountCents: -185000 }))
    render(<Transactions />)
    let dialog = await openEditor('Same')
    expect(within(dialog).getByLabelText('Amount in euros')).toHaveValue('-1850,00')
    change('Amount in euros', '-1.850,00', dialog)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    // The amount was not changed: no override and no learning event (the save only marks the transaction as checked).
    expect((await db.annotations.toArray()).map((a) => a.amountCentsOverride)).toEqual([null])
    expect(await db.learningEvents.count()).toBe(0)
    dialog = await openEditor('Same')
    change('Amount in euros', '1,200', dialog)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/amount/i)
    expect((await db.annotations.toArray()).map((a) => a.amountCentsOverride)).toEqual([null])
  })

  it('has no payment-method field, and says beside the merchant list how a merchant is added', async () => {
    await db.transactions.add(tx({ description: 'Pay method' }))
    render(<Transactions />)
    const dialog = await openEditor('Pay method')
    expect(within(dialog).queryByLabelText('Payment method')).toBeNull()
    expect(dialog.textContent).toMatch(/Not in the list\? Type its name under .Name this merchant., a little further down/)
  })

  it('lists what has not been checked first and what has been checked after it, and saving moves a transaction across', async () => {
    await db.transactions.bulkAdd([tx({ description: 'First' }), tx({ description: 'Second' })])
    render(<Transactions />)
    const table = await screen.findByRole('table', { name: 'Transactions' })
    const groups = () => [...table.querySelectorAll('tbody.tx-group')].map((g) => `${g.getAttribute('data-label')}: ${[...g.querySelectorAll('.tx-open')].map((b) => b.textContent).sort().join(', ')}`)
    await waitFor(() => expect(groups()).toEqual(['Not checked (2): First, Second']))
    const dialog = await openEditor('Second')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(groups()).toEqual(['Not checked (1): First', 'Checked (1): Second']))
  })

  it("labels the empty category option for what it does: back to ING's category when there is a pair, else none", async () => {
    await db.transactions.bulkAdd([tx({ description: 'With pair', ...GROCERIES }), tx({ description: 'No pair' })])
    render(<Transactions />)
    let dialog = await openEditor('With pair')
    expect(within(within(dialog).getByLabelText(/^Category$/)).getAllByRole('option')[0]).toHaveTextContent("Back to ING's category")
    // Even after the owner has chosen their own, the way back is still to ING's.
    change(/^Category$/, 'cat.restaurants', dialog)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    dialog = await openEditor('With pair')
    expect(within(within(dialog).getByLabelText(/^Category$/)).getAllByRole('option')[0]).toHaveTextContent("Back to ING's category")
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    dialog = await openEditor('No pair')
    expect(within(within(dialog).getByLabelText(/^Category$/)).getAllByRole('option')[0]).toHaveTextContent('No category')
  })
})

describe('Transactions: unmatched transfers (§9.2)', () => {
  it('says how many internal movements have no matching leg, and what that usually means', async () => {
    await db.transactions.bulkAdd([
      tx({ description: 'Traspaso out', kind: 'internal', amountCents: -5000 }),
      tx({ description: 'Traspaso out 2', kind: 'internal', amountCents: -700 }),
      tx({ description: 'Plain', kind: 'spend' }),
    ])
    render(<Transactions />)
    await table()
    const note = await screen.findByRole('note')
    expect(note).toHaveTextContent('2 movements between your accounts have no matching entry')
    expect(note).toHaveTextContent(/other account has not been imported yet/)
  })

  it('uses the singular for one, and shows nothing at zero or once the legs are linked', async () => {
    await db.transactions.bulkAdd([
      tx({ description: 'Lonely', kind: 'internal', amountCents: -5000 }),
      tx({ description: 'Out leg', kind: 'internal', amountCents: -900, accountId: 'acc1' }),
      tx({ description: 'In leg', kind: 'internal', amountCents: 900, accountId: 'acc2' }),
    ])
    await db.transfers.add({
      id: 'tr1', outTransactionId: 'tx2', inTransactionId: 'tx3', amountCents: 900, matchScore: 1, confirmedByUser: false,
      matchedAt: 1, linkKind: 'internal',
    })
    const first = render(<Transactions />)
    expect(await screen.findByRole('note')).toHaveTextContent('1 movement between your accounts has no matching entry')
    first.unmount()

    await db.transactions.update('tx1', { deletedAt: 5 })
    render(<Transactions />)
    await table()
    expect(screen.queryByRole('note')).toBeNull()
  })
})

describe('Refund links', () => {
  const setup = async () => {
    await db.transactions.bulkAdd([
      tx({ description: 'Invented shoe shop', amountCents: -8000, valueDate: '2026-11-03', ...GROCERIES }),
      tx({ description: 'Invented shoe refund', amountCents: 3000, valueDate: '2026-11-10', kind: 'income' }),
      tx({ description: 'Invented pay', amountCents: 200000, valueDate: '2026-11-01', kind: 'income' }),
    ])
  }

  // CHANGED in the §43 ruling (Plan 4, task 9). This test used to assert the opposite sentence — "It does not change
  // your budget figures" — which was honest while the figures ignored typeOverride. They honour it now, so the editor
  // must say so, and must still say what stays the bank's.
  it('says what the Kind control does: it decides which figure the transaction counts in (§43)', async () => {
    await setup()
    render(<Transactions />)
    const dialog = await openEditor('Invented shoe refund')
    expect(within(dialog).getByText(/decides which figure this transaction counts in/)).toBeTruthy()
    expect(within(dialog).getByText(/amount, the sign and that month stay the bank's/)).toBeTruthy()
  })

  it('lists payments counted as income and offers the link in the editor, then unlinks it', async () => {
    await setup()
    render(<Transactions />)
    const summary = await screen.findByText(/Money that arrived in November 2026 \(2\)/)
    expect(summary).toBeTruthy()

    const dialog = await openEditor('Invented shoe refund')
    const choose = await within(dialog).findByLabelText('Purchase it refunds')
    const link = within(dialog).getByRole('button', { name: 'Link as refund' })
    expect(link).toBeDisabled()
    fireEvent.change(choose, { target: { value: 'tx1' } })
    fireEvent.click(link)
    expect(await screen.findByText(/Linked as a refund/)).toBeTruthy()
    const rows = await db.transfers.toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ outTransactionId: 'tx1', inTransactionId: 'tx2', linkKind: 'refund', confirmedByUser: true })
    expect(await screen.findByText(/Money that arrived in November 2026 \(1\)/)).toBeTruthy()
    expect(await rowOf('Invented shoe refund')).toHaveTextContent('Refund')
    expect(await rowOf('Invented shoe shop')).toHaveTextContent('Refunded')

    const again = await openEditor('Invented shoe refund')
    expect(await within(again).findByText(/This is a refund of Invented shoe shop/)).toBeTruthy()
    // The promise is conditional, because a link to a purchase the budget does not count as spending changes nothing.
    expect(within(again).getByText(/This is a refund of Invented shoe shop/)).toHaveTextContent(/changes nothing and this payment stays income/)
    expect(within(again).queryByRole('button', { name: 'Link as refund' })).toBeNull()
    fireEvent.click(within(again).getByRole('button', { name: 'Unlink refund' }))
    expect(await screen.findByText(/counts as income again/)).toBeTruthy()
    expect(await db.transfers.count()).toBe(0)
    expect(await screen.findByText(/Money that arrived in November 2026 \(2\)/)).toBeTruthy()
  })

  it('shows a refusal in plain words and keeps the editor open, changing nothing', async () => {
    await setup()
    // the purchase is deleted after the editor has offered it
    render(<Transactions />)
    const dialog = await openEditor('Invented shoe refund')
    const choose = await within(dialog).findByLabelText('Purchase it refunds')
    await db.transactions.update('tx1', { deletedAt: 7 })
    fireEvent.change(choose, { target: { value: 'tx1' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Link as refund' }))
    const alert = await within(dialog).findByRole('alert')
    expect(alert).toHaveTextContent(/purchase has been deleted/)
    expect(alert).toHaveTextContent(/Your records are as they were/)
    expect(await db.transfers.count()).toBe(0)
  })

  it('does not badge a link that is paused by a deleted purchase', async () => {
    await setup()
    await linkRefund('tx2', 'tx1')
    await db.transactions.update('tx1', { deletedAt: 7 })
    render(<Transactions />)
    expect(await rowOf('Invented shoe refund')).not.toHaveTextContent('Refund')
  })

  it('does not badge a link that is live but inert because the purchase was re-filed as savings', async () => {
    await setup()
    await linkRefund('tx2', 'tx1')
    await db.annotations.add({
      transactionId: 'tx1', categoryId: 'cat.roundup', subcategoryId: null, merchantId: null, typeOverride: null,
      paymentMethod: null, note: null, moodId: null, purchaseReasonId: null, worthwhile: null, reviewed: false,
      dateOverride: null, amountCentsOverride: null, descriptionOverride: null, updatedAt: 1,
    })
    render(<Transactions />)
    expect(await rowOf('Invented shoe refund')).not.toHaveTextContent('Refund')
    expect(await rowOf('Invented shoe shop')).not.toHaveTextContent('Refunded')
  })

  it('lets the owner unlink from the refund while the purchase is deleted', async () => {
    await setup()
    await linkRefund('tx2', 'tx1')
    await db.transactions.update('tx1', { deletedAt: 7 })
    render(<Transactions />)
    const dialog = await openEditor('Invented shoe refund')
    expect(await within(dialog).findByText(/which you have deleted/)).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Unlink refund' }))
    await waitFor(async () => expect(await db.transfers.count()).toBe(0))
  })

  it('says so when there is no purchase to link to, and Escape still closes the editor', async () => {
    await db.transactions.add(tx({ description: 'Invented pay', amountCents: 200000, kind: 'income' }))
    render(<Transactions />)
    const dialog = await openEditor('Invented pay')
    expect(await within(dialog).findByText(/no purchase from the 90 days before it/)).toBeTruthy()
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
})

describe('Transactions: the filters are shut, deleted rows are hinted, and the query is one page (spec 39.3, 39.4)', () => {
  const panel = () => document.querySelector('details.tx-filter-panel') as HTMLDetailsElement
  const summary = () => screen.getByText(/^Filters/)

  it('collapses the transaction filters by default and remembers the choice', async () => {
    await db.transactions.add(tx({ description: 'Invented one' }))
    const first = render(<Transactions />)
    await table()
    expect(panel().open).toBe(false)
    // The summary is the disclosure's control and is a native summary, so it is keyboard operable as well as tappable.
    expect(summary().tagName).toBe('SUMMARY')
    fireEvent.click(summary())
    expect(panel().open).toBe(true)
    expect(localStorage.getItem(FILTERS_OPEN_KEY)).toBe('1')

    first.unmount()
    render(<Transactions />)
    await table()
    expect(panel().open).toBe(true) // a later visit opens as it was left
    fireEvent.click(summary())
    expect(panel().open).toBe(false)
    expect(localStorage.getItem(FILTERS_OPEN_KEY)).toBe('0')
  })

  it('still works, shut, when storage throws (a private window)', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied') })
    await db.transactions.add(tx({ description: 'Invented one' }))
    render(<Transactions />)
    await table()
    expect(panel().open).toBe(false)
    fireEvent.click(summary())
    expect(panel().open).toBe(true) // it opens for this visit; it just will not be remembered
  })

  it('says how many filters are on, so a shut panel does not hide that the list is narrowed', async () => {
    await db.transactions.add(tx({ description: 'Invented one' }))
    render(<Transactions />)
    await table()
    expect(summary()).toHaveTextContent('Filters')
    expect(summary()).not.toHaveTextContent('on)')
    change('Search', 'zzz')
    expect(summary()).toHaveTextContent('Filters (1 on)')
  })

  it('shows a deleted-row count when any exist', async () => {
    await db.transactions.bulkAdd([tx({ description: 'Kept' }), tx({ description: 'Gone one', deletedAt: 5 }), tx({ description: 'Gone two', deletedAt: 6 })])
    render(<Transactions />)
    const button = await screen.findByRole('button', { name: 'Deleted (2)' })
    expect(await descriptions()).toEqual(['Kept'])
    fireEvent.click(button)
    await waitFor(async () => expect((await descriptions()).sort()).toEqual(['Gone one', 'Gone two']))
    fireEvent.click(screen.getByRole('button', { name: 'Back to your transactions' }))
    await waitFor(async () => expect(await descriptions()).toEqual(['Kept']))
  })

  it('shows no deleted affordance when nothing is deleted', async () => {
    await db.transactions.add(tx({ description: 'Kept' }))
    render(<Transactions />)
    await table()
    expect(screen.queryByRole('button', { name: /^Deleted/ })).toBeNull()
  })

  it('loads at most one page of transactions from the database', async () => {
    const rows: TransactionRow[] = []
    for (let i = 0; i < 3000; i++) {
      rows.push(tx({ description: `Invented purchase ${i}`, valueDate: `2026-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}` }))
    }
    await db.transactions.bulkAdd(rows)
    const perDay = new Map<string, number>()
    for (const r of rows) perDay.set(r.valueDate, (perDay.get(r.valueDate) ?? 0) + 1)
    // One page, plus the whole of the two days at its edges (the list orders a day by fileSeq, which no index holds), plus
    // the one row that says which month is newest. Nothing else may touch a transaction row.
    const bound = PAGE_SIZE + 2 * Math.max(...perDay.values()) + 1

    let first = 0
    first = await transactionRowReads(async () => { render(<Transactions />); await dataRows() })
    expect(first).toBeGreaterThanOrEqual(PAGE_SIZE)
    expect(first).toBeLessThanOrEqual(bound)
    expect(bound).toBeLessThan(200) // the test only means something if the ledger is far larger than a page

    // The next page, and a save (which reloads), cost the same: a save does not re-read the ledger.
    const next = await transactionRowReads(async () => { fireEvent.click(screen.getByRole('button', { name: 'Next' })); await screen.findByText(`Page 2 of ${3000 / PAGE_SIZE}`) })
    expect(next).toBeLessThanOrEqual(bound)
    const dialog = await openEditor((await descriptions())[0] as string)
    change('Note', 'a note', dialog)
    const save = await transactionRowReads(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    })
    expect(save).toBeLessThanOrEqual(bound + 5) // the written row, and the editor's own context reads
    expect(await db.annotations.count()).toBe(1)
  })

  it('opens a transaction listed under "Money that arrived" even when it is not on the page loaded', async () => {
    const rows: TransactionRow[] = []
    for (let i = 0; i < 120; i++) rows.push(tx({ description: `Invented purchase ${i}`, valueDate: `2026-11-${String((i % 28) + 1).padStart(2, '0')}` }))
    rows.push(tx({ description: 'Invented salary', amountCents: 150000, kind: 'income', valueDate: '2026-11-01', fileSeq: 9999 }))
    await db.transactions.bulkAdd(rows)
    render(<Transactions />)
    fireEvent.click(await screen.findByRole('button', { name: /Invented salary/ }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByLabelText('Description')).toHaveValue('Invented salary')
  })
})

describe('Transactions: round-ups that could not be matched (spec 39.2)', () => {
  const NAMED = 'Redondeo por tu compra de 34 EUR y 78 cts'
  const setup = async (twoPurchases = true) => {
    await db.transactions.bulkAdd([
      tx({ description: 'Invented shop A', amountCents: -3478, valueDate: '2026-11-04', fileSeq: 3 }),
      ...(twoPurchases ? [tx({ description: 'Invented shop B', amountCents: -3478, valueDate: '2026-11-04', fileSeq: 4 })] : []),
      tx({ description: NAMED, amountCents: -22, valueDate: '2026-11-04', kind: 'roundup', fileSeq: 2 }),
    ])
  }

  it('tells the owner when a round-up could not be matched to a purchase', async () => {
    await setup()
    render(<Transactions />)
    expect(await rowOf(NAMED)).toHaveTextContent('No purchase matched') // visible in the list, not only in the editor
    expect(await rowOf('Invented shop A')).not.toHaveTextContent('No purchase matched')
    const dialog = await openEditor(NAMED)
    expect(await within(dialog).findByText(/could not be matched to a purchase automatically/)).toBeInTheDocument()
    expect(within(dialog).getByText(/More than one purchase that day/)).toBeInTheDocument()
    expect(within(dialog).getAllByRole('option').map((o) => o.textContent)).toEqual(expect.arrayContaining([
      expect.stringContaining('04/11/2026 · Invented shop A'), expect.stringContaining('04/11/2026 · Invented shop B'),
    ]))
  })

  it('says something different when no purchase of that amount exists, and offers no choice', async () => {
    await db.transactions.add(tx({ description: NAMED, amountCents: -22, valueDate: '2026-11-04', kind: 'roundup' }))
    render(<Transactions />)
    const dialog = await openEditor(NAMED)
    expect(await within(dialog).findByText(/not among your transactions for that day/)).toBeInTheDocument()
    expect(within(dialog).queryByLabelText('Purchase it belongs to')).toBeNull()
  })

  it('lets the owner choose the parent purchase, writing roundupParentIdOverride', async () => {
    await setup()
    render(<Transactions />)
    const dialog = await openEditor(NAMED)
    const choose = await within(dialog).findByLabelText('Purchase it belongs to')
    const use = within(dialog).getByRole('button', { name: 'Use this purchase' })
    expect(use).toBeDisabled()
    fireEvent.change(choose, { target: { value: 'tx2' } })
    fireEvent.click(use)
    expect(await screen.findByText(/now belongs to the purchase you chose/)).toBeInTheDocument()
    // Written as the owner's edit: the annotation, one learning event, and the bank's row untouched.
    expect(await db.annotations.get('tx3')).toMatchObject({ roundupParentIdOverride: 'tx2' })
    expect((await db.learningEvents.toArray()).map((e) => e.type)).toEqual(['roundupParent'])
    expect((await db.transactions.get('tx3'))?.roundupParentId).toBeNull()
    // And the list now agrees: nothing left to match.
    await waitFor(async () => expect(await rowOf(NAMED)).not.toHaveTextContent('No purchase matched'))
  })
})

describe('Transactions: honest about the bank date and about an impossible range (spec 42.1, 39.3)', () => {
  it('marks a row whose displayed date is not the bank date, and says what the bank recorded', async () => {
    await db.transactions.bulkAdd([tx({ description: 'Moved', valueDate: '2026-11-03' }), tx({ description: 'Plain', valueDate: '2026-11-04' })])
    await db.annotations.add({
      transactionId: 'tx1', categoryId: null, subcategoryId: null, merchantId: null, typeOverride: null, paymentMethod: null,
      note: null, moodId: null, purchaseReasonId: null, worthwhile: null, reviewed: false, dateOverride: '2026-11-20',
      amountCentsOverride: null, descriptionOverride: null, updatedAt: 1,
    })
    render(<Transactions />)
    const moved = await rowOf('Moved')
    expect(moved).toHaveTextContent('20/11/2026') // the owner's date is what is shown
    // The bank's date is VISIBLE text beside the badge: a title is unreachable by touch and by keyboard.
    expect(within(moved).getByText(/Date changed \(bank: 03\/11\/2026\)/)).toBeInTheDocument()
    expect(await rowOf('Plain')).not.toHaveTextContent('Date changed')
  })

  it('orders by the BANK date, so a row re-dated across a month boundary sits where its bank date puts it', async () => {
    await db.transactions.bulkAdd([
      tx({ description: 'Moved', valueDate: '2026-11-03' }), tx({ description: 'A', valueDate: '2026-11-05' }),
      tx({ description: 'B', valueDate: '2026-11-06' }), tx({ description: 'C', valueDate: '2026-11-08' }),
    ])
    await db.annotations.add({
      transactionId: 'tx1', categoryId: null, subcategoryId: null, merchantId: null, typeOverride: null, paymentMethod: null,
      note: null, moodId: null, purchaseReasonId: null, worthwhile: null, reviewed: false, dateOverride: '2026-12-02',
      amountCentsOverride: null, descriptionOverride: null, updatedAt: 1,
    })
    render(<Transactions />)
    // Newest first by bank date: C, B, A, then Moved at the bottom, though its shown date (02/12/2026) is the latest.
    expect(await descriptions()).toEqual(['C', 'B', 'A', 'Moved'])
    const moved = await rowOf('Moved')
    expect(moved).toHaveTextContent('02/12/2026')
    expect(moved).toHaveTextContent('Date changed (bank: 03/11/2026)')
    change('Order', 'oldest')
    await waitFor(async () => expect(await descriptions()).toEqual(['Moved', 'A', 'B', 'C']))
  })

  it('orders the read-everything path by the bank date too, over several rows', async () => {
    const grocery = { ingCategory: 'Alimentación', ingSubcategory: 'Supermercados y alimentación' }
    await db.transactions.bulkAdd([
      tx({ description: 'Moved', valueDate: '2026-11-03', ...grocery }), tx({ description: 'A', valueDate: '2026-11-05', ...grocery }),
      tx({ description: 'B', valueDate: '2026-11-06', ...grocery }), tx({ description: 'C', valueDate: '2026-11-08', ...grocery }),
      tx({ description: 'Other category', valueDate: '2026-11-07' }),
    ])
    await db.annotations.add({
      transactionId: 'tx1', categoryId: null, subcategoryId: null, merchantId: null, typeOverride: null, paymentMethod: null,
      note: null, moodId: null, purchaseReasonId: null, worthwhile: null, reviewed: false, dateOverride: '2026-12-02',
      amountCentsOverride: null, descriptionOverride: null, updatedAt: 1,
    })
    render(<Transactions />)
    await table()
    // A category filter is answered from the resolved values, so it takes the read-everything path and leaves four rows.
    change('Category', 'cat.groceries')
    await waitFor(async () => expect(await descriptions()).toEqual(['C', 'B', 'A', 'Moved']))
    change('Order', 'oldest')
    await waitFor(async () => expect(await descriptions()).toEqual(['Moved', 'A', 'B', 'C']))
  })

  it('ignores a page button pressed while a page is loading, and at the ends of the range, without losing focus', async () => {
    const rows: TransactionRow[] = []
    for (let i = 0; i < 120; i++) rows.push(tx({ description: `Invented purchase ${i}`, valueDate: `2026-11-${String((i % 28) + 1).padStart(2, '0')}` }))
    await db.transactions.bulkAdd(rows)
    render(<Transactions />)
    const next = await screen.findByRole('button', { name: 'Next' })
    // The property under test: the control just pressed is still the control the owner is standing on, and was never `disabled`.
    const stillStandingOn = (button: HTMLElement) => { expect(document.activeElement).toBe(button); expect(button).not.toHaveAttribute('disabled') }
    next.focus()
    fireEvent.click(next)
    fireEvent.click(next) // the load for page 2 is still in flight: this press must do nothing
    stillStandingOn(next)
    await screen.findByText('Showing 51 to 100 of 120.') // the "Page n of m" label follows the request at once; this follows the data
    await new Promise((r) => setTimeout(r, 50)) // had the second press counted, page 3 would be loading by now
    expect(screen.getByText('Page 2 of 3')).toBeInTheDocument()
    expect(next).toHaveAttribute('aria-disabled', 'false')
    // Onto the last page: the button that was pressed goes inert but stays focusable, so focus is not dropped.
    fireEvent.click(next)
    await screen.findByText('Showing 101 to 120 of 120.')
    expect(next).toHaveAttribute('aria-disabled', 'true')
    expect(next).not.toBeDisabled()
    expect(document.activeElement).toBe(next)
    fireEvent.click(next) // already on the last page: ignored
    expect(screen.getByText('Page 3 of 3')).toBeInTheDocument()
    stillStandingOn(next)
    // The same on the way back down to the first page.
    const previous = screen.getByRole('button', { name: 'Previous' })
    previous.focus()
    fireEvent.click(previous)
    await screen.findByText('Showing 51 to 100 of 120.')
    fireEvent.click(previous)
    await screen.findByText('Showing 1 to 50 of 120.')
    expect(previous).toHaveAttribute('aria-disabled', 'true')
    stillStandingOn(previous)
    fireEvent.click(previous) // already on the first page: ignored
    expect(screen.getByText('Page 1 of 3')).toBeInTheDocument()
    stillStandingOn(previous)
  })

  it('keeps the page buttons mounted and focused while a page loads', async () => {
    const rows: TransactionRow[] = []
    for (let i = 0; i < 120; i++) rows.push(tx({ description: `Invented purchase ${i}`, valueDate: `2026-11-${String((i % 28) + 1).padStart(2, '0')}` }))
    await db.transactions.bulkAdd(rows)
    render(<Transactions />)
    const next = await screen.findByRole('button', { name: 'Next' })
    next.focus()
    fireEvent.click(next)
    // Not replaced by a new element: the one that was pressed is still in the document and still has focus.
    expect(next.isConnected).toBe(true)
    await screen.findByText('Page 2 of 3')
    expect(screen.getByRole('button', { name: 'Next' })).toBe(next)
    expect(document.activeElement).toBe(next)
  })

  it('counts deleted rows as the deleted view would list them: per account, and under a search too in the read-everything path', async () => {
    await db.transactions.bulkAdd([
      tx({ description: 'Kept one' }), tx({ description: 'Kept two', accountId: 'acc2' }), tx({ description: 'Gone in two', accountId: 'acc2', deletedAt: 5 }),
    ])
    render(<Transactions />)
    expect(await screen.findByRole('button', { name: 'Deleted (1)' })).toBeInTheDocument()
    change('Account', 'acc1')
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Deleted/ })).toBeNull()) // nothing deleted in Cuenta 0001
    change('Account', 'acc2')
    expect(await screen.findByRole('button', { name: 'Deleted (1)' })).toBeInTheDocument()
    // The same in the read-everything path, where the count follows EVERY active filter, not only the account: a search that
    // the deleted row does not match leaves nothing to restore under it, and the button says so.
    change('Search', 'Gone')
    expect(await screen.findByRole('button', { name: 'Deleted (1)' })).toBeInTheDocument()
    change('Search', 'Kept')
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Deleted/ })).toBeNull())
    change('Search', '')
    change('Account', 'acc1')
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Deleted/ })).toBeNull())
  })

  it('names the inverted range instead of saying nothing matches', async () => {
    await db.transactions.add(tx({ description: 'Anything' }))
    render(<Transactions />)
    await table()
    change('From', '2026-11-20')
    change('To', '2026-11-01')
    expect(await screen.findByText(/The From date \(20\/11\/2026\) is after the To date \(01\/11\/2026\)/)).toBeInTheDocument()
    expect(screen.queryByText(/Nothing matches these filters/)).toBeNull()
    change('From', '2026-11-01')
    change('To', '2026-11-30')
    expect(await rowOf('Anything')).toBeTruthy()
  })
})

describe('Transactions: naming the merchant behind a transaction (§11, §34.3)', () => {
  const nameButton = (dialog: HTMLElement) => within(dialog).getByRole('button', { name: 'Name this merchant' })

  it('creates the merchant, stores the pattern and files the transaction under it', async () => {
    await db.transactions.add(tx({ description: 'Compra en TIENDA EJEMPLO MADRID' }))
    render(<Transactions />)
    const dialog = await openEditor('TIENDA EJEMPLO MADRID')
    // A fresh install has no merchants, so the list on its own offers the owner nothing: naming is the only way in.
    expect(within(within(dialog).getByLabelText('Merchant')).getAllByRole('option').map((o) => o.textContent)).toEqual(['None'])

    change('Merchant name', '  Tienda Ejemplo  ', dialog) // the spaces around a name are not part of it
    fireEvent.click(nameButton(dialog))
    // The period pins the trim: an untrimmed name would be announced as "now Tienda Ejemplo ." instead.
    expect(await within(dialog).findByRole('status')).toHaveTextContent('This transaction is now Tienda Ejemplo.')

    const merchants = await db.merchants.toArray()
    expect(merchants).toHaveLength(1)
    expect(merchants[0]).toMatchObject({ canonicalName: 'Tienda Ejemplo', matchPatterns: ['Tienda Ejemplo'], kind: 'merchant' })
    expect(merchants[0]?.createdAt).toEqual(expect.any(Number))
    // Written through writeAnnotation, so the learning event comes for free and the bank's row is untouched.
    expect((await db.annotations.get('tx1'))?.merchantId).toBe(merchants[0]?.id)
    expect((await db.learningEvents.toArray()).map((e) => e.type)).toEqual(['merchant'])
    expect((await db.transactions.get('tx1'))?.description).toBe('Compra en TIENDA EJEMPLO MADRID')

    // The editor stays open and its Merchant control now holds what was just named, so the next Save cannot send the
    // stale "None" back and undo the naming.
    await waitFor(() => expect(within(dialog).getByLabelText('Merchant')).toHaveValue(merchants[0]?.id))
    expect(within(dialog).getByLabelText('Merchant name')).toHaveValue('')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect((await db.annotations.get('tx1'))?.merchantId).toBe(merchants[0]?.id)
    expect(await rowOf('TIENDA EJEMPLO MADRID')).toHaveTextContent('Tienda Ejemplo')
  })

  it('does nothing for a name that is only whitespace, without taking focus off the button', async () => {
    await db.transactions.add(tx({ description: 'Compra en TIENDA EJEMPLO MADRID' }))
    render(<Transactions />)
    const dialog = await openEditor('TIENDA EJEMPLO MADRID')
    const button = nameButton(dialog)
    expect(button).toHaveAttribute('aria-disabled', 'true') // nothing typed yet
    change('Merchant name', '   ', dialog)
    button.focus()
    fireEvent.click(button)
    expect(button).toHaveAttribute('aria-disabled', 'true')
    // Never `disabled`: that would drop focus to the body, and the owner would be standing nowhere (P3-R32).
    expect(button).not.toBeDisabled()
    expect(document.activeElement).toBe(button)
    expect(await db.merchants.count()).toBe(0)
    expect(await db.annotations.count()).toBe(0)
    expect(within(dialog).queryByRole('status')).toBeNull()
    // Nothing was attempted either: an inert control does not go and ask the database to refuse.
    expect(within(dialog).queryByRole('alert')).toBeNull()
  })

  it('names the merchant from the keyboard: Enter in the field does it, instead of saving the editor', async () => {
    await db.transactions.add(tx({ description: 'Pago en SUPERMERCADO EJEMPLO BARCELONA' }))
    render(<Transactions />)
    const dialog = await openEditor('SUPERMERCADO EJEMPLO')
    change('Merchant name', 'Supermercado Ejemplo', dialog)
    fireEvent.keyDown(within(dialog).getByLabelText('Merchant name'), { key: 'Enter' })
    expect(await within(dialog).findByRole('status')).toHaveTextContent('Supermercado Ejemplo')
    expect((await db.merchants.toArray())[0]?.canonicalName).toBe('Supermercado Ejemplo')
    expect(screen.queryByRole('dialog')).not.toBeNull() // Enter named the merchant; it did not submit and close the editor
  })

  it("shows rememberMerchantName's own refusal, in its words, and writes nothing", async () => {
    // A description with no letters or digits leaves no pattern to remember, which is the guard this exercises.
    await db.transactions.add(tx({ description: '...' }))
    render(<Transactions />)
    const dialog = await openEditor('...')
    change('Merchant name', 'Comercio Ejemplo SL', dialog)
    fireEvent.click(nameButton(dialog))
    const alert = await within(dialog).findByRole('alert')
    expect(alert).toHaveTextContent('That transaction has no description to remember. Nothing was saved.')
    expect(alert).toHaveTextContent('Your records are as they were')
    expect(await db.merchants.count()).toBe(0)
    expect(await db.annotations.count()).toBe(0)
    expect(within(dialog).queryByRole('status')).toBeNull()
  })

  it('offers no naming control on a deleted transaction, where it would do nothing (P3-R33)', async () => {
    await db.transactions.add(tx({ description: 'Compra en TIENDA EJEMPLO MADRID', deletedAt: 5 }))
    render(<Transactions />)
    fireEvent.click(await screen.findByRole('button', { name: 'Deleted (1)' }))
    const dialog = await openEditor('TIENDA EJEMPLO MADRID')
    expect(within(dialog).queryByLabelText('Merchant name')).toBeNull()
    expect(within(dialog).queryByRole('button', { name: 'Name this merchant' })).toBeNull()
  })
})

describe('The whole learning loop, from a fresh install (§11)', () => {
  it('learns a merchant category from two corrections once the owner has named the merchant, naming it only once', async () => {
    expect(await db.merchants.count()).toBe(0) // as a real install starts: the seed creates no merchants
    await db.transactions.bulkAdd([
      tx({ description: 'Compra en TIENDA EJEMPLO MADRID', valueDate: '2026-11-10' }),
      tx({ description: 'Pago en TIENDA EJEMPLO BARCELONA', valueDate: '2026-11-12' }),
    ])
    render(<Transactions />)

    // 1. The owner names the merchant on one purchase, through the control the screen gives them.
    let dialog = await openEditor('TIENDA EJEMPLO MADRID')
    change('Merchant name', 'Tienda Ejemplo', dialog)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Name this merchant' }))
    await within(dialog).findByRole('status')
    // 2. and corrects its category, in the same visit.
    change(/^Category$/, 'cat.groceries', dialog)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    // 3. The second purchase is never named: the pattern stored by the first has to carry it.
    dialog = await openEditor('TIENDA EJEMPLO BARCELONA')
    change(/^Category$/, 'cat.groceries', dialog)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect((await db.annotations.get('tx2'))?.merchantId).toBeNull()

    // 4. What the Intelligence screen reads: that merchant, corrected twice, and the category to assume for it.
    const merchantId = (await db.merchants.toArray())[0]?.id as string
    const memory = await categoryMemory()
    expect(memory.get(merchantId)).toMatchObject({ categoryId: 'cat.groceries', corrections: 2 })
    expect(rememberedCategoryFor(merchantId, memory)).toBe('cat.groceries')
  })
})
