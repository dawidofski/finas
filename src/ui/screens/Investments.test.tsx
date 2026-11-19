import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import Investments from './Investments'
import { db } from '../../db/db'
import { seedDatabase, getSettings } from '../../db/seed'
import { exportBundle } from '../../db/backup'
import { importTrading212, investmentEvents } from '../../investments/store'
import { formatEur } from '../../lib/money'
import { guardWording } from '../../test/wording'

// Every row here is invented.
const HEAD = 'Action,Time (UTC),ISIN,Ticker,Name,Notes,ID,No. of shares,Price / share,Currency (Price / share),Exchange rate,Result,Currency (Result),Gross Total,Currency (Gross Total),Withholding tax,Currency (Withholding tax),Currency conversion fee,Currency (Currency conversion fee),Record Date'
const FILE = [
  HEAD,
  'Deposit,2026-01-05 10:00:00+00:00,,,,"Bank Transfer",dep-1,,,,,,,300.00,"EUR",,,,,',
  'Market buy,2026-01-05 10:05:00+00:00,XX0000000001,EJEM,"Empresa Ejemplo",,B1,10.0000000000,10.00,EUR,1.00,,,100.00,"EUR",,,0.15,"EUR",',
  'Market buy,2026-01-06 10:05:00+00:00,XX0000000002,OTRA,"Otra Empresa",,B2,2.5000000000,20.00,EUR,1.00,,,50.00,"EUR",,,,,',
  'Market sell,2026-02-01 10:00:00+00:00,XX0000000001,EJEM,"Empresa Ejemplo",,S1,5.0000000000,13.00,EUR,1.00,15.00,"EUR",65.00,"EUR",,,0.10,"EUR",',
  'Dividend (Dividend),2026-02-10 10:00:00+00:00,XX0000000002,OTRA,"Otra Empresa",,,2.5000000000,0.10,EUR,1.00,,,0.25,"EUR",,,,,',
  'ADR Fee,2026-02-11 10:00:00+00:00,XX0000000002,OTRA,"Otra Empresa",,,2.5,-0.03,USD,0.86,,,-0.26,"USD",,,,,2026-02-10',
].join('\n')
const MORE = [HEAD, 'Deposit,2026-03-05 10:00:00+00:00,,,,"Bank Transfer",dep-2,,,,,,,100.00,"EUR",,,,,', 'Deposit,2026-01-05 10:00:00+00:00,,,,"Bank Transfer",dep-1,,,,,,,300.00,"EUR",,,,,'].join('\n')

beforeEach(async () => { await db.delete(); await db.open(); await seedDatabase() })
afterEach(() => { cleanup() })
guardWording(4)

const flat = () => (document.body.textContent ?? '').replace(/ /g, ' ')
const pick = (text: string, name = 'history.csv') =>
  fireEvent.change(screen.getByLabelText(/Trading 212 history file/), { target: { files: [new File([text], name, { type: 'text/csv' })] } })

describe('storing investment rows', () => {
  it('stores a file once: a second upload of the same rows adds nothing, and an overlapping file adds only what is new', async () => {
    expect(await importTrading212(FILE)).toEqual({ inFile: 6, added: 6, already: 0 })
    expect(await importTrading212(FILE)).toEqual({ inFile: 6, added: 0, already: 6 })
    expect(await importTrading212(MORE)).toEqual({ inFile: 2, added: 1, already: 1 })
    expect(await investmentEvents()).toHaveLength(7)
  })

  it('changes nothing when the file is refused, and leaves the rest of the settings row alone', async () => {
    const before = await getSettings()
    await expect(importTrading212('not,a,broker,file\n1,2,3,4')).rejects.toThrow(/does not look like a Trading 212 history file/)
    await importTrading212(FILE)
    const after = await getSettings()
    expect({ ...after, investments: undefined }).toEqual({ ...before, investments: undefined })
  })

  it('travels in a backup', async () => {
    await importTrading212(FILE)
    expect(JSON.stringify(await exportBundle())).toContain('Empresa Ejemplo')
  })
})

describe('Investments screen', () => {
  it('starts empty, says how to begin, and offers the file', async () => {
    render(<Investments />)
    expect(await screen.findByText(/Nothing imported yet/)).toBeInTheDocument()
    expect(screen.getByLabelText(/Trading 212 history file/)).toHaveAttribute('accept', '.csv,text/csv')
  })

  it('imports a file and shows what was paid in, what the holdings cost, the result on sales, dividends and fees', async () => {
    render(<Investments />)
    await screen.findByText(/Nothing imported yet/)
    pick(FILE)
    expect((await screen.findByRole('status')).textContent).toBe('Added 6 rows.')
    await screen.findByRole('list', { name: 'Holdings' })
    const tiles = [...document.querySelectorAll('.stat')].map((t) => t.textContent?.replace(/ /g, ' '))
    expect(tiles).toEqual([
      `Paid in${formatEur(30000)}`,
      `Cost of what you hold${formatEur(10000)}`,   // 100 + 50 bought, less the 50 the shares sold had cost (65 received, 15 result)
      `Result on sales+${formatEur(1500)}`,
      `Dividends and interest${formatEur(25)}`,
      `Fees${formatEur(25)}`,
    ])
    const holdings = within(screen.getByRole('list', { name: 'Holdings' })).getAllByRole('listitem').map((li) => li.textContent?.replace(/ /g, ' '))
    expect(holdings).toEqual([`Empresa EjemploEJEM · 5 shares${formatEur(5000)}`, `Otra EmpresaOTRA · 2,5 shares${formatEur(5000)}`])
    expect(flat()).toMatch(/These are costs, not today.s values/)
    // The dollar fee is counted nowhere and is listed, in its own currency.
    expect(flat()).toContain('11/02/2026: ADR Fee, -0,26 USD')
  })

  it('says so when a second upload has nothing new, and refuses a file that is not the export without changing anything', async () => {
    await importTrading212(FILE)
    render(<Investments />)
    await screen.findByRole('list', { name: 'Holdings' })
    pick(FILE)
    expect((await screen.findByRole('status')).textContent).toBe('Nothing new: all 6 rows of that file were already here.')
    await waitFor(() => expect(screen.getByLabelText(/Trading 212 history file/)).not.toBeDisabled())
    pick('F. VALOR,CATEGORIA\n1,2', 'bank.csv')
    expect((await screen.findByRole('alert')).textContent).toMatch(/does not look like a Trading 212 history file.*Nothing was changed/)
    expect(await investmentEvents()).toHaveLength(6)
  })

  it('removes every investment row only after a second, explicit press, and touches nothing else', async () => {
    await importTrading212(FILE)
    render(<Investments />)
    await screen.findByRole('list', { name: 'Holdings' })
    fireEvent.click(screen.getByRole('button', { name: 'Remove all investment records' }))
    expect(await investmentEvents()).toHaveLength(6)
    fireEvent.click(screen.getByRole('button', { name: 'Yes, remove them all' }))
    await waitFor(async () => expect(await investmentEvents()).toHaveLength(0))
    expect(await screen.findByText(/Nothing imported yet/)).toBeInTheDocument()
    expect((await getSettings()).theme).toBe('system')
  })
})
