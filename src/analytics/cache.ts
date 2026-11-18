import { db, ENGINE_VERSION } from '../db/db'
import type { AnalyticsCacheRow, BudgetAllocationRow, SavingsGoalRow } from '../db/schema'
import { sha256Hex } from '../lib/hash'

/**
 * A derived-figure cache that is either current or absent: a figure the owner reads is never one produced by an older formula
 * or from older data (design 7.1). Every cache row is disposable, so this module only ever READS the tables a figure is
 * computed from (transactions, annotations, transfers, budgetAllocations, savingsGoals) and only ever writes analyticsCache. The durable
 * truth (transactions, annotations, learningEvents) is never touched here.
 * Any restore of a backup already clears the table (design 31.3, the backup module), so nothing here repeats that.
 */

/**
 * Bump this whenever any cached figure's formula changes. A row stamped with a different version is a miss, however fresh its
 * inputs. This is the only guard against serving a number produced by an older formula.
 */
/**
 * Re-exported, not redeclared. The database module has owned this number since Plan 1 — "invalidates cached analytics
 * when a formula changes, independent of the schema version" — and this module briefly declared a second constant of the
 * same name and meaning. Two of them is the worst shape for this particular value: bumping one leaves the cache happily
 * serving figures the other says are stale, and nothing fails.
 *
 * (The path to that module is deliberately not written out here: the guard below scans this file's text for writes to
 * tables, and a path in a comment reads to it as a table access. Same prose-versus-code confusion the whole-tree guards
 * in sourceRules.test.ts were fixed for.)
 */
export { ENGINE_VERSION }

/** Stored payloads are wrapped, so a row written in some other shape can be told apart from a real value and treated as a miss. */
const PAYLOAD_SHAPE = 1
interface Envelope { shape: number; value: unknown }

const isEnvelope = (payload: unknown): payload is Envelope =>
  typeof payload === 'object' && payload !== null && (payload as Envelope).shape === PAYLOAD_SHAPE && 'value' in payload

/**
 * One allocation row as text, for the content digest below. The fields are listed one by one, in a fixed order, so a restored
 * backup's key order cannot change the digest, and JSON does the escaping: `note` is free text and may contain any separator
 * this could otherwise have used. A field added to BudgetAllocationRow later must be added here too, or a change to it is
 * invisible — which is the price of naming fields instead of digesting the object, and the reason it is said out loud.
 */
const allocationText = (a: BudgetAllocationRow): string =>
  JSON.stringify([a.id, a.categoryId, a.savingsGoalId, a.percentBp, a.fixedCents, a.effectiveFrom, a.note])

/**
 * One savings goal as text, for the content digest below, built exactly as allocationText is: every field named, in a fixed
 * order, JSON-escaped (`name` is free text). A field added to SavingsGoalRow later must be added here too, or a change to it
 * is invisible. `archived` and `completedAt` are in on purpose: they are what a goals list shows (open, done, put away), and a change to either
 * has to reach it. (Archiving or completing also ends the goal's allocation, which the allocations digest sees on its own.)
 */
const goalText = (g: SavingsGoalRow): string =>
  JSON.stringify([g.id, g.name, g.targetCents, g.deadline, g.contributionPercentBp, g.createdAt, g.completedAt, g.archived])

/**
 * WHICH TABLES A CACHED FIGURE IS COMPUTED FROM, and what this digest therefore has to key on.
 *
 * That is the question this comment exists to answer, because the version before it did not ask it. It reasoned carefully
 * about two tables, concluded "no realistic collision remains", and was wrong about something else entirely: a figure is
 * not computed from two tables. monthlyBudget — under monthSummary, monthSeries, the habits figures and the Reports panels,
 * i.e. under nearly everything cached here — reads SIX:
 *   transactions, annotations  the bank rows and the owner's edits to them;
 *   transfers                  internal and round-up pairs, and REFUND LINKS: a refund takes its positive out of income
 *                              (income.ts `exclusions`) and subtracts it from its purchase's category (`refundSubtractions`);
 *   budgetAllocations          what is budgeted, and therefore which line owns each euro (most-specific-wins);
 *   categories, savingsGoals   the names and kinds those lines are built from.
 * Five of the six are digested below. The one that is not is named at the end, with the reason and what would change it.
 *
 * Each table is keyed on the cheapest thing that cannot miss the changes that table can actually undergo — which is a
 * DIFFERENT key per table, because the writers differ. A uniform "hash every row of every table" would be slower and no
 * safer. inputsHash runs on every cached() call, so the cost of each read is stated:
 *
 * transactions — live count, soft-deleted count, newest deletedAt. Two counts (index-only) plus one row read for the newest
 *   deletedAt. Counts alone are not enough: soft-deleting one row and restoring another leaves both counts as they were. The
 *   newest deletedAt closes that: the delete lands a newer timestamp than any before it, and the restore removes the old
 *   entry, so the pair moves it either way, while deleting and restoring the SAME row returns it to its old value, as the
 *   state really is. Bank rows are immutable after import (§8.1) apart from deletedAt, so nothing else can move.
 *
 * annotations — count and newest updatedAt. One cursor over the table: one row per annotated transaction. Every annotation
 *   write stamps updatedAt, so an edit moves the newest value and a new annotation moves the count.
 *
 * transfers — the SORTED SET OF PRIMARY KEYS. Rows here are only ever ADDED or DELETED: linkRefund adds one, unlinkRefund
 *   deletes one, and the importer bulk-adds the pairs the pairing module matched (the only other writer, and an add). No
 *   writer anywhere updates a row in place — checked writer by writer, because that is what this key rests on.
 *   The key set therefore determines the table exactly, and it is an INDEX-ONLY read — the primary-key index is walked and no
 *   row is fetched, so this is the cheapest of the five. `matchedAt` would be the obvious alternative and is NOT indexed, so
 *   it can neither order nor bound a read; §29 forbids adding an index for it. A restore is the one path that bulk-PUTs these
 *   rows, and a restore clears this whole table (31.3), so it needs nothing from the digest.
 *
 * budgetAllocations — the CONTENT of every row, serialised deterministically and sorted. This is the one table whose rows
 *   change IN PLACE: saveAllocation writes with `put` and deliberately reuses the existing id when it replaces an allocation
 *   for the same target and the same effectiveFrom, so "I now budget 300 instead of 200" is the same id with a new amount.
 *   A count cannot see that, and neither can a key set — which is exactly why this table is not keyed like transfers. There
 *   is no timestamp to key on instead: the row is { id, categoryId, savingsGoalId, percentBp, fixedCents, effectiveFrom,
 *   note } and nothing more. The cost is one full read of a tiny table: one row per budgeted category or goal, which is a
 *   handful, not a ledger.
 *
 * savingsGoals — the CONTENT of every row, serialised like allocations and for the same reason. A goal is edited IN PLACE:
 *   updateGoal in the goals store puts the row back under its own id, so a new target, name, deadline or share, and an
 *   archive or completion, are all the same id with different content, which neither a count nor a key set can see. The
 *   row has no timestamp that moves on an edit (createdAt is fixed at creation), so there is nothing cheaper to key on.
 *   The cost is one full read of a tiny table: one row per goal the owner has set, a handful.
 *
 * What is still NOT covered, stated rather than left to silence:
 *
 * categories is read by monthlyBudget and is not digested, because today it cannot change under a cached figure. Nothing
 *   outside seeding and import writes categories, and an import creates a category only alongside at least one new
 *   transaction (commitPreview refuses an import with nothing new), which moves the digest anyway. The same holds for the two
 *   label tables `moods` and `purchaseReasons`, read by the mood and reason breakdowns: seeding writes them and nothing else
 *   does. So the first screen that renames a category, a mood or a reason has to add its table to this digest — a rename
 *   leaves a cached figure carrying the old label. A rename screen could get away with a count plus a hash of the names.
 *   Nothing enforces this yet. The durable-truth guard in cache.test.ts scans only this file, so it fires only if someone
 *   adds a read of one of those three tables inside this module; a screen that writes to them (a put on the categories
 *   table, say) trips no test at all. A rule over every writer of those tables, across the whole source tree, does not
 *   exist; until it does, noticing this paragraph is on whoever adds such a screen.
 *   (savingsGoals used to be in this list, when nothing could create or edit a goal. The goals store now does, and the digest
 *   above covers it. A new writer of that table needs nothing here, provided it keeps every goal field in goalText.)
 * Merchant naming is not in that list: it goes through rememberMerchantName, which writes an annotation as part of the same
 *   transaction, so it already moves the digest — and no cached figure carries a merchant name in any case.
 *
 * And the digest remains a summary, not a content hash, for transactions and annotations: two annotation edits in the same
 * millisecond that keep the count (updatedAt does not move) collide, as would a delete-and-restore pair stamped with the same
 * millisecond as the old newest deletedAt. A person acting through the interface cannot do either. rebuildAnalytics still
 * exists to force a recompute.
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
  // Index-only: the primary-key index is walked, no row is read. primaryKeys() hands back a fresh array, so sorting it in
  // place is safe, and sorting is what makes the digest independent of the order the keys happen to come back in.
  const transfers = (await db.transfers.toCollection().primaryKeys()).map(String).sort()
  const allocations = (await db.budgetAllocations.toArray()).map(allocationText).sort()
  const goals = (await db.savingsGoals.toArray()).map(goalText).sort()
  const joined = [
    `live=${total - deleted}`, `deleted=${deleted}`, `newestDeleted=${newestDeleted}`,
    `annotations=${annotations}`, `newest=${newest}`,
    `transfers=${JSON.stringify(transfers)}`, `allocations=${JSON.stringify(allocations)}`,
    `goals=${JSON.stringify(goals)}`,
  ].join('|')
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
