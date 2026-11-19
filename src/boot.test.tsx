import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { db } from './db/db'
import * as seed from './db/seed'
import { boot } from './boot'
import App from './App'

beforeEach(async () => { await db.delete(); await db.open() })
afterEach(() => { vi.restoreAllMocks() })

describe('boot (seed on startup)', () => {
  it('seeds categories, moods, reasons and settings on a fresh database', async () => {
    expect(await db.categories.count()).toBe(0)
    expect(await boot()).toEqual({ ok: true })
    expect(await db.categories.count()).toBeGreaterThan(0)
    expect(await db.moods.count()).toBe(12)
    expect(await db.purchaseReasons.count()).toBe(8)
    expect(await db.settings.get('singleton')).toBeDefined()
  })

  it('is idempotent across launches: the account salt and owner edits survive', async () => {
    await boot()
    const salt = (await db.settings.get('singleton'))!.privacy.accountSalt
    await db.categories.update('cat.groceries', { kind: 'discretionary' })
    await boot()
    expect((await db.settings.get('singleton'))!.privacy.accountSalt).toBe(salt)
    expect((await db.categories.get('cat.groceries'))!.kind).toBe('discretionary')
  })

  it('has finished seeding before it resolves, so rendering App straight after cannot collide on settings', async () => {
    const seeding = vi.spyOn(seed, 'seedDatabase')
    await boot()
    expect(seeding).toHaveBeenCalledTimes(1)
    await seeding.mock.results[0]!.value // already settled
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<App />)
    await waitFor(() => expect(screen.getByRole('main')).toBeInTheDocument())
    expect(await db.settings.count()).toBe(1)
    // React's own notice about a test not waiting for a screen to finish loading is about this test, not about seeding:
    // the dashboard now carries a second card that loads on its own. Anything else logged is a failure.
    expect(errors.mock.calls.map(c => String(c[0])).filter(m => !m.includes('not wrapped in act'))).toEqual([])
  })

  it('turns a seeding failure into a storage-error result instead of throwing', async () => {
    vi.spyOn(seed, 'seedDatabase').mockRejectedValue(new Error('disk full'))
    const result = await boot()
    expect(result).toMatchObject({ ok: false, reason: 'unknown' })
    expect((result as { detail: string }).detail).toContain('disk full')
  })

  it('does not attempt to seed when the database cannot be opened', async () => {
    db.close()
    const seeding = vi.spyOn(seed, 'seedDatabase')
    const real = globalThis.indexedDB
    Object.defineProperty(globalThis, 'indexedDB', { value: { open: () => { throw new DOMException('denied', 'SecurityError') } }, configurable: true, writable: true })
    try {
      expect(await boot()).toMatchObject({ ok: false, reason: 'blocked' })
    } finally {
      Object.defineProperty(globalThis, 'indexedDB', { value: real, configurable: true, writable: true })
    }
    expect(seeding).not.toHaveBeenCalled()
  })
})
