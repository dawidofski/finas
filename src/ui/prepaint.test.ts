import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'

/** Runs the real public/theme-init.js against stand-in globals. */
const script = readFileSync(resolve(import.meta.dirname, '../../public/theme-init.js'), 'utf8')

function run(opts: { stored?: string | 'throw'; systemDark: boolean; noMatchMedia?: boolean }): string | undefined {
  const root = { dataset: {} as Record<string, string> }
  const localStorage = { getItem: () => { if (opts.stored === 'throw') throw new Error('blocked'); return opts.stored ?? null } }
  const matchMedia = (q: string) => ({ matches: q.includes('dark') && opts.systemDark })
  const mm = opts.noMatchMedia ? undefined : matchMedia
  new Function('document', 'window', 'localStorage', 'matchMedia', script)({ documentElement: root }, { matchMedia: mm }, localStorage, mm)
  return root.dataset.theme
}

describe('pre-paint theme script (public/theme-init.js)', () => {
  it('was found', () => { expect(script).toContain('finance.theme') })
  it('applies a stored dark override even when the system is light', () => { expect(run({ stored: 'dark', systemDark: false })).toBe('dark') })
  it('applies a stored light override even when the system is dark', () => { expect(run({ stored: 'light', systemDark: true })).toBe('light') })
  it('follows the system when the stored preference is system or absent', () => {
    expect(run({ stored: 'system', systemDark: true })).toBe('dark')
    expect(run({ systemDark: false })).toBe('light')
  })
  it('ignores garbage values', () => { expect(run({ stored: 'purple', systemDark: true })).toBe('dark') })
  it('falls back to light without matchMedia, and still honours a stored override', () => {
    expect(run({ systemDark: true, noMatchMedia: true })).toBe('light')
    expect(run({ stored: 'dark', systemDark: false, noMatchMedia: true })).toBe('dark')
  })
  it('still sets a theme when localStorage throws', () => { expect(run({ stored: 'throw', systemDark: true })).toBe('dark') })
})
