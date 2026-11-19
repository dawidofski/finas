import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { AccountsCard } from './AccountsCard'
import { accountBalances } from '../accounts/balances'
import { db } from '../db/db'
import { seedDatabase } from '../db/seed'
import type { AccountRow, TransactionRow } from '../db/schema'
import { formatEur } from '../lib/money'
import { guardWording } from '../test/wording'

let n = 0
const account = (id: string, label: string, archived = false): AccountRow => ({
  id, fingerprint: id.repeat(64), label, last4: '0000', currency: 'EUR', createdAt: 1, archived,
})
const tx = (accountId: string, valueDate: string, balanceCents: number, over: Partial<TransactionRow> = {}): TransactionRow => ({
  id: `t${++n}`, accountId, valueDate, amountCents: -100, balanceCents, description: 'Compra EN TIENDA EJEMPLO', comment: null,
  ingCategory: null, ingSubcategory: null, kind: 'spend', dedupKey: `K${n}`, importId: 'imp', fileSeq: n, roundupParentId: null,
  createdAt: 1, deletedAt: null, ...over,
})

beforeEach(async () => { n = 0; await db.delete(); await db.open(); await seedDatabase() })
afterEach(() => { cleanup() })
guardWording(1)

describe('account balances', () => {
  it('gives the bank balance beside the newest movement of each account, and leaves out archived and empty accounts', async () => {
    await db.accounts.bulkAdd([account('a', 'Cuenta ejemplo'), account('b', 'Ahorro ejemplo'), account('c', 'Vieja', true), account('d', 'Sin movimientos')])
    await db.transactions.bulkAdd([
      tx('a', '2026-10-01', 50000), tx('a', '2026-11-10', 123456), tx('a', '2026-11-02', 99999),
      tx('b', '2026-09-30', 800000),
      tx('c', '2026-11-11', 1),
    ])
    expect(await accountBalances()).toEqual([
      { accountId: 'b', label: 'Ahorro ejemplo', last4: '0000', balanceCents: 800000, asOf: '2026-09-30' },
      { accountId: 'a', label: 'Cuenta ejemplo', last4: '0000', balanceCents: 123456, asOf: '2026-11-10' },
    ])
  })

  it('on a day with several movements takes the one nearest the top of the newest file', async () => {
    await db.accounts.add(account('a', 'Cuenta ejemplo'))
    await db.transactions.bulkAdd([
      tx('a', '2026-11-10', 300, { fileSeq: 3, createdAt: 5 }),
      tx('a', '2026-11-10', 100, { fileSeq: 1, createdAt: 5 }),
      tx('a', '2026-11-10', 200, { fileSeq: 2, createdAt: 5 }),
      tx('a', '2026-11-10', 999, { fileSeq: 1, createdAt: 2 }),   // an older import of the same day
    ])
    expect((await accountBalances())[0]?.balanceCents).toBe(100)
  })
})

describe('accounts card', () => {
  it('shows nothing until an account has movements', async () => {
    const { container } = render(<AccountsCard />)
    await waitFor(async () => expect(await db.accounts.count()).toBe(0))
    expect(container.textContent).toBe('')
  })

  it('lists each account with its balance and date, and the sum when there is more than one', async () => {
    await db.accounts.bulkAdd([account('a', 'Cuenta ejemplo'), account('b', 'Ahorro ejemplo')])
    await db.transactions.bulkAdd([tx('a', '2026-11-10', 123456), tx('b', '2026-09-30', 800000)])
    render(<AccountsCard />)
    await screen.findByRole('heading', { level: 2, name: 'Your accounts' })
    const items = screen.getAllByRole('listitem').map((li) => li.textContent?.replace(/ /g, ' '))
    expect(items).toEqual([`Ahorro ejemploBalance on 30/09/2026${formatEur(800000)}`, `Cuenta ejemploBalance on 10/11/2026${formatEur(123456)}`])
    expect(document.body.textContent?.replace(/ /g, ' ')).toContain(`Together${formatEur(923456)}`)
  })

  it('shows no sum for a single account', async () => {
    await db.accounts.add(account('a', 'Cuenta ejemplo'))
    await db.transactions.add(tx('a', '2026-11-10', 123456))
    render(<AccountsCard />)
    await screen.findByRole('heading', { level: 2, name: 'Your accounts' })
    expect(document.body.textContent).not.toMatch(/Together/)
  })
})
