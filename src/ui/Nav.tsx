import { Fragment, useEffect, useRef, useState } from 'react'
import { ROUTES, useRoute } from './routes'
import { useTheme, type ThemePreference } from './theme'

const GLYPH: Record<string, string> = {
  '/': '⌂', '/import': '⇪', '/transactions': '☰', '/budget': '◔', '/intelligence': '✦',
}

export default function Nav() {
  const { path } = useRoute()
  const { theme, setTheme } = useTheme()
  const [moreOpen, setMoreOpen] = useState(false)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const sheetRef = useRef<HTMLDivElement>(null)

  // Sheet behaviour while open: focus moves in, Escape closes and hands focus back, an outside press closes.
  useEffect(() => {
    if (!moreOpen) return
    sheetRef.current?.querySelector<HTMLElement>('a, select')?.focus()
    const onKey = (e: KeyboardEvent) => {
      // A native control (the theme select) uses Escape to dismiss its own popup; leave the sheet alone then.
      if (e.key !== 'Escape' || e.defaultPrevented) return
      setMoreOpen(false)
      toggleRef.current?.focus()
    }
    const onPress = (e: Event) => {
      const t = e.target as Node
      if (!sheetRef.current?.contains(t) && !toggleRef.current?.contains(t)) setMoreOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPress)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPress)
    }
  }, [moreOpen])

  const link = (r: (typeof ROUTES)[number], inSheet = false) => (
    <a href={`#${r.path}`} className="nav-link" aria-current={r.path === path ? 'page' : undefined}
       onClick={() => {
         setMoreOpen(false)
         // The focused link is about to be hidden; land the user on the content they chose, not <body>.
         if (inSheet) document.getElementById('main')?.focus()
       }}>
      <span aria-hidden="true" className="nav-glyph">{GLYPH[r.path] ?? '•'}</span>
      <span>{r.title}</span>
    </a>
  )
  return (
    <nav aria-label="Main" className="nav"
         onBlur={e => { if (moreOpen && e.relatedTarget && !e.currentTarget.contains(e.relatedTarget as Node)) setMoreOpen(false) }}>
      <div className="nav-primary">
        {ROUTES.filter(r => r.primary).map(r => <Fragment key={r.path}>{link(r)}</Fragment>)}
      </div>
      <button ref={toggleRef} type="button" className="nav-more-toggle" aria-expanded={moreOpen} aria-controls="nav-more"
              onClick={() => setMoreOpen(o => !o)}>
        More
      </button>
      <div id="nav-more" ref={sheetRef} className="nav-more" data-open={moreOpen}>
        <ul className="nav-list">
          {ROUTES.filter(r => !r.primary).map(r => <li key={r.path}>{link(r, true)}</li>)}
        </ul>
        <label className="theme-picker">
          Theme
          <select value={theme} onChange={e => setTheme(e.target.value as ThemePreference)}>
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
      </div>
    </nav>
  )
}
