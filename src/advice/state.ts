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

/**
 * `suppressed` is terminal: every writer below returns early on it, so no call order (a stale second tab, an
 * out-of-order screen) can bring back advice the owner rejected twice. A suppressed row is not touched at all.
 */
export async function recordShown(key: string, fingerprint: string, at: number): Promise<void> {
  await update(key, (row) => {
    if (row.status === 'suppressed') return // untouched: counts, time and the evidence the owner dismissed all stay as they were
    row.shownCount += 1
    row.lastShownAt = at
    if (row.status === 'accepted' && row.evidenceFingerprint === fingerprint) return // the occurrence they already acted on
    if (row.status === 'snoozed') {
      if (row.suppressedUntil !== null && row.suppressedUntil > at) return // still asleep
      row.suppressedUntil = null
    }
    // Back to 'active' (from rejected, a fresh accepted occurrence, an expired snooze): this is what makes a later
    // rejection count as a separate showing rather than a double-fire.
    row.status = 'active'
    row.evidenceFingerprint = fingerprint
  })
}

export async function recordAccepted(key: string): Promise<void> {
  await update(key, (row) => {
    if (row.status === 'suppressed') return
    row.status = 'accepted'
    row.suppressedUntil = null
  })
}

/**
 * Counts once per showing. 'active' (set only by recordShown) means shown and not yet acted on, so a rejection counts only
 * then, or when there is no row at all (a first rejection the screen never recorded a showing for). Any other status
 * (rejected: a double-fire; snoozed, accepted: an out-of-order call; suppressed: terminal) is ignored.
 */
export async function recordRejected(key: string): Promise<void> {
  await update(key, (row) => {
    if (row.status !== 'active') return // a missing row arrives here as a fresh 'active' one
    row.rejectedCount += 1
    row.suppressedUntil = null
    row.status = row.rejectedCount >= SUPPRESS_AFTER_REJECTIONS ? 'suppressed' : 'rejected'
  })
}

export async function recordSnoozed(key: string, at: number): Promise<void> {
  await update(key, (row) => {
    if (row.status === 'suppressed') return
    row.status = 'snoozed'
    row.suppressedUntil = at + SNOOZE_DAYS * DAY_MS
  })
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
      case 'accepted':
        // A null stored fingerprint (accepted before it was ever shown) cannot prove a fresh occurrence, so it stays away:
        // re-offering advice the owner just took is a visible error, a silent never-return is not.
        if (row.evidenceFingerprint === null || fingerprints.get(key) === row.evidenceFingerprint) out.add(key)
        break
      case 'snoozed':
        // Exactly at suppressedUntil it returns. A null date (recordSnoozed never writes one) counts as expired, as in recordShown.
        if (row.suppressedUntil !== null && row.suppressedUntil > now) out.add(key)
        break
      default: break // active, rejected once: offered
    }
  })
  return out
}
