import 'fake-indexeddb/auto'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach } from 'vitest'

/**
 * React's "not wrapped in act(...)" warning means a component updated its state after the test stopped looking:
 * an awaited load resolving once the test body had already asserted. The assertions still pass, because they ran
 * before the update, which is precisely the problem — the test is pinning a render that is not the final one, and
 * on a slower machine it can pin a different one. This project has already found four tests that passed for the
 * wrong reason, so these warnings are failures here rather than noise in a log.
 *
 * It was CI that surfaced them, not this suite: the warning is timing-dependent and a developer machine is fast
 * enough to miss it. Turning it into a failed assertion is what makes it reproducible at all.
 *
 * Known limit: a test that replaces `console.error` with its own spy (ErrorBoundary and boot do, deliberately)
 * hides warnings raised while that spy is installed. Those tests assert on console.error themselves, so the
 * substitution is their point; the check still covers the window after the spy is restored, which is where a late
 * update lands.
 */
const ACT_WARNING = /not wrapped in act/

let actWarnings: string[] = []
const realConsoleError = console.error.bind(console)

beforeEach(() => {
  actWarnings = []
  console.error = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && ACT_WARNING.test(args[0])) actWarnings.push(args[0])
    realConsoleError(...args)
  }
})

afterEach(() => {
  console.error = realConsoleError
  if (actWarnings.length > 0) {
    const seen = [...new Set(actWarnings)].join('\n  ')
    actWarnings = []
    throw new Error(
      `A component updated outside act(...), so this test asserted on a render that was not the final one.\n` +
      `Await what the component is loading (findBy*, waitFor on the settled content) instead of asserting straight after render.\n  ${seen}`,
    )
  }
})
