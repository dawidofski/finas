import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react'
import Categories from './Categories'
import { db } from '../../db/db'
import { seedDatabase } from '../../db/seed'
import { addCategory } from '../../categories/store'
import { guardWording } from '../../test/wording'

configure({ asyncUtilTimeout: 8000 })
vi.setConfig({ testTimeout: 30_000 })
afterEach(() => { cleanup(); vi.restoreAllMocks() })
guardWording(4)

beforeEach(async () => {
  await db.delete(); await db.open(); await seedDatabase()
})

const mount = async () => {
  render(<Categories />)
  await screen.findByRole('heading', { level: 1, name: 'Categories' })
  await screen.findByRole('button', { name: 'Add rule' })
}
const fill = (label: RegExp | string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } })

describe('Categories screen', () => {
  it('lists the seeded Trading 212 rule and every leaf category with its kind in words', async () => {
    await mount()
    expect(screen.getByRole('button', { name: 'Remove rule: trading 212' })).toBeInTheDocument()
    expect(document.body.textContent).toContain('→ Investments')
    expect(document.body.textContent).toContain('Savings and investments')
    expect(screen.queryByRole('button', { name: /Remove category/ })).toBeNull()
  })

  it('adds a rule, lists it, and removes it', async () => {
    await mount()
    fill('When the description contains', 'cafe inventado')
    fill('File it under', 'cat.restaurants')
    fireEvent.click(screen.getByRole('button', { name: 'Add rule' }))
    const remove = await screen.findByRole('button', { name: 'Remove rule: cafe inventado' })
    expect(remove.closest('li')?.textContent).toContain('→ Cafeterías y restaurantes')
    expect((screen.getByLabelText('When the description contains') as HTMLInputElement).value).toBe('')
    fireEvent.click(remove)
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove rule: cafe inventado' })).toBeNull())
  })

  it('adds a category and removes it after an inline confirmation', async () => {
    await mount()
    fill('Name', 'Gimnasio inventado')
    fill('Kind', 'essential')
    fireEvent.click(screen.getByRole('button', { name: 'Add category' }))
    const remove = await screen.findByRole('button', { name: 'Remove category: Gimnasio inventado' })
    expect(remove.closest('li')?.textContent).toContain('Essentials')
    fireEvent.click(remove)
    expect(await screen.findByText(/go back to the bank/)).toBeInTheDocument()
    expect(await db.categories.get('cat.user.gimnasio-inventado')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Yes, remove it' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove category: Gimnasio inventado' })).toBeNull())
    expect(await db.categories.get('cat.user.gimnasio-inventado')).toBeUndefined()
  })

  it('can back out of removing a category', async () => {
    await addCategory('Taller inventado', 'discretionary')
    await mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Remove category: Taller inventado' }))
    fireEvent.click(screen.getByRole('button', { name: 'Keep it' }))
    expect(screen.getByRole('button', { name: 'Remove category: Taller inventado' })).toBeInTheDocument()
  })

  it('shows a refusal as an alert', async () => {
    await mount()
    fill('Name', 'Investments')
    fireEvent.click(screen.getByRole('button', { name: 'Add category' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/already have a category called "Investments"/)
    fill('When the description contains', 'x')
    fireEvent.click(screen.getByRole('button', { name: 'Add rule' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/2 to 60 characters/))
  })
})
