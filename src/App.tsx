import Nav, { SectionTabs, ThemePicker } from './ui/Nav'
import { ThemeProvider } from './ui/theme'
import { ROUTES, useRoute } from './ui/routes'

function Screen() {
  const { path } = useRoute()
  const route = ROUTES.find(r => r.path === path) ?? ROUTES[0]
  return (
    <main id="main" className="screen" tabIndex={-1}>
      <SectionTabs />
      {route?.element}
      {/* On a phone the side bar's theme choice is not on screen, so it is offered here, at the foot of Settings. */}
      {path === '/settings' && <ThemePicker className="settings-theme" />}
    </main>
  )
}

/** The AI coach, one tap away from every screen. It is a link to the coach screen, which is where anything is shown or sent. */
function CoachButton() {
  const { path } = useRoute()
  if (path === '/coach') return null
  return (
    <a className="fab" href="#/coach" aria-label="Ask the AI coach">
      <span aria-hidden="true">✦</span>
    </a>
  )
}

export default function App() {
  return (
    <ThemeProvider>
      {/* The route lives in the URL hash, so a plain href="#main" would navigate; move focus instead (WCAG 2.4.1). */}
      <a className="skip-link" href="#main" onClick={e => { e.preventDefault(); document.getElementById('main')?.focus() }}>Skip to content</a>
      <div className="shell">
        <Nav />
        <Screen />
        <CoachButton />
      </div>
    </ThemeProvider>
  )
}
