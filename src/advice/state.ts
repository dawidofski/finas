import { db } from '../db/db'
import type { RecommendationStateRow } from '../db/schema'

/** One dismissal is "not now"; the second is "not this". Exported so the screen can word it. */
export const SUPPRESS_AFTER_REJECTIONS = 2
export const SNOOZE_DAYS = 30
const DAY_MS = 86_400_000

/**
 * Stored decisions about advice, keyed by a string the caller supplies. This module never derives, normalises or
 * inspects a key (a key holding a changing figure would let a dismissal silently never take), and never reads the
 * clock: every function that needs "now" is given it.
 */

function fresh(key: string): RecommendationStateRow {
  return { key, status: 'active', shownCount: 0, rejectedCount: 0, lastShownAt: null, suppressedUntil: null, evidenceFingerprint: null }
}

async function update(key: string, change: (row: RecommendationStateRow) => void): Promise<void> {
  await db.transaction('rw', db.recommendationState, async () => {
    const row = (await db.recommendationState.get(key)) ?? fresh(key)
    change(row)
    await db.recommendationState.put(row)
  })
}

export async function recordShown(key: string, fingerprint: string, at: number): Promise<void> {
  await update(key, (row) => {
    row.shownCount += 1
    row.lastShownAt = at
    if (row.status === 'suppressed') return // showing never un-suppresses, and the owner's evidence marker stays as it was
    if (row.status === 'accepted') {
      if (row.evidenceFingerprint === fingerprint) return // the occurrence they already acted on
      row.status = 'active' // a fresh occurrence
    } else if (row.status === 'snoozed') {
      if (row.suppressedUntil !== null && row.suppressedUntil > at) return // still asleep
      row.status = 'active'
      row.suppressedUntil = null
    }
    row.evidenceFingerprint = fingerprint
  })
}

export async function recordAccepted(key: string, at: number): Promise<void> {
  void at
  await update(key, (row) => { row.status = 'accepted'; row.suppressedUntil = null })
}

export async function recordRejected(key: string, at: number): Promise<void> {
  void at
  await update(key, (row) => {
    row.rejectedCount += 1
    row.suppressedUntil = null
    row.status = row.rejectedCount >= SUPPRESS_AFTER_REJECTIONS ? 'suppressed' : 'rejected'
  })
}

export async function recordSnoozed(key: string, at: number): Promise<void> {
  await update(key, (row) => { row.status = 'snoozed'; row.suppressedUntil = at + SNOOZE_DAYS * DAY_MS })
}

/** Keys that must not be offered now, given the clock and each row's own fingerprint. One bulk read, whatever the count. */
export async function withheldKeys(fingerprints: ReadonlyMap<string, string>, now: number): Promise<ReadonlySet<string>> {
  const keys = [...fingerprints.keys()]
  const rows = await db.recommendationState.bulkGet(keys)
  const out = new Set<string>()
  rows.forEach((row, i) => {
    const key = keys[i]
    if (!row || key === undefined) return
    switch (row.status) {
      case 'suppressed': out.add(key); break // whatever the fingerprint
      case 'accepted': {
        const current = fingerprints.get(key)
        // Unknown on either side means we cannot show it is a new occurrence, so it stays away.
        if (current === undefined || row.evidenceFingerprint === null || current === row.evidenceFingerprint) out.add(key)
        break
      }
      case 'snoozed':
        if (row.suppressedUntil === null || row.suppressedUntil > now) out.add(key)
        break
      default: break // active, rejected once: offered
    }
  })
  return out
}
