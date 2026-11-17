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
 * A digest of what the figures are computed from: the live transaction count, the soft-deleted count, the newest deletedAt, the
 * annotation count and the newest annotations.updatedAt. Every add, soft delete, restore and annotation write moves at least one.
 *
 * Counts alone are not enough: soft-deleting one row and restoring another leaves both counts as they were. The newest deletedAt
 * closes that: the delete lands a newer timestamp than any before it, and the restore removes the old entry, so the pair moves it
 * either way, while deleting and restoring the same row returns it to its old value, as the state really is.
 *
 * What is left is a summary, not a content hash: two different annotation edits in the same millisecond that keep the annotation
 * count (updatedAt does not move) collide, as would a delete-and-restore pair stamped with the same millisecond as the old newest
 * deletedAt. A person acting through the interface cannot do either, so no realistic collision remains; rebuildAnalytics still
 * exists to force a recompute.
 *
 * It also covers the transactions and annotations ONLY — not the reference tables. Renaming a mood, a purchase reason, a category
 * or a merchant therefore leaves a cached figure carrying the old LABEL, because nothing it digests has moved. The numbers stay
 * right; the word beside them goes stale. Accepted rather than fixed, for three reasons: renaming is rare, any later annotation
 * or import write invalidates the entry anyway, and rebuildAnalytics is offered in Settings for exactly this. The alternative
 * worth considering if it ever bites is to stop caching labels at all — hold keys and numbers here and look the names up at read
 * time — which removes the whole class rather than adding more tables to this digest.
 */
export async function inputsHash(): Promise<string> {
  const total = await db.transactions.count()
  // deletedAt is indexed, and an index never holds null, so the index holds exactly the soft-deleted rows.
  const deleted = await db.transactions.where('deletedAt').above(-Infinity).count()
  const newestDeleted = (await db.transactions.orderBy('deletedAt').last())?.deletedAt ?? 0
  let annotations = 0
  let newest = 0
  await db.annotations.each((a) => {
    annotations++
    if (a.updatedAt > newest) newest = a.updatedAt
  })
  const joined = [`live=${total - deleted}`, `deleted=${deleted}`, `newestDeleted=${newestDeleted}`, `annotations=${annotations}`, `newest=${newest}`].join('|')
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
