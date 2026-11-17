import { registerSW } from 'virtual:pwa-register'
import { requestReload } from './reloadHold'

// Part of this module's interface; kept in reloadHold.ts so screens can hold a reload without importing the
// generated virtual module, which only exists in a Vite build.
export { resumeReload, suspendReload } from './reloadHold'

/** How often an installed app left open re-checks for a new version. */
export const UPDATE_CHECK_MS = 60 * 60 * 1000

/**
 * Registers the service worker and keeps the running page in step with it.
 *
 * Why this exists: the worker is generated with skipWaiting + clientsClaim + cleanupOutdatedCaches, so a
 * new version activates at once, takes over the open page and deletes the old precache. A page that keeps
 * running its old JavaScript would then request hashed chunks that exist neither in cache nor on the server
 * (any lazy-loaded import breaks mid-flight). The page must therefore reload as soon as the new worker
 * takes over. With registerType 'autoUpdate' the generated code reloads on activation; onNeedReload makes
 * that path explicit here. Browsers check for a new worker on navigation only, so a PWA left open for days
 * would run an old version indefinitely; the periodic update() fixes that.
 */
export function registerServiceWorker(reload: () => void = () => window.location.reload()): void {
  if (!('serviceWorker' in navigator)) return
  const check = (reg: ServiceWorkerRegistration) => {
    // Offline or a server hiccup is not an error worth surfacing: the next tick tries again.
    if (navigator.onLine !== false) void reg.update().catch(() => { /* retried next interval */ })
  }
  registerSW({
    immediate: true,
    onNeedReload: () => requestReload(reload),
    onRegisteredSW(_url, reg) {
      if (!reg) return
      setInterval(() => check(reg), UPDATE_CHECK_MS)
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(reg) })
    },
  })
}
