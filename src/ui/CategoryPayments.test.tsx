import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { CategoryPayments } from './CategoryPayments'
import { db } from '../db/db'
import { seedDatabase } from '../db/seed'
import { resolveMany } from '../db/annotations'
import type { CategoryRow, TransactionRow } from '../db/schema'
import { guardWording } from '../test/wording'

let n = 0
const tx = (valueDate: string, amountCents: number, description: string, over: Partial<TransactionRow> = {}): TransactionRow => ({
  id: `t${++n}`, accountId: 'acc', valueDate, amountCents, balanceCents: 50000, description, comment: null,
  ingCategory: 'Compras', ingSubcategory: 'Compras (otros)', kind: 'spend', dedupKey: `K${n}`, importId: 'imp', fileSeq: n, roundupParentId: null,
  createdAt: 1, deletedAt: null, ...over,
})

let categories: CategoryRow[] = []
beforeEach(async () => {
  n = 0
  await db.delete(); await db.open(); await seedDatabase()
  categories = await db.categories.toArray()
})
afterEach(() => { cleanup() })
guardWording(1, '.payment-name')

const mount = (onChanged = vi.fn()) => {
  render(<CategoryPayments categoryId="cat.shopping" label="Compras (otros)" month="2026-11" categories={categories} onChanged={onChanged} />)
  return onChanged
}
const openIt = () => {
  const details = document.querySelector('details.category-payments') as HTMLDetailsElement
  details.open = true
  fireEvent(details, new Event('toggle'))
}

describe('the payments behind a budget line', () => {
  it('reads nothing until it is opened, then lists that month’s purchases in the category, newest first', async () => {
    await db.transactions.bulkAdd([
      tx('2026-11-03', -1200, 'Compra EN TIENDA UNO'),
      tx('2026-11-09', -3400, 'Compra EN TIENDA DOS'),
      tx('2026-10-28', -999, 'Compra EN OCTUBRE'),                                   // another month
      tx('2026-11-05', -500, 'Compra EN SUPER', { ingCategory: 'Alimentación', ingSubcategory: 'Supermercados y alimentación' }),   // another category
      tx('2026-11-06', 2500, 'Devolucion EJEMPLO'),                                   // money in: not a purchase
    ])
    mount()
    expect(screen.queryByRole('list')).toBeNull()
    openIt()
    const list = await screen.findByRole('list', { name: 'Payments in Compras (otros)' })
    expect(within(list).getAllByRole('listitem').map((li) => li.querySelector('.payment-name')?.firstChild?.textContent)).toEqual(['Compra EN TIENDA DOS', 'Compra EN TIENDA UNO'])
  })

  it('files a payment under another category on the owner’s say, takes it off this list, and tells the screen above', async () => {
    await db.transactions.bulkAdd([tx('2026-11-03', -1200, 'Compra EN TIENDA UNO'), tx('2026-11-09', -3400, 'Compra EN TIENDA DOS')])
    const onChanged = mount()
    openIt()
    await screen.findByRole('list', { name: 'Payments in Compras (otros)' })
    fireEvent.change(screen.getByRole('combobox', { name: 'Category for Compra EN TIENDA UNO' }), { target: { value: 'cat.groceries' } })
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('combobox', { name: 'Category for Compra EN TIENDA UNO' })).toBeNull()
    expect(screen.getByRole('combobox', { name: 'Category for Compra EN TIENDA DOS' })).toBeInTheDocument()
    const [moved] = await resolveMany([(await db.transactions.get('t1'))!])
    expect(moved?.categoryId).toBe('cat.groceries')
    // The bank's row itself is untouched: the owner's choice is kept beside it.
    expect((await db.transactions.get('t1'))?.ingSubcategory).toBe('Compras (otros)')
  })

  it('says so when nothing is filed there', async () => {
    mount()
    openIt()
    expect(await screen.findByText('No payments are filed here now.')).toBeInTheDocument()
  })
})
