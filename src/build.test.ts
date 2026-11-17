import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'

const dist = resolve(import.meta.dirname, '../dist')

describe('production build', () => {
  const html = () => readFileSync(resolve(dist, 'index.html'), 'utf8')

  it('emits relative asset URLs so any Pages path works', () => {
    expect(html()).toMatch(/(src|href)="\.\/assets\//)
  })
  it('emits no root-absolute src/href anywhere, which would break under a Pages subpath', () => {
    expect(html()).not.toMatch(/(?:src|href)\s*=\s*["']?\//i)
  })
  it('generates a service worker that actually claims clients and cleans old caches', () => {
    const sw = readFileSync(resolve(dist, 'sw.js'), 'utf8')
    // Calls, not mentions: a bare identifier or a comment would satisfy a plain substring match.
    expect(sw).toMatch(/self\.skipWaiting\(\)/)
    expect(sw).toMatch(/\.clientsClaim\(\)/)
    expect(sw).toMatch(/\.cleanupOutdatedCaches\(\)/)
  })
  it('registers that worker from the page and reloads when a new one takes over', () => {
    // clientsClaim + cleanupOutdatedCaches without a page reload leaves the open page running old JS
    // whose hashed chunks have been deleted. Registration must exist in the shipped bundle, not just in config.
    const assets = readdirSync(resolve(dist, 'assets')).filter(f => f.endsWith('.js')).map(f => readFileSync(resolve(dist, 'assets', f), 'utf8'))
    const page = assets.find(a => a.includes('serviceWorker') && a.includes('sw.js'))
    expect(page, 'no bundle registers ./sw.js').toBeDefined()
    expect(page).toMatch(/activated[`'"]\s*,\s*\w+\s*=>\s*\{[^}]*(?:isUpdate)[^}]*\}/)
    expect(page).toMatch(/location\.reload\(\)/)
    expect(page).toMatch(/\.update\(\)/) // the periodic update check
    expect(html()).not.toMatch(/registerSW\.js/) // the plugin's fallback injection would mean the explicit path is bypassed
  })
  it('precaches every built chunk, so a lazy import offline or after an update is never a 404', () => {
    const sw = readFileSync(resolve(dist, 'sw.js'), 'utf8')
    for (const f of readdirSync(resolve(dist, 'assets'))) expect(sw, f).toContain(`assets/${f}`)
  })
  it('ships a Content-Security-Policy that allows only its own origin', () => {
    const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html())?.[1]?.replaceAll('&#39;', "'")
    expect(csp, 'no CSP meta tag').toBeDefined()
    expect(csp).toMatch(/default-src 'self'/)
    expect(csp).toMatch(/connect-src 'self'(;|$)/)
    expect(csp).toMatch(/script-src 'self'(;|$)/)
    expect(csp).toMatch(/object-src 'none'/)
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|https?:|\*/)
    // The page must carry no inline script, or the policy would block it.
    expect(html()).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/)
    expect(html().slice(0, 1024)).toContain('charset') // a long meta ahead of it must not push the charset out of the first 1024 bytes
  })
  it('loads the pre-paint theme script as a blocking classic script from the same origin', () => {
    expect(html()).toMatch(/<script src="\.\/theme-init\.js"><\/script>/)
    expect(existsSync(resolve(dist, 'theme-init.js'))).toBe(true)
  })
  it('scopes the manifest relatively so a Pages subpath installs', () => {
    const m = JSON.parse(readFileSync(resolve(dist, 'manifest.webmanifest'), 'utf8'))
    expect(m.start_url).toBe('.')
    expect(m.scope).toBe('.')
  })
  it('references no third-party origin from the page or its stylesheets (privacy: no CDN)', () => {
    const css = readdirSync(resolve(dist, 'assets')).filter(f => f.endsWith('.css')).map(f => readFileSync(resolve(dist, 'assets', f), 'utf8'))
    expect(css.length).toBeGreaterThan(0)
    for (const text of [html(), ...css]) {
      expect(text.replaceAll('http://www.w3.org/2000/svg', '')).not.toMatch(/https?:\/\//i)
    }
  })
  it('emits .nojekyll so hashed asset filenames are served', () => {
    expect(existsSync(resolve(dist, '.nojekyll'))).toBe(true)
  })
})
