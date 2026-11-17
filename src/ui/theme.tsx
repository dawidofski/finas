import { createContext, useContext, useEffect, useMemo, useRef, useState, useCallback, type ReactNode } from 'react'
import { db } from '../db/db'
import { getSettings } from '../db/seed'

export type ThemePreference = 'system' | 'light' | 'dark'
type Resolved = 'light' | 'dark'
interface ThemeApi { theme: ThemePreference; resolved: Resolved; setTheme(t: ThemePreference): void }

const QUERY = '(prefers-color-scheme: dark)'
/** Fast-read mirror of the preference for the pre-paint script in index.html (same key there). IndexedDB stays the source of truth. */
export const THEME_MIRROR_KEY = 'finance.theme'

function readMirror(): ThemePreference {
  try {
    const v = localStorage.getItem(THEME_MIRROR_KEY)
    return v === 'light' || v === 'dark' || v === 'system' ? v : 'system'
  } catch { return 'system' } // blocked storage must not stop the app rendering
}
function writeMirror(t: ThemePreference) {
  try { localStorage.setItem(THEME_MIRROR_KEY, t) } catch { /* display cache only */ }
}
const ThemeContext = createContext<ThemeApi | null>(null)

function systemPrefersDark(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(QUERY).matches
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemePreference>(readMirror)
  const [systemDark, setSystemDark] = useState(systemPrefersDark)
  const changedByUser = useRef(false) // a setTheme call must win over a settings read still in flight

  // Load the stored override once. Until it arrives the system preference applies.
  useEffect(() => {
    let live = true
    getSettings().then(s => { if (live && !changedByUser.current) { setThemeState(s.theme); writeMirror(s.theme) } }, () => { /* the shell still works without it */ })
    return () => { live = false }
  }, [])

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia(QUERY)
    const onChange = () => setSystemDark(mq.matches)
    onChange()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  const resolved: Resolved = theme === 'system' ? (systemDark ? 'dark' : 'light') : theme
  useEffect(() => { document.documentElement.dataset.theme = resolved }, [resolved])

  const setTheme = useCallback((t: ThemePreference) => {
    changedByUser.current = true
    setThemeState(t)
    writeMirror(t)
    getSettings().then(() => db.settings.update('singleton', { theme: t })).catch(() => { /* the choice still applies for this session */ })
  }, [])

  const value = useMemo(() => ({ theme, resolved, setTheme }), [theme, resolved, setTheme])
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeApi {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>')
  return ctx
}
