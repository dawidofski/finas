import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import Import from './Import'
import { db } from '../../db/db'
import { seedDatabase } from '../../db/seed'
import { BASE, statement } from '../../import/__fixtures__/statement'
import { commitPreview } from '../../import/commit'
import { buildPreview } from '../../import/pipeline'
import * as pwa from '../../reloadHold'
import { addDays } from '../../lib/dates'

// Spies on the two hold functions: this screen's contract is when it takes and releases the hold.
vi.mock('../../reloadHold', () => ({ suspendReload: vi.fn(), resumeReload: vi.fn() }))

beforeEach(async () => {
  await db.delete()
  await db.open()
  await seedDatabase()
  vi.mocked(pwa.suspendReload).mockClear()
  vi.mocked(pwa.resumeReload).mockClear()
})

const fileOf = (bytes: Uint8Array, name = 'movimientos.xlsx') => new File([new Uint8Array(bytes)], name)
const pick = (file: File) => fireEvent.change(screen.getByLabelText(/ING movements file/i), { target: { files: [file] } })

describe('Import screen', () => {
  it('suspends the service-worker reload while a preview is open and resumes after commit', async () => {
    render(<Import />)
    pick(fileOf(statement({ moves: BASE, opening: 100000 })))
    await screen.findByRole('heading', { name: /check before importing/i })
    expect(pwa.suspendReload).toHaveBeenCalledTimes(1)
    expect(pwa.resumeReload).not.toHaveBeenCalled()
    // Nothing is written until the one explicit action.
    expect(await db.transactions.count()).toBe(0)

    fireEvent.click(screen.getByRole('button', { name: /import 3 new transactions/i }))
    await screen.findByRole('heading', { name: /import finished/i })
    expect(pwa.resumeReload).toHaveBeenCalledTimes(1)
    expect(await db.transactions.count()).toBe(3)
  })

  it('keeps the date and amount cells on one line in the preview table', async () => {
    render(<Import />)
    pick(fileOf(statement({ moves: BASE, opening: 100000 })))
    await screen.findByRole('heading', { name: /check before importing/i })
    const [row] = screen.getAllByRole('row').slice(1)
    const cells = within(row!).getAllByRole('cell')
    expect(cells[0]).toHaveClass('nowrap')
    expect(cells[2]).toHaveClass('nowrap')
  })

  it('releases the hold when the preview is cancelled', async () => {
    render(<Import />)
    pick(fileOf(statement({ moves: BASE, opening: 100000 })))
    await screen.findByRole('heading', { name: /check before importing/i })
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(pwa.resumeReload).toHaveBeenCalledTimes(1)
    expect(await db.transactions.count()).toBe(0)
    expect(screen.getByLabelText(/ING movements file/i)).toBeInTheDocument()
  })

  it('tells the owner in a sentence when the file is a PDF, and holds nothing afterwards', async () => {
    render(<Import />)
    pick(fileOf(new TextEncoder().encode('%PDF-1.7\n'), 'extracto.pdf'))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/Excel/)
    // The hold is taken while the file is read and given back when it is refused: one each, so nothing stays held.
    expect(pwa.suspendReload).toHaveBeenCalledTimes(1)
    expect(pwa.resumeReload).toHaveBeenCalledTimes(1)
  })

  it('saves a correction chosen in the preview as an annotation', async () => {
    render(<Import />)
    pick(fileOf(statement({ moves: BASE, opening: 100000 })))
    await screen.findByRole('heading', { name: /check before importing/i })
    await waitFor(() => expect(screen.getAllByRole('option', { name: 'Supermercados y alimentación' }).length).toBeGreaterThan(0))
    const [first] = screen.getAllByRole('combobox', { name: /category for/i })
    fireEvent.change(first!, { target: { value: 'cat.groceries' } })
    expect(screen.getByText(/1 correction will be saved/i)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /import 3 new transactions/i }))
    await screen.findByRole('heading', { name: /import finished/i })
    const annotations = await db.annotations.toArray()
    expect(annotations).toHaveLength(1)
    expect(annotations[0]).toMatchObject({ categoryId: 'cat.groceries' })
  })

  it('tells the owner, before importing, when a round-up could not be matched to a purchase (spec 39.2)', async () => {
    const named = 'Redondeo por tu compra de 34 EUR y 78 cts'
    render(<Import />)
    pick(fileOf(statement({
      opening: 100000,
      moves: [
        // Two identical purchases the same day, and the round-up is not posted right after either: the chain cannot say which.
        { date: '2026-11-03', cents: -3478 }, { date: '2026-11-03', cents: -3478 }, { date: '2026-11-03', cents: -500 },
        { date: '2026-11-03', cents: -22, desc: named, cat: 'Ahorro', sub: 'Redondeo' },
        // A round-up whose purchase is not in this file at all.
        { date: '2026-11-05', cents: -22, desc: 'Redondeo por tu compra de 9 EUR y 50 cts', cat: 'Ahorro', sub: 'Redondeo' },
      ],
    })))
    await screen.findByRole('heading', { name: /check before importing/i })
    const note = screen.getByText(/round-ups could not be matched to a purchase/)
    expect(note).toHaveTextContent('2 round-ups could not be matched to a purchase: 1 could belong to more than one purchase')
    expect(note).toHaveTextContent('1 names a purchase that is not in this file')
    expect(note).toHaveTextContent('Afterwards, open the round-up in Transactions and choose its purchase.')
    expect(note.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}/)
  })

  it('says how many already-imported rows it lists, and shows the rest on request, past 100', async () => {
    const many = Array.from({ length: 105 }, (_, i) => ({ date: addDays('2026-01-01', i), cents: -(100 + i) }))
    await commitPreview(await buildPreview(statement({ moves: many, opening: 1000000 }), 'a.xlsx'), new Map())
    render(<Import />)
    pick(fileOf(statement({ moves: [...many, { date: '2026-06-01', cents: -50 }], opening: 1000000, exported: '16/11/2026 08:00:00' })))
    await screen.findByRole('heading', { name: /check before importing/i })
    const details = screen.getByText(/Already imported \(105\)/).closest('details') as HTMLElement
    expect(within(details).getAllByRole('listitem')).toHaveLength(100)
    expect(details).toHaveTextContent('Showing 100 of 105.')
    fireEvent.click(within(details).getByRole('button', { name: 'Show 5 more' }))
    expect(within(details).getAllByRole('listitem')).toHaveLength(105)
    expect(details).not.toHaveTextContent(/Showing \d+ of/)
  })

  it('says nothing about round-ups when every one was matched', async () => {
    render(<Import />)
    pick(fileOf(statement({ moves: BASE, opening: 100000 })))
    await screen.findByRole('heading', { name: /check before importing/i })
    expect(screen.queryByText(/could not be matched to a purchase/)).toBeNull()
  })

  it('keeps the import button off until a divergent file is acknowledged', async () => {
    await commitPreview(await buildPreview(statement({ moves: BASE, opening: 100000 }), 'a.xlsx'), new Map())
    render(<Import />)
    pick(fileOf(statement({
      moves: [{ date: '2026-11-11', cents: -500 }, { date: '2026-11-13', cents: -700 }],
      opening: 555500, exported: '16/11/2026 08:00:00',
    })))
    await screen.findByRole('heading', { name: /check before importing/i })
    const button = screen.getByRole('button', { name: /import 2 new transactions/i })
    expect(button).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox', { name: /import it anyway/i }))
    expect(button).toBeEnabled()
  })

  it('shows the suggested category with the sentence that explains it, and writes it only when the owner accepts', async () => {
    const ING_ROW = { date: '2026-11-12', cents: -4000, desc: 'Compra EN OTRA COSA', cat: 'Alimentación', sub: 'Supermercados y alimentación' }
    const OTHER = { date: '2026-11-11', cents: -320, desc: 'Compra EN CAFETERIA EJEMPLO', cat: 'Ocio y viajes', sub: 'Cafeterías y restaurantes' }
    render(<Import />)
    pick(fileOf(statement({ moves: [OTHER, ING_ROW], opening: 100000 })))
    await screen.findByRole('heading', { name: /check before importing/i })
    // The suggestion names the category and says what it rests on, in the engine's own words.
    const useGroceries = await screen.findByRole('button', { name: /use supermercados y alimentación for/i })
    expect(screen.getAllByText('ING files this under Alimentación, Supermercados y alimentación.')).toHaveLength(1)
    expect(screen.getAllByText('ING files this under Ocio y viajes, Cafeterías y restaurantes.')).toHaveLength(1)
    // Showing it wrote nothing.
    expect(await db.annotations.count()).toBe(0)
    expect(await db.learningEvents.count()).toBe(0)

    fireEvent.click(useGroceries)
    expect(screen.getByText(/1 correction will be saved/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /import 2 new transactions/i }))
    await screen.findByRole('heading', { name: /import finished/i })
    // Only the accepted row has an annotation.
    const annotations = await db.annotations.toArray()
    expect(annotations).toHaveLength(1)
    expect(annotations[0]).toMatchObject({ categoryId: 'cat.groceries' })
    expect(await db.learningEvents.count()).toBe(1)
  })
})
