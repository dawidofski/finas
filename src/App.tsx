import Nav from './ui/Nav'
import { ThemeProvider } from './ui/theme'
import { ROUTES, useRoute } from './ui/routes'

function Screen() {
  const { path } = useRoute()
  const route = ROUTES.find(r => r.path === path) ?? ROUTES[0]
  return <main id="main" className="screen" tabIndex={-1}>{route?.element}</main>
}

export default function App() {
  return (
    <ThemeProvider>
      {/* The route lives in the URL hash, so a plain href="#main" would navigate; move focus instead (WCAG 2.4.1). */}
      <a className="skip-link" href="#main" onClick={e => { e.preventDefault(); document.getElementById('main')?.focus() }}>Skip to content</a>
      <div className="shell">
        <Nav />
        <Screen />
      </div>
    </ThemeProvider>
  )
}
