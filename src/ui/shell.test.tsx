import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, within, fireEvent, act } from '@testing-library/react'
import App from '../App'
import { ROUTES } from './routes'
import { db } from '../db/db'
import { seedDatabase, getSettings } from '../db/seed'

/** jsdom has no matchMedia; each test chooses its own system preference. */
function stubSystemDark(dark: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('prefers-color-scheme: dark') ? dark : false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  }))
}

beforeEach(async () => {
  await db.delete()
  await db.open()
  delete document.documentElement.dataset.theme
  window.location.hash = ''
  localStorage.clear()
  stubSystemDark(false)
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('shell', () => {
  it('declares all fourteen screens', () => {
    expect(ROUTES.map(r => r.path)).toEqual([
      '/', '/import', '/transactions', '/budget', '/intelligence', '/mood', '/worth-it',
      '/learning', '/coach', '/goals', '/recurring', '/reports', '/score', '/settings'])
  })
  it('renders the screen named by the hash', async () => {
    window.location.hash = '#/transactions'
    render(<App />)
    expect(await screen.findByRole('heading', { name: /transactions/i })).toBeInTheDocument()
  })
  it('offers a skip link that is first in the tab order and moves focus to the content without changing the route', async () => {
    window.location.hash = '#/budget'
    render(<App />)
    await screen.findByRole('heading', { level: 1, name: 'Budget' })
    const skip = screen.getByRole('link', { name: 'Skip to content' })
    const links = screen.getAllByRole('link')
    expect(links[0]).toBe(skip)
    fireEvent.click(skip)
    expect(document.activeElement).toBe(screen.getByRole('main'))
    expect(window.location.hash).toBe('#/budget')
  })
  it('falls back to the dashboard for an unknown hash', async () => {
    window.location.hash = '#/nope'
    render(<App />)
    expect(await screen.findByRole('heading', { name: /dashboard/i })).toBeInTheDocument()
  })
  it('navigating updates the hash and the screen without a reload', async () => {
    window.location.hash = '#/'
    render(<App />)
    expect(await screen.findByRole('heading', { level: 1, name: /dashboard/i })).toBeInTheDocument()
    const nav = screen.getByRole('navigation', { name: /main/i })
    fireEvent.click(within(nav).getByRole('link', { name: 'Budget' }))
    await waitFor(() => expect(window.location.hash).toBe('#/budget')) // jsdom applies fragment navigation asynchronously
    expect(await screen.findByRole('heading', { level: 1, name: 'Budget' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { level: 1, name: /dashboard/i })).not.toBeInTheDocument()
    expect(within(nav).getByRole('link', { name: 'Budget' })).toHaveAttribute('aria-current', 'page')
    expect(within(nav).getByRole('link', { name: 'Dashboard' })).not.toHaveAttribute('aria-current')
  })
  it.each(['#/budget/', '#/budget?x=1', '#/budget/?x=1'])('treats %s as the budget screen', async hash => {
    window.location.hash = hash
    render(<App />)
    expect(await screen.findByRole('heading', { level: 1, name: 'Budget' })).toBeInTheDocument()
  })
  it('responds to the browser changing the hash (back/forward)', async () => {
    render(<App />)
    expect(await screen.findByRole('heading', { level: 1, name: /dashboard/i })).toBeInTheDocument()
    // The dispatch synchronously runs useRoute's listener, which sets state in Nav and Screen. Outside act() that
    // update lands after the assertion below has already read the DOM, so the test would be pinning the pre-navigation
    // render and still pass. React says so with a warning; src/test/setup.ts turns it into a failure.
    act(() => {
      window.location.hash = '#/reports'
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    expect(await screen.findByRole('heading', { level: 1, name: 'Reports' })).toBeInTheDocument()
  })
  it('exposes exactly five primary destinations for the mobile tab bar', () => {
    expect(ROUTES.filter(r => r.primary).map(r => r.path)).toEqual(['/', '/import', '/transactions', '/budget', '/intelligence'])
  })
  it('stub screens say they are not built yet', async () => {
    window.location.hash = '#/coach'
    render(<App />)
    expect(await screen.findByRole('heading', { level: 1, name: 'AI coach' })).toBeInTheDocument()
    expect(screen.getByText('Not built yet')).toBeInTheDocument()
  })
  // A stub renders a level-1 heading with its title, exactly as a real screen does, so a heading assertion alone cannot tell
  // them apart: on a previous plan a headline screen was unreachable while every test passed. "Not built yet" is what tells them apart.
  const REAL = ['/', '/import', '/transactions', '/budget', '/intelligence', '/mood', '/worth-it', '/reports', '/score', '/learning', '/settings']
  const STUBS = ['/coach', '/goals', '/recurring']
  it('has pinned every route as either a real screen or a stub', () => {
    expect([...REAL, ...STUBS].sort()).toEqual(ROUTES.map(r => r.path).sort())
  })
  it.each(REAL)('%s is a real screen, not the stub', async path => {
    window.location.hash = `#${path}`
    render(<App />)
    const title = ROUTES.find(r => r.path === path)?.title ?? ''
    expect(await screen.findByRole('heading', { level: 1, name: title })).toBeInTheDocument()
    expect(screen.queryByText('Not built yet')).toBeNull()
  })
  it.each(STUBS)('%s is still a stub', async path => {
    window.location.hash = `#${path}`
    render(<App />)
    const title = ROUTES.find(r => r.path === path)?.title ?? ''
    expect(await screen.findByRole('heading', { level: 1, name: title })).toBeInTheDocument()
    expect(screen.getByText('Not built yet')).toBeInTheDocument()
  })
  /**
   * The router is the one place that reads the clock, and it hands down TWO readings of it: the day a screen's figures
   * are about, and the instant they were computed at, which is stored on every analytics cache row. The two cannot be
   * derived from one another — a screen working the instant out from the day would stamp every row it writes "midnight
   * UTC" whatever time it really was, and nothing would fail until someone shows the owner when a figure was computed.
   * The Intelligence screen is the one asserted here because its battery writes a row for each of the ten questions.
   */
  it('hands a screen the instant it read as well as the day, so a stored figure carries the real time', async () => {
    const AT = Date.UTC(2026, 10, 18, 16, 42, 13) // an afternoon, not midnight
    await seedDatabase()
    vi.spyOn(Date, 'now').mockReturnValue(AT)
    window.location.hash = '#/intelligence'
    render(<App />)
    await screen.findByRole('list', { name: 'Each question and what it can say' })
    const rows = (await db.analyticsCache.toArray()).filter(r => r.key.startsWith('battery'))
    expect(rows.length).toBeGreaterThan(5)
    for (const row of rows) expect(row.computedAt, row.key).toBe(AT)
    expect(rows.map(r => r.computedAt)).not.toContain(Date.UTC(2026, 10, 18)) // not the day it was derived from
  })

  it('persists a theme override to settings and applies it to the document', async () => {
    await seedDatabase()
    render(<App />)
    fireEvent.change(await screen.findByLabelText(/theme/i), { target: { value: 'dark' } })
    expect(document.documentElement.dataset.theme).toBe('dark')
    await waitFor(async () => expect((await getSettings()).theme).toBe('dark'))
  })
  it('restores a stored theme override on load', async () => {
    await seedDatabase()
    await db.settings.update('singleton', { theme: 'dark' })
    render(<App />)
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('dark'))
    expect(screen.getByLabelText(/theme/i)).toHaveValue('dark')
  })
  it('resolves system theme from prefers-color-scheme', async () => {
    stubSystemDark(true)
    await seedDatabase()
    render(<App />)
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('dark'))
    expect(screen.getByLabelText(/theme/i)).toHaveValue('system')
  })
  it('resolves system theme to light when the system prefers light', async () => {
    stubSystemDark(false)
    await seedDatabase()
    render(<App />)
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('light'))
  })
})

describe('More sheet', () => {
  const open = async () => {
    render(<App />)
    const toggle = await screen.findByRole('button', { name: 'More' })
    fireEvent.click(toggle)
    return toggle
  }
  it('announces expandability and moves focus into the sheet on open', async () => {
    render(<App />)
    const toggle = await screen.findByRole('button', { name: 'More' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(toggle).toHaveAttribute('aria-controls', 'nav-more')
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    const sheet = document.getElementById('nav-more')!
    expect(sheet).toHaveAttribute('data-open', 'true')
    expect(sheet.contains(document.activeElement)).toBe(true)
  })
  it('Escape closes the sheet and returns focus to the trigger', async () => {
    const toggle = await open()
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(document.getElementById('nav-more')).toHaveAttribute('data-open', 'false')
    expect(toggle).toHaveFocus()
  })
  it('a press outside closes it, but a press inside does not', async () => {
    const toggle = await open()
    fireEvent.pointerDown(document.getElementById('nav-more')!)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    fireEvent.pointerDown(document.body)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
  })
  it('activating a sheet link closes it and lands focus on the content', async () => {
    const toggle = await open()
    fireEvent.click(within(document.getElementById('nav-more')!).getByRole('link', { name: 'Mood' }))
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(document.activeElement).toBe(document.getElementById('main'))
  })
  it('closes when focus leaves the navigation', async () => {
    const toggle = await open()
    act(() => document.getElementById('main')!.focus())
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
  })
  it('stays open when focus moves between items inside it', async () => {
    const toggle = await open()
    act(() => screen.getByLabelText(/theme/i).focus())
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
  })
  it('ignores an Escape that a native control already consumed', async () => {
    const toggle = await open()
    const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    ev.preventDefault()
    screen.getByLabelText(/theme/i).dispatchEvent(ev)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
  })
  it('lists the secondary screens as list items', async () => {
    await open()
    const items = within(screen.getByRole('list')).getAllByRole('listitem')
    expect(items).toHaveLength(9)
  })
})

describe('theme mirror', () => {
  it('mirrors the preference to localStorage when it changes', async () => {
    render(<App />)
    fireEvent.change(await screen.findByLabelText(/theme/i), { target: { value: 'dark' } })
    expect(localStorage.getItem('finance.theme')).toBe('dark')
  })
  it('starts from the mirror so there is no flash of the wrong theme', async () => {
    localStorage.setItem('finance.theme', 'dark')
    render(<App />)
    expect(document.documentElement.dataset.theme).toBe('dark') // before any database read resolves
    expect(screen.getByLabelText(/theme/i)).toHaveValue('dark')
    await waitFor(async () => expect(await db.settings.count()).toBe(1)) // let the in-flight settings load finish before teardown
  })
  it('a change made while the settings read is in flight is not reverted by it', async () => {
    await seedDatabase()
    await db.settings.update('singleton', { theme: 'light' })
    render(<App />)
    fireEvent.change(screen.getByLabelText(/theme/i), { target: { value: 'dark' } }) // before the read resolves
    await waitFor(async () => expect((await getSettings()).theme).toBe('dark'))
    expect(screen.getByLabelText(/theme/i)).toHaveValue('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
  })
  it('does not raise an unhandled rejection when persisting fails', async () => {
    await seedDatabase()
    render(<App />)
    const select = await screen.findByLabelText(/theme/i)
    vi.spyOn(db.settings, 'update').mockRejectedValue(new Error('closed'))
    fireEvent.change(select, { target: { value: 'dark' } })
    await new Promise(r => setTimeout(r, 50)) // vitest fails the run on an unhandled rejection
    expect(document.documentElement.dataset.theme).toBe('dark')
  })
  it('still renders and themes when localStorage throws', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    stubSystemDark(true)
    render(<App />)
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('dark'))
    fireEvent.change(screen.getByLabelText(/theme/i), { target: { value: 'light' } })
    expect(document.documentElement.dataset.theme).toBe('light')
  })
})
