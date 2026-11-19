import { ROUTES, useRoute, type RouteDef } from './routes'
import { useTheme, type ThemePreference } from './theme'

const GLYPH: Record<string, string> = {
  '/': '⌂', '/transactions': '☰', '/budget': '◔', '/intelligence': '✦', '/settings': '⚙',
}

/** Light, dark or the system's choice. Shown in the side bar on a wide screen and on the Settings page on a phone. */
export function ThemePicker({ className = '' }: { className?: string }) {
  const { theme, setTheme } = useTheme()
  return (
    <label className={`theme-picker ${className}`.trim()}>
      Theme
      <select value={theme} onChange={e => setTheme(e.target.value as ThemePreference)}>
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>
  )
}

/**
 * Five destinations, always visible: the tab bar on a phone, the side bar on a wide screen. Every other screen is a tab
 * inside one of the five (see SectionTabs), so nothing is hidden behind a menu. A destination is marked current while
 * any screen of its group is open.
 */
export default function Nav() {
  const { path } = useRoute()
  const group = ROUTES.find(r => r.path === path)?.group
  const link = (r: RouteDef) => (
    <a key={r.path} href={`#${r.path}`} className="nav-link"
       aria-current={r.path === path ? 'page' : r.group === group ? 'true' : undefined}>
      <span aria-hidden="true" className="nav-glyph">{GLYPH[r.path] ?? '•'}</span>
      <span>{r.title}</span>
    </a>
  )
  return (
    <nav aria-label="Main" className="nav">
      <div className="nav-primary">{ROUTES.filter(r => r.primary).map(link)}</div>
      <ThemePicker className="nav-theme" />
    </nav>
  )
}

/** The screens that share a destination, as a row of tabs above the content. Nothing is shown for a screen on its own. */
export function SectionTabs() {
  const { path } = useRoute()
  const current = ROUTES.find(r => r.path === path)
  const tabs = current?.tab === undefined ? [] : ROUTES.filter(r => r.group === current.group && r.tab !== undefined)
  if (tabs.length < 2) return null
  return (
    <nav aria-label="Sections" className="tabs">
      {tabs.map(r => (
        <a key={r.path} href={`#${r.path}`} className="tab" aria-current={r.path === path ? 'page' : undefined}>{r.tab}</a>
      ))}
    </nav>
  )
}
