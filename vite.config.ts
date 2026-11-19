/// <reference types="vitest" />
import { defineConfig, type Plugin } from 'vite'
import { configDefaults } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

/**
 * Runtime enforcement of the network posture (design 14.4): the page may talk to its own origin and to ONE other
 * address, DeepSeek's, which is in connect-src and nowhere else: scripts, styles, images and fonts stay 'self'. The
 * only code that calls it is src/coach/request.ts, when the owner presses send. No 'unsafe-inline' or 'unsafe-eval':
 * the pre-paint theme script is the external public/theme-init.js for exactly that reason.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'self' https://api.deepseek.com",
  "manifest-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ')

/** Production build only: 'vite dev' needs a websocket for HMR and inline styles, so it gets no meta CSP. */
const contentSecurityPolicy = (): Plugin => ({
  name: 'finance-content-security-policy',
  apply: 'build',
  transformIndexHtml: () => [
    { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CONTENT_SECURITY_POLICY }, injectTo: 'head-prepend' },
  ],
})

export default defineConfig({
  base: './',
  plugins: [react(), contentSecurityPolicy(), VitePWA({
      registerType: 'autoUpdate',
      workbox: { clientsClaim: true, skipWaiting: true, cleanupOutdatedCaches: true },
      manifest: {
        name: 'Personal Finance Intelligence',
        short_name: 'Finance',
        description: 'Local-first personal finance. Your data stays in this browser.',
        display: 'standalone',
        theme_color: '#0a4d68',
        background_color: '#0a4d68',
        // Relative, so installation works under https://<user>.github.io/<repo>/ as well as at a domain root.
        start_url: '.',
        scope: '.',
        // 'any' and 'maskable' are deliberately separate assets. A single asset
        // declared as both is a common mistake: the maskable safe zone needs ~20%
        // padding, so one file is either over-padded as a plain icon or has its
        // edges cropped away as a maskable one.
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
      },
    })],
  test: {
    environment: 'jsdom',
    setupFiles: ['src/test/setup.ts'],
    globals: true,
    // build.test.ts inspects dist/, so it runs via `npm run verify:dist` after a build.
    exclude: [...configDefaults.exclude, 'src/build.test.ts'],
    // The backup tests derive real keys (about a second each, on every core they can get), so a screen test that
    // finishes in a second alone can pass the default 5 s when the whole suite runs. Slow under load, not wrong.
    testTimeout: 15000,
  },
})
