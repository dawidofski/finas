import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const registerSW = vi.fn()
vi.mock('virtual:pwa-register', () => ({ registerSW: (o: unknown) => registerSW(o) }))
import { registerServiceWorker, resumeReload, suspendReload, UPDATE_CHECK_MS } from './pwa'

type Opts = { immediate?: boolean; onNeedReload?: () => void; onRegisteredSW?: (url: string, reg?: unknown) => void }

beforeEach(() => {
  registerSW.mockReset()
  vi.useFakeTimers()
  vi.stubGlobal('navigator', { ...navigator, serviceWorker: {}, onLine: true })
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('service worker registration', () => {
  it('registers immediately with an explicit reload path', () => {
    const reload = vi.fn()
    registerServiceWorker(reload)
    const opts = registerSW.mock.calls[0]![0] as Opts
    expect(opts.immediate).toBe(true)
    opts.onNeedReload!()
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('checks for an update on an interval, and when the tab becomes visible again', () => {
    registerServiceWorker(() => {})
    const update = vi.fn().mockResolvedValue(undefined)
    ;(registerSW.mock.calls[0]![0] as Opts).onRegisteredSW!('sw.js', { update })
    expect(update).not.toHaveBeenCalled()
    vi.advanceTimersByTime(UPDATE_CHECK_MS)
    expect(update).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(UPDATE_CHECK_MS * 2)
    expect(update).toHaveBeenCalledTimes(3)
    document.dispatchEvent(new Event('visibilitychange'))
    expect(update).toHaveBeenCalledTimes(4)
  })

  it('swallows a failed update check (offline) and skips it while offline', async () => {
    registerServiceWorker(() => {})
    const update = vi.fn().mockRejectedValue(new Error('offline'))
    ;(registerSW.mock.calls[0]![0] as Opts).onRegisteredSW!('sw.js', { update })
    vi.advanceTimersByTime(UPDATE_CHECK_MS)
    await Promise.resolve()
    vi.stubGlobal('navigator', { ...navigator, serviceWorker: {}, onLine: false })
    vi.advanceTimersByTime(UPDATE_CHECK_MS)
    expect(update).toHaveBeenCalledTimes(1)
  })

  it('does nothing in a browser without service workers', () => {
    vi.stubGlobal('navigator', {})
    registerServiceWorker(() => {})
    expect(registerSW).not.toHaveBeenCalled()
  })
})

describe('reload suspension', () => {
  const reloadRequest = () => (registerSW.mock.calls.at(-1)![0] as Opts).onNeedReload!()

  it('defers a reload requested while suspended and fires it once on resume', () => {
    const reload = vi.fn()
    registerServiceWorker(reload)
    suspendReload()
    reloadRequest()
    reloadRequest()
    expect(reload).not.toHaveBeenCalled()
    resumeReload()
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('holds until every holder has resumed', () => {
    const reload = vi.fn()
    registerServiceWorker(reload)
    suspendReload()
    suspendReload()
    reloadRequest()
    resumeReload()
    expect(reload).not.toHaveBeenCalled()
    resumeReload()
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('reloads at once when nothing is suspended, and a stray resume does not go negative', () => {
    const reload = vi.fn()
    registerServiceWorker(reload)
    resumeReload()
    suspendReload()
    resumeReload()
    reloadRequest()
    expect(reload).toHaveBeenCalledTimes(1)
  })
})
