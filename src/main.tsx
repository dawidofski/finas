import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './ui/app.css'
import StorageError from './ui/StorageError'
import ErrorBoundary from './ui/ErrorBoundary'
import { boot } from './boot'
import { registerServiceWorker } from './pwa'

const container = document.getElementById('root')!
// Shown until the database open resolves, so the owner never sees a white page.
const loading = document.createElement('p')
loading.setAttribute('role', 'status')
loading.textContent = 'Opening your data…'
container.replaceChildren(loading)
const root = createRoot(container)

// Render only after open AND seed have finished (see boot.ts for the race this avoids).
void boot().then(result => {
  root.render(
    <StrictMode>
      <ErrorBoundary>
        {result.ok ? <App /> : <StorageError reason={result.reason} detail={result.detail} />}
      </ErrorBoundary>
    </StrictMode>,
  )
})

if (import.meta.env.PROD) registerServiceWorker()
