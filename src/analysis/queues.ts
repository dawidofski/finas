import { db } from '../db/db'
import { resolveMany, writeAnnotation, type ResolvedTransaction } from '../db/annotations'
import { getSettings } from '../db/seed'
import type { CategoryKind } from '../db/schema'
import { daysBetween } from '../lib/dates'

/**
 * The owner's annotation queues (§15). One definition of "worth annotating" lives here and every queue builds on it,
 * so a transaction can never be offered in one queue and silently withheld from another.
 *
 * §15 wants recurring essentials left out by default. Recurring detection does not exist yet (build stage 13), so
 * today's stand-in is the category kind: internal and round-up movements, and anything whose resolved leaf category is
 * `essential`. Replace the essential test with recurring detection when that lands; the shape of the rule stays.
 */

/** Category id -> kind, read once for a whole batch. A parent (kind null) maps to null. */
export type CategoryKinds = ReadonlyMap<string, CategoryKind | null>

export async function loadCategoryKinds(): Promise<CategoryKinds> {
  return new Map((await db.categories.toArray()).map((c) => [c.id, c.kind]))
}

/**
 * Pure. True when the owner is worth asking about this transaction. The leaf is the resolved categoryId alone: subcategoryId is
 * vestigial (§39.5), and this module must classify the same way src/budget/month.ts does. A leaf kind of null (a parent
 * group, or no category) is not essential.
 * Soft-deleted rows are never worth annotating, whatever annotation they carry.
 */
export function worthAnnotating(tx: ResolvedTransaction, kinds: CategoryKinds): boolean {
  if (tx.deletedAt !== null) return false
  // Income is not a choice the owner made, so how it felt is not the question this queue exists to answer, and mood
  // on salary rows would sit in the mood-versus-spending samples as noise.
  if (tx.kind === 'internal' || tx.kind === 'roundup' || tx.kind === 'income') return false
  // categoryId alone, as month.ts does: subcategoryId is vestigial (§39.5) and the two modules must classify alike.
  const leafKind = tx.categoryId !== null ? kinds.get(tx.categoryId) ?? null : null
  return leafKind !== 'essential'
}

/** Oldest first by resolved date; ties keep the order of the statement, then the id, so the order is total. */
const byAge = (a: ResolvedTransaction, b: ResolvedTransaction): number =>
  a.valueDate < b.valueDate ? -1 : a.valueDate > b.valueDate ? 1
    : a.fileSeq - b.fileSeq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** Resolved transactions, oldest first, that are worth annotating (soft-deleted rows never are). Reads at call time. */
async function worthAnnotatingNow(): Promise<ResolvedTransaction[]> {
  const [resolved, kinds] = await Promise.all([resolveMany(await db.transactions.toArray()), loadCategoryKinds()])
  return resolved.filter((t) => worthAnnotating(t, kinds)).sort(byAge)
}

/** The one place the prompting setting is read, so the queue and the screen cannot disagree about its default. */
export async function moodPromptingEnabled(): Promise<boolean> {
  return (await getSettings()).moodPrompting.enabled
}

/**
 * The mood queue: worth annotating and no mood yet, oldest first. Empty when the owner has turned mood prompting off.
 * A skipped transaction has no mood, so it is still here next time: skipping is never recorded.
 */
export async function moodQueue(): Promise<ResolvedTransaction[]> {
  if (!(await moodPromptingEnabled())) return []
  return (await worthAnnotatingNow()).filter((t) => t.moodId === null)
}

/**
 * §15: a day-level mood applies to that day's UNANNOTATED transactions only and never replaces a mood the owner set.
 * "That day's" means the resolved date. Only transactions the queue would ask about are touched, so a day mood does
 * not stamp a feeling on rent or a round-up. Returns how many were set.
 *
 * Selection and writes share ONE Dexie transaction. IndexedDB holds the object stores for its duration, so no answer
 * can land between choosing the rows and writing them: that atomicity is what makes the single `moodId === null`
 * test sufficient, and it makes the action all-or-nothing. If any write fails, none of the day is changed.
 */
export async function dayMood(date: string, moodId: string): Promise<number> {
  if ((await db.moods.get(moodId)) === undefined) throw new Error(`Unknown mood ${moodId}`)
  return db.transaction('rw', db.transactions, db.annotations, db.learningEvents, db.categories, async () => {
    const candidates = (await worthAnnotatingNow()).filter((t) => t.valueDate === date && t.moodId === null)
    for (const c of candidates) await writeAnnotation(c.id, { moodId }, 'owner')
    return candidates.length
  })
}

/** §21.4: how old spending must be before the owner is asked whether it was worth it. A setting; this is its default. */
export const DEFAULT_WORTHWHILE_DELAY_DAYS = 7

/** The one reader of the delay setting. A missing or unusable stored value falls back to the default. */
export async function worthwhileDelayDays(): Promise<number> {
  const stored = (await getSettings()).worthwhileDelayDays
  return typeof stored === 'number' && Number.isInteger(stored) && stored >= 0 ? stored : DEFAULT_WORTHWHILE_DELAY_DAYS
}

export async function setWorthwhileDelayDays(days: number): Promise<void> {
  if (!Number.isInteger(days) || days < 0) throw new Error(`Invalid delay: ${days}`)
  await getSettings() // make sure the singleton exists before updating it
  await db.settings.update('singleton', { worthwhileDelayDays: days })
}

/**
 * The "Worth it?" hindsight queue (§21.4). All four conditions are required:
 *  1. worth annotating (the shared predicate: discretionary, live), and
 *  2. at least `olderThanDays` old on the resolved date, because nobody knows in the shop, and
 *     (deliberate, §41's scope paragraph: no figure is computed here and no money moves. When the owner corrected a
 *     date because the bank posted it wrongly, the corrected date is the better answer to "has enough time passed
 *     for hindsight to be honest". Do not switch this to the bank date.)
 *  3. the owner recorded a mood OR a reason, which is what makes this a revisit rather than a second triage, and
 *  4. no judgement yet: `worthwhile === null` means unanswered, so a skipped transaction stays here. Skipping is never
 *     recorded, and nothing in this module writes.
 * Oldest first. `today` is injected; this module never reads a clock.
 */
export async function worthwhileQueue(opts: { olderThanDays?: number; today: string }): Promise<ResolvedTransaction[]> {
  const olderThanDays = opts.olderThanDays ?? DEFAULT_WORTHWHILE_DELAY_DAYS
  return (await worthAnnotatingNow()).filter((t) =>
    daysBetween(t.valueDate, opts.today) >= olderThanDays
    && (t.moodId !== null || t.purchaseReasonId !== null)
    && t.worthwhile === null)
}
