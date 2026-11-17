import { db } from '../db/db'
import type { AnalyticsCacheRow } from '../db/schema'
import { sha256Hex } from '../lib/hash'

/**
 * A derived-figure cache that is either current or absent: a figure the owner reads is never one produced by an older formula
 * or from older data (design 7.1). Every cache row is disposable, so this module only ever reads transactions and annotations
 * and only ever writes analyticsCache. The durable truth (transactions, annotations, learningEvents) is never touched here.
 * Any restore of a backup already clears the table (design 31.3, src/db/backup.ts), so nothing here repeats that.
 */

/**
 * Bump this whenever any cached figure's formula changes. A row stamped with a different version is a miss, however fresh its
 * inputs. This is the only guard against serving a number produced by an older formula.
 */
export const ENGINE_VERSION = 1

/** Stored payloads are wrapped, so a row written in some other shape can be told apart from a real value and treated as a miss. */
const PAYLOAD_SHAPE = 1
interface Envelope { shape: number; value: unknown }

const isEnvelope = (payload: unknown): payload is Envelope =>
  typeof payload === 'object' && payload !== null && (payload as Envelope).shape === PAYLOAD_SHAPE && 'value' in payload

/**
 * A digest of what the figures are computed from: the live transaction count, the soft-deleted count, the annotation count and
 * the newest annotations.updatedAt. An import, a soft delete, a restore, and an owner edit each move at least one of these.
 *
 * The limit, stated rather than glossed over: this is a summary, not a content hash, so two different changes that leave all
 * four numbers equal give the same digest and a cached figure would then be served stale. Known cases:
 *   - two annotation edits inside the same millisecond (updatedAt does not move), with the annotation count unchanged;
 *   - one soft delete plus one restore between two reads (both counts return to their old values), which needs no clock
 *     coincidence at all;
 *   - a hard delete plus an add (nothing in the app does this to transactions, and a restore of a backup clears this table).
 * That is why rebuildAnalytics exists: the owner can always force a recompute.
 */
export async function inputsHash(): Promise<string> {
  const total = await db.transactions.count()
  // deletedAt is indexed, and an index never holds null, so the index holds exactly the soft-deleted rows.
  const deleted = await db.transactions.where('deletedAt').above(-Infinity).count()
  let annotations = 0
  let newest = 0
  await db.annotations.each((a) => {
    annotations++
    if (a.updatedAt > newest) newest = a.updatedAt
  })
  const joined = [`live=${total - deleted}`, `deleted=${deleted}`, `annotations=${annotations}`, `newest=${newest}`].join('|')
  return sha256Hex(new TextEncoder().encode(joined))
}

/**
 * The stored figure when it was computed by this engine version from the current inputs, otherwise a fresh computation, which is
 * stored and returned. `computedAt` is supplied by the caller (the clock is read only at sanctioned boundaries).
 * The hash is taken BEFORE computing: if the data moves while compute runs, the stored hash is already out of date and the next
 * read recomputes, so a slow computation can never pin an old figure as current.
 */
export async function cached<T>(key: string, compute: () => Promise<T>, computedAt: number): Promise<T> {
  const inputs = await inputsHash()
  const row = await db.analyticsCache.get(key)
  if (row && row.engineVersion === ENGINE_VERSION && row.inputsHash === inputs && isEnvelope(row.payload)) {
    return row.payload.value as T
  }
  const value = await compute()
  const fresh: AnalyticsCacheRow = {
    key, engineVersion: ENGINE_VERSION, inputsHash: inputs, computedAt, payload: { shape: PAYLOAD_SHAPE, value } satisfies Envelope,
  }
  await db.analyticsCache.put(fresh)
  return value
}

/** Clears every cached figure and reports how many it cleared. The next read of each recomputes. */
export async function rebuildAnalytics(): Promise<number> {
  return db.analyticsCache.toCollection().delete()
}
