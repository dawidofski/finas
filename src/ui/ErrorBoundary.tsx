import { Component, type ErrorInfo, type ReactNode } from 'react'

/**
 * Catches a render-time throw anywhere below it, so a bug in a screen produces an explanation
 * instead of the blank white page StorageError exists to prevent. Deliberately a sibling of
 * StorageError, not a reuse: its copy is about storage, and this failure says nothing about the data.
 */
export default class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Render failure', error, info.componentStack) // local console only: nothing leaves the device
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <main role="alert" style={{ maxWidth: '40rem', margin: '3rem auto', padding: '0 1rem', fontFamily: 'system-ui, sans-serif' }}>
        <h1>Something went wrong showing this screen</h1>
        <p>This is a fault in the app, not in your data: nothing here indicates that anything stored on this device was changed or lost.</p>
        <h2>What to do</h2>
        <p>Reload the page. If the same thing happens again, avoid the screen you were on and report the technical detail below. Do not clear site data: it holds your history, and a backup file is the only other copy.</p>
        <p><button type="button" onClick={() => window.location.reload()}>Reload</button></p>
        <p><small>Technical detail: {error.name}: {error.message}</small></p>
      </main>
    )
  }
}
