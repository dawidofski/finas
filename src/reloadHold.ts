/**
 * A reload requested while any holder has reload suspended is remembered and fired on the last resume. A
 * counter, not a flag, so two overlapping holders cannot release each other's hold.
 */
let suspensions = 0
let deferredReload: (() => void) | null = null

/**
 * Held while the owner has an import preview open. A reload discards the page's memory, and with it a preview
 * and every correction typed into it; an update can wait until the work is committed or abandoned.
 */
export function suspendReload(): void { suspensions += 1 }

/** Releases one hold. When the last is released, a reload that was asked for meanwhile fires now. */
export function resumeReload(): void {
  if (suspensions === 0) return
  suspensions -= 1
  if (suspensions === 0 && deferredReload) {
    const reload = deferredReload
    deferredReload = null
    reload()
  }
}

/** Runs `reload` now, or remembers it (the latest request wins) until the last hold is released. */
export function requestReload(reload: () => void): void {
  if (suspensions > 0) deferredReload = reload
  else reload()
}
