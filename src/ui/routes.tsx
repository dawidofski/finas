import { useCallback, useSyncExternalStore, type ReactNode } from 'react'
import { epochMsToIso } from '../lib/dates'
import Budget from './screens/Budget'
import Dashboard from './screens/Dashboard'
import Reports from './screens/Reports'
import Score from './screens/Score'
import Learning from './screens/Learning'
import Recurring from './screens/Recurring'
import Goals from './screens/Goals'
import Import from './screens/Import'
import Intelligence from './screens/Intelligence'
import Mood from './screens/Mood'
import WorthIt from './screens/WorthIt'
import Settings from './screens/Settings'
import Transactions from './screens/Transactions'

export interface RouteDef { path: string; title: string; element: ReactNode; primary: boolean }

/** Placeholder screen. A later plan replaces each of these with the real thing. */
function Stub({ title }: { title: string }) {
  return (
    <section>
      <h1>{title}</h1>
      <p>Not built yet</p>
    </section>
  )
}

/**
 * Deliberately the UTC date (epochMsToIso). Local-timezone Date methods are banned because they shift a transaction's
 * date by a day depending on the device. The cost is a cosmetic window of up to two hours after local midnight at a
 * month boundary where the default month and the "still running" flag lag; every figure stays correct. Do not "fix"
 * it with local Date methods.
 *
 * The one place the running app reads the clock; the screen takes `today` as a parameter. Read per render so a tab left open past midnight does not keep yesterday's date. */
function BudgetRoute() {
  return <Budget today={epochMsToIso(Date.now())} />
}

/** The analytics cache stamps its rows with `computedAt`, so the instant is read here beside the day and both are handed down. */
function DashboardRoute() {
  const now = Date.now()
  return <Dashboard today={epochMsToIso(now)} computedAt={now} />
}

/** Same reading of the clock as the dashboard: the day and the instant together, handed down so no screen reads it. */
function ReportsRoute() {
  const now = Date.now()
  return <Reports today={epochMsToIso(now)} computedAt={now} />
}

/**
 * The day and the instant together, as the dashboard and the reports take them. The battery on this screen writes
 * cache rows, and `computedAt` is stored on every one of them: deriving it from the day inside the screen would
 * stamp them all "midnight UTC" whatever time it really was, which is a stored value that lies.
 */
function IntelligenceRoute() {
  const now = Date.now()
  return <Intelligence today={epochMsToIso(now)} computedAt={now} />
}

/** Same reading of the clock as the dashboard: the day and the instant together, because the score caches its measures. */
function ScoreRoute() {
  const now = Date.now()
  return <Score today={epochMsToIso(now)} computedAt={now} />
}

/** The advice shows when it was shown and snoozes from `computedAt`, so the instant is read here with the day and handed down. */
function LearningRoute() {
  const now = Date.now()
  return <Learning today={epochMsToIso(now)} computedAt={now} />
}

/** The day and the instant together, as the other screens that read the store take them. */
function RecurringRoute() {
  const now = Date.now()
  return <Recurring today={epochMsToIso(now)} computedAt={now} />
}

/** The day and the instant together: every change the owner makes here is dated by `computedAt`, so the screen never reads the clock. */
function GoalsRoute() {
  const now = Date.now()
  return <Goals today={epochMsToIso(now)} computedAt={now} />
}

function WorthItRoute() {
  return <WorthIt today={epochMsToIso(Date.now())} />
}

const screen = (path: string, title: string, primary = false): RouteDef =>
  ({ path, title, element: <Stub title={title} />, primary })

/** Order is the navigation order. The five `primary` entries make up the mobile tab bar. */
export const ROUTES: ReadonlyArray<RouteDef> = [
  { path: '/', title: 'Dashboard', element: <DashboardRoute />, primary: true },
  { path: '/import', title: 'Import', element: <Import />, primary: true },
  { path: '/transactions', title: 'Transactions', element: <Transactions />, primary: true },
  { path: '/budget', title: 'Budget', element: <BudgetRoute />, primary: true },
  { path: '/intelligence', title: 'Intelligence', element: <IntelligenceRoute />, primary: true },
  { path: '/mood', title: 'Mood', element: <Mood />, primary: false },
  { path: '/worth-it', title: 'Worth it?', element: <WorthItRoute />, primary: false },
  { path: '/learning', title: 'Learning', element: <LearningRoute />, primary: false },
  screen('/coach', 'AI coach'),
  { path: '/goals', title: 'Goals', element: <GoalsRoute />, primary: false },
  { path: '/recurring', title: 'Recurring', element: <RecurringRoute />, primary: false },
  { path: '/reports', title: 'Reports', element: <ReportsRoute />, primary: false },
  { path: '/score', title: 'Money Score', element: <ScoreRoute />, primary: false },
  { path: '/settings', title: 'Settings', element: <Settings />, primary: false },
]

const KNOWN = new Set(ROUTES.map(r => r.path))

/** `#/budget` -> `/budget`; a trailing slash and a query string are ignored. Anything unrecognised is the dashboard. */
function pathFromHash(hash: string): string {
  const raw = (hash.replace(/^#/, '').split('?')[0] ?? '')
  const path = raw.length > 1 ? raw.replace(/\/+$/, '') : raw
  return KNOWN.has(path || '/') ? path || '/' : '/'
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange)
  return () => window.removeEventListener('hashchange', onChange)
}

/** Hash routing over `hashchange`: refreshes and deep links work on static hosting with no rewrites. */
export function useRoute(): { path: string; navigate(path: string): void } {
  const path = pathFromHash(useSyncExternalStore(subscribe, () => window.location.hash))
  const navigate = useCallback((to: string) => { window.location.hash = `#${to}` }, [])
  return { path, navigate }
}
