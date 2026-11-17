import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import ErrorBoundary from './ErrorBoundary'

afterEach(() => { vi.restoreAllMocks() })

function Boom(): never { throw new Error('screen exploded') }

describe('ErrorBoundary', () => {
  it('renders children when nothing throws', () => {
    render(<ErrorBoundary><p>fine</p></ErrorBoundary>)
    expect(screen.getByText('fine')).toBeInTheDocument()
  })
  it('replaces a throwing render with an explanation, not a blank page', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<ErrorBoundary><Boom /></ErrorBoundary>)
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent(/something went wrong/i)
    expect(alert).toHaveTextContent('screen exploded')
    expect(alert).toHaveTextContent(/not in your data/i)
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument()
  })
})
