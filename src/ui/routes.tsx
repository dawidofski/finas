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
import Coach from './screens/Coach'
import Settings from './screens/Settings'
import Transactions from './screens/Transactions'

/** The five destinations of the navigation. Every screen belongs to one; 'none' is a screen reached another way. */
export type Group = 'home' | 'transactions' | 'budget' | 'insights' | 'settings' | 'none'

/**
 * `primary` marks the screen a destination opens on. `tab` is the screen's label in the row of tabs its group shows above
 * the content; a screen with no `tab` is not in that row (it is reached from a card or a link on another screen).
 */
export interface RouteDef { path: string; title: string; element: ReactNode; primary: boolean; group: Group; tab?: string }

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
  const today = epochMsToIso(now)
  // The purchases waiting for a second look sit under the month's figures, so there is no separate screen to remember.
  return <><Dashboard today={today} computedAt={now} /><WorthIt today={today} embedded /></>
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

/** The coach reads the same cached month totals as the Dashboard, so it takes the day and the instant the same way. */
function CoachRoute() {
  const now = Date.now()
  return <Coach today={epochMsToIso(now)} computedAt={now} />
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
  ({ path, title, element: <Stub title={title} />, primary, group: 'none' })

/**
 * The five `primary` entries, in this order, are the tab bar on a phone and the side bar on a wide screen. Within a group the
 * order here is the order of its tabs.
 */
export const ROUTES: ReadonlyArray<RouteDef> = [
  { path: '/', title: 'Dashboard', element: <DashboardRoute />, primary: true, group: 'home' },
  { path: '/worth-it', title: 'Worth it?', element: <WorthItRoute />, primary: false, group: 'home' },
  { path: '/mood', title: 'Mood', element: <Mood />, primary: false, group: 'home' },
  { path: '/transactions', title: 'Transactions', element: <Transactions />, primary: true, group: 'transactions', tab: 'All' },
  { path: '/recurring', title: 'Recurring', element: <RecurringRoute />, primary: false, group: 'transactions', tab: 'Recurring' },
  { path: '/budget', title: 'Budget', element: <BudgetRoute />, primary: true, group: 'budget', tab: 'Spending plan' },
  { path: '/goals', title: 'Goals', element: <GoalsRoute />, primary: false, group: 'budget', tab: 'Savings goals' },
  { path: '/intelligence', title: 'Intelligence', element: <IntelligenceRoute />, primary: true, group: 'insights', tab: 'Patterns' },
  { path: '/score', title: 'Money Score', element: <ScoreRoute />, primary: false, group: 'insights', tab: 'Score' },
  { path: '/learning', title: 'Learning', element: <LearningRoute />, primary: false, group: 'insights', tab: 'Advice' },
  { path: '/reports', title: 'Reports', element: <ReportsRoute />, primary: false, group: 'insights', tab: 'Month report' },
  { path: '/settings', title: 'Settings', element: <Settings />, primary: true, group: 'settings', tab: 'General' },
  { path: '/import', title: 'Import', element: <Import />, primary: false, group: 'settings', tab: 'Import a statement' },
  { path: '/coach', title: 'AI coach', element: <CoachRoute />, primary: false, group: 'none' },
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
