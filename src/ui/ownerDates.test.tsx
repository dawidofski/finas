import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import Transactions from './screens/Transactions'
import Budget from './screens/Budget'
import Mood from './screens/Mood'
import WorthIt from './screens/WorthIt'
import Import from './screens/Import'
import { db } from '../db/db'
import { seedDatabase } from '../db/seed'
import { writeAnnotation } from '../db/annotations'
import { BASE, statement } from '../import/__fixtures__/statement'
import { commitPreview } from '../import/commit'
import { buildPreview } from '../import/pipeline'
import type { AccountRow, TransactionRow } from '../db/schema'

vi.mock('../reloadHold', () => ({ suspendReload: vi.fn(), resumeReload: vi.fn() }))

/**
 * Presentation only (ruling P3-R18): storage keeps 'YYYY-MM-DD', and the owner reads dd/MM/yyyy. These tests render each
 * screen with real dates in the database and read back everything a person or a screen reader could read.
 */
const ISO = /\d{4}-\d{2}-\d{2}/
const SPANISH = /\d{2}\/\d{2}\/\d{4}/

/** Visible text and every attribute that is spoken or shown. Input VALUES are deliberately not read: a date input must hold ISO, and the browser draws it. */
function ownerFacing(root: HTMLElement = document.body): string {
  const parts = [root.textContent ?? '']
  for (const el of root.querySelectorAll('*')) {
    for (const name of ['aria-label', 'aria-description', 'title', 'placeholder', 'alt']) {
      const v = el.getAttribute(name)
      if (v) parts.push(v)
    }
  }
  return parts.join('\n')
}
const expectNoIso = (text: string) => {
  expect(text.match(new RegExp(ISO, 'g')) ?? []).toEqual([])
}

const account = (id: string): AccountRow => ({ id, fingerprint: '1'.repeat(64), label: 'Cuenta 1', last4: null, currency: 'EUR', createdAt: 1, archived: false })
let seq = 0
const tx = (over: Partial<TransactionRow> = {}): TransactionRow => {
  seq++
  return {
    id: `tx${seq}`, accountId: 'acc1', valueDate: '2026-11-08', amountCents: -1250, balanceCents: 0, description: `Invented shop ${seq}`,
    comment: null, ingCategory: 'Ocio y viajes', ingSubcategory: 'Cafeterías y restaurantes', kind: 'spend', dedupKey: `key${seq}`,
    importId: 'imp1', fileSeq: seq, roundupParentId: null, createdAt: 1, deletedAt: null, ...over,
  }
}

beforeEach(async () => {
  seq = 0
  await db.delete(); await db.open(); await seedDatabase()
  await db.accounts.add(account('acc1'))
})
afterEach(() => { vi.restoreAllMocks() })

describe('every date the owner reads is dd/MM/yyyy', () => {
  it('on the transactions list, "Money that arrived", and the editor with its refund and round-up sections', async () => {
    await db.transactions.bulkAdd([
      tx({ description: 'Invented shoe shop', amountCents: -8000, valueDate: '2026-11-03' }),
      tx({ description: 'Invented shoe refund', amountCents: 3000, valueDate: '2026-11-10', kind: 'income' }),
      tx({ description: 'Invented shop A', amountCents: -3478, valueDate: '2026-11-04' }),
      tx({ description: 'Invented shop B', amountCents: -3478, valueDate: '2026-11-04' }),
      tx({ description: 'Redondeo por tu compra de 34 EUR y 78 cts', amountCents: -22, valueDate: '2026-11-04', kind: 'roundup' }),
    ])
    render(<Transactions />)
    await screen.findByRole('table', { name: 'Transactions' })
    let text = ownerFacing()
    expectNoIso(text)
    expect(text).toMatch(/08\/11\/2026|10\/11\/2026/)
    expect(text).toContain('10/11/2026 · Invented shoe refund')

    // The refund's editor: "The bank recorded", and the purchases it could refund.
    fireEvent.click(screen.getAllByRole('button', { name: /Invented shoe refund/ })[0] as HTMLElement)
    let dialog = await screen.findByRole('dialog')
    await within(dialog).findByLabelText('Purchase it refunds')
    text = ownerFacing(dialog)
    expectNoIso(text)
    expect(text).toContain('The bank recorded 10/11/2026')
    expect(text).toContain('03/11/2026 · Invented shoe shop')
    fireEvent.keyDown(dialog, { key: 'Escape' })

    // The round-up's editor lists same-day purchases.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    fireEvent.click(within(await screen.findByRole('table', { name: 'Transactions' })).getByRole('button', { name: /Redondeo/ }))
    dialog = await screen.findByRole('dialog')
    await within(dialog).findByLabelText('Purchase it belongs to')
    text = ownerFacing(dialog)
    expectNoIso(text)
    expect(text).toContain('04/11/2026 · Invented shop A')
  })

  it('on a linked refund: the purchase it returned and the date it was refunded', async () => {
    await db.transactions.bulkAdd([
      tx({ description: 'Invented shoe shop', amountCents: -8000, valueDate: '2026-11-03' }),
      tx({ description: 'Invented shoe refund', amountCents: 3000, valueDate: '2026-11-10', kind: 'income' }),
    ])
    const { linkRefund } = await import('../import/refunds')
    await linkRefund('tx2', 'tx1')
    render(<Transactions />)
    for (const [name, expected] of [[/Invented shoe refund/, '03/11/2026'], [/Invented shoe shop/, '10/11/2026']] as const) {
      fireEvent.click(within(await screen.findByRole('table', { name: 'Transactions' })).getByRole('button', { name }))
      const dialog = await screen.findByRole('dialog')
      await waitFor(() => expect(ownerFacing(dialog)).toContain(expected))
      expectNoIso(ownerFacing(dialog))
      fireEvent.keyDown(dialog, { key: 'Escape' })
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    }
  })

  it('on the budget screen, including the running-month sentence', async () => {
    await db.transactions.add(tx({ valueDate: '2026-11-03', amountCents: 200000, kind: 'income' }))
    render(<Budget today="2026-11-16" initialMonth="2026-11" />)
    await screen.findByText(/This month is still running/)
    const text = ownerFacing()
    expectNoIso(text)
    expect(text).toContain('up to 16/11/2026')
  })

  it('on both annotation queues: the card, its aria label, and the whole-day sentence', async () => {
    await db.transactions.add(tx({ valueDate: '2026-11-03' }))
    const mood = render(<Mood />)
    await screen.findByRole('article', { name: 'Transaction to review' })
    fireEvent.click(screen.getByRole('button', { name: /whole day/ }))
    let text = ownerFacing()
    expectNoIso(text)
    expect(text).toContain('03/11/2026')
    mood.unmount()

    await writeAnnotation('tx1', { moodId: 'mood.happy' }, 'owner')
    render(<WorthIt today="2026-11-16" />)
    await screen.findByRole('article', { name: 'Transaction to review' })
    text = ownerFacing()
    expectNoIso(text)
    expect(text).toContain('03/11/2026')
  })

  it('in the import preview: coverage, the row lists, the gap sentence, and the per-row control labels', async () => {
    await commitPreview(await buildPreview(statement({ moves: BASE, opening: 100000 }), 'a.xlsx'), new Map())
    const { unmount } = render(<Import />)
    // Overlapping file: three rows already imported, one new.
    fireEvent.change(screen.getByLabelText(/ING movements file/i), {
      target: { files: [new File([new Uint8Array(statement({ moves: [...BASE, { date: '2026-11-14', cents: -500 }], opening: 100000, exported: '16/11/2026 08:00:00' }))], 'b.xlsx')] },
    })
    await screen.findByRole('heading', { name: /check before importing/i })
    let text = ownerFacing()
    expectNoIso(text)
    expect(text).toContain('10/11/2026 to 14/11/2026')
    expect(text).toMatch(/Category for 14\/11\/2026/)
    unmount()

    // A file that leaves a hole: the sentence names the dates to re-export.
    render(<Import />)
    fireEvent.change(screen.getByLabelText(/ING movements file/i), {
      target: { files: [new File([new Uint8Array(statement({ moves: [{ date: '2026-11-20', cents: -700 }], opening: 77777, exported: '21/11/2026 08:00:00' }))], 'c.xlsx')] },
    })
    await screen.findByRole('heading', { name: /check before importing/i })
    text = ownerFacing()
    expectNoIso(text)
    expect(text).toMatch(/between 12\/11\/2026 and 20\/11\/2026|Exporting \d{2}\/\d{2}\/2026 to \d{2}\/\d{2}\/2026/)
  })

  it('in the sentence for a file already imported', async () => {
    const bytes = statement({ moves: BASE, opening: 100000 })
    await commitPreview(await buildPreview(bytes, 'a.xlsx'), new Map())
    render(<Import />)
    fireEvent.change(screen.getByLabelText(/ING movements file/i), { target: { files: [new File([new Uint8Array(bytes)], 'again.xlsx')] } })
    const alert = await screen.findByRole('alert')
    expectNoIso(ownerFacing(alert))
    expect(alert.textContent).toMatch(/already imported on \d{2}\/\d{2}\/\d{4}/)
    expect(alert.textContent).toMatch(SPANISH)
  })
})
