/**
 * Per-device view preferences, kept in `localStorage` (ruling P3-R38). This is the second thing ever kept there, after
 * the theme mirror in theme.tsx, so the reason is written down:
 *
 * - It is how this device is arranged, not financial data. Whether the transaction filters are expanded says nothing
 *   about the owner's money.
 * - **The settings row travels inside the backup bundle.** Putting a UI toggle there would make it follow the owner
 *   from one machine to another on every restore, and a phone and a desktop want different answers.
 * - It would touch a stored row shape while section 29's schema gates are still closed.
 *
 * Every access is wrapped: in a private window, or with site data blocked, even reading `localStorage` can throw, and a
 * remembered panel is never worth a broken screen. A failed read means "use the default"; a failed write means "it will
 * not be remembered", and neither is reported.
 */
export const FILTERS_OPEN_KEY = 'finance.transactions.filtersOpen'

/** Shut by default: the daily screen should open on transactions, not on eight controls. */
export function readFiltersOpen(): boolean {
  try { return localStorage.getItem(FILTERS_OPEN_KEY) === '1' } catch { return false }
}

export function writeFiltersOpen(open: boolean): void {
  try { localStorage.setItem(FILTERS_OPEN_KEY, open ? '1' : '0') } catch { /* a view preference; the panel just will not be remembered */ }
}
