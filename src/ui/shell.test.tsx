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
  it('declares every screen, in navigation order', () => {
    expect(ROUTES.map(r => r.path)).toEqual([
      '/', '/worth-it', '/transactions', '/recurring', '/budget', '/goals', '/investments', '/intelligence',
      '/score', '/learning', '/reports', '/settings', '/import', '/categories', '/coach'])
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
    expect(ROUTES.filter(r => r.primary).map(r => r.path)).toEqual(['/', '/transactions', '/budget', '/intelligence', '/settings'])
  })
  // A stub renders a level-1 heading with its title, exactly as a real screen does, so a heading assertion alone cannot tell
  // them apart: on a previous plan a headline screen was unreachable while every test passed. "Not built yet" is what tells them apart.
  const REAL = ['/', '/import', '/transactions', '/budget', '/intelligence', '/worth-it', '/reports', '/score', '/learning', '/recurring', '/goals', '/coach', '/settings', '/categories', '/investments']
  // Every screen is built. The list stays, empty, so a placeholder added later has to be pinned here to pass.
  const STUBS: string[] = []
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
  it('every placeholder still says it is not built', async () => {
    for (const path of STUBS) {
      window.location.hash = `#${path}`
      const view = render(<App />)
      const title = ROUTES.find(r => r.path === path)?.title ?? ''
      expect(await screen.findByRole('heading', { level: 1, name: title })).toBeInTheDocument()
      expect(screen.getByText('Not built yet')).toBeInTheDocument()
      view.unmount()
    }
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

describe('navigation: five destinations, everything else a tab inside one', () => {
  const at = async (hash: string) => {
    window.location.hash = hash
    render(<App />)
    return screen.findByRole('navigation', { name: 'Main' })
  }
  const tabs = () => within(screen.getByRole('navigation', { name: 'Sections' })).getAllByRole('link')

  it('shows the five destinations and no menu to open', async () => {
    const main = await at('#/')
    expect(within(main).getAllByRole('link').map(a => a.querySelector('span:last-child')?.textContent)).toEqual(['Dashboard', 'Transactions', 'Budget', 'Intelligence', 'Settings'])
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull()
  })

  it.each([
    ['#/transactions', ['All', 'Recurring'], 'All', 'Transactions'],
    ['#/recurring', ['All', 'Recurring'], 'Recurring', 'Transactions'],
    ['#/budget', ['Spending plan', 'Savings goals', 'Investments'], 'Spending plan', 'Budget'],
    ['#/goals', ['Spending plan', 'Savings goals', 'Investments'], 'Savings goals', 'Budget'],
    ['#/investments', ['Spending plan', 'Savings goals', 'Investments'], 'Investments', 'Budget'],
    ['#/intelligence', ['Patterns', 'Score', 'Advice', 'Month report'], 'Patterns', 'Intelligence'],
    ['#/score', ['Patterns', 'Score', 'Advice', 'Month report'], 'Score', 'Intelligence'],
    ['#/import', ['General', 'Import a statement', 'Categories'], 'Import a statement', 'Settings'],
    ['#/categories', ['General', 'Import a statement', 'Categories'], 'Categories', 'Settings'],
  ])('%s shows its group of tabs, marks its own, and keeps its destination lit', async (hash, labels, own, destination) => {
    const main = await at(hash)
    expect(tabs().map(a => a.textContent)).toEqual(labels)
    expect(tabs().filter(a => a.getAttribute('aria-current') === 'page').map(a => a.textContent)).toEqual([own])
    const lit = within(main).getAllByRole('link').filter(a => a.hasAttribute('aria-current'))
    expect(lit).toHaveLength(1)
    expect(lit[0]?.textContent).toContain(destination)
  })

  it('every screen with a tab is reachable from its group, and every screen is in a group or reached another way', () => {
    for (const r of ROUTES) {
      if (r.tab !== undefined) expect(ROUTES.some(p => p.primary && p.group === r.group), r.path).toBe(true)
    }
    // The screens with no tab: the dashboard (a destination on its own), the queue it carries as a card, and the coach (the floating button).
    expect(ROUTES.filter(r => r.tab === undefined).map(r => r.path)).toEqual(['/', '/worth-it', '/coach'])
  })

  it('shows no tabs on a screen that stands alone', async () => {
    await at('#/')
    expect(screen.queryByRole('navigation', { name: 'Sections' })).toBeNull()
  })

  it('a tab is a link, so choosing one changes the screen', async () => {
    await at('#/budget')
    expect(tabs().map(a => a.getAttribute('href'))).toEqual(['#/budget', '#/goals', '#/investments'])
    await act(async () => { window.location.hash = '#/goals' })
    expect(await screen.findByRole('heading', { level: 1, name: 'Goals' })).toBeInTheDocument()
  })

  it('offers the AI coach from every screen, as a link to it, and not on the coach screen itself', async () => {
    await at('#/budget')
    expect(screen.getByRole('link', { name: 'Ask the AI coach' })).toHaveAttribute('href', '#/coach')
    await act(async () => { window.location.hash = '#/coach' })
    await screen.findByRole('heading', { level: 1, name: 'AI coach' })
    expect(screen.queryByRole('link', { name: 'Ask the AI coach' })).toBeNull()
  })

  it('offers the theme on the Settings screen as well as in the side bar', async () => {
    await at('#/settings')
    expect(screen.getAllByLabelText(/theme/i)).toHaveLength(2)
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
