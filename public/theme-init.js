// Pre-paint theme. Reads the mirror written by src/ui/theme.tsx (key: finance.theme); IndexedDB stays the source of truth.
// A separate classic script rather than an inline one so the Content-Security-Policy needs no 'unsafe-inline'
// (design 14.4). It must stay a blocking script in <head>: it sets the theme before first paint.
(function () {
  var t = 'system'
  try { var v = localStorage.getItem('finance.theme'); if (v === 'light' || v === 'dark' || v === 'system') t = v } catch (e) { /* blocked storage */ }
  var dark = t === 'dark' || (t === 'system' && window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
})()
