import { db } from '../db/db'
import type { TransactionRow } from '../db/schema'
import { addDays, daysBetween } from '../lib/dates'
import type { CandidateRow } from './normalise'

export interface DateRange {
  start: string
  end: string
}

export type GapReport =
  | { kind: 'first-import' }
  | { kind: 'contiguous' }
  | { kind: 'gap'; reExportFrom: string; reExportTo: string; balanceDelta: number }
  | { kind: 'overlap' }
  /**
   * The join cannot be verified. `uncoveredFrom`/`uncoveredTo` are the span the owner should re-export in order to
   * establish it: the calendar hole between the windows, or, when no hole exists but the adjoining range holds no
   * stored row to reconcile against, that adjoining range itself.
   */
  | { kind: 'detached'; uncoveredFrom: string; uncoveredTo: string }

/** The dates this account has imports for: merged, ascending, non-overlapping. Derived from `imports` (§23.4). */
export async function coveredRanges(accountId: string): Promise<DateRange[]> {
  const imports = await db.imports.where('accountId').equals(accountId).toArray()
  const sorted = imports
    .map((i): DateRange => ({ start: i.coverageStart, end: i.coverageEnd }))
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))
  const merged: DateRange[] = []
  for (const range of sorted) {
    const last = merged[merged.length - 1]
    // One range ends the day before the next begins: nothing lies between them, so they are one run of days.
    if (last && daysBetween(last.end, range.start) <= 1) {
      if (range.end > last.end) last.end = range.end
    } else {
      merged.push({ ...range })
    }
  }
  return merged
}

/** The stored row nearest the seam on the older side: newest date before `date`, and within it the newest in file order. */
async function newestStoredBefore(accountId: string, date: string): Promise<TransactionRow | undefined> {
  const top = await db.transactions
    .where('[accountId+valueDate]').between([accountId, ''], [accountId, date], true, false).reverse().first()
  if (!top) return undefined
  const sameDay = await db.transactions.where('[accountId+valueDate]').equals([accountId, top.valueDate]).toArray()
  return sameDay.sort((a, b) => a.fileSeq - b.fileSeq)[0]
}

/** The stored row nearest the seam on the newer side: oldest date after `date`, and within it the oldest in file order. */
async function oldestStoredAfter(accountId: string, date: string): Promise<TransactionRow | undefined> {
  const bottom = await db.transactions
    .where('[accountId+valueDate]').between([accountId, date], [accountId, '￿'], false, true).first()
  if (!bottom) return undefined
  const sameDay = await db.transactions.where('[accountId+valueDate]').equals([accountId, bottom.valueDate]).toArray()
  return sameDay.sort((a, b) => b.fileSeq - a.fileSeq)[0]
}

interface Seam {
  from: string
  to: string
  delta: number
}

/**
 * Rows are newest-first, so `balance[i] === balance[i+1] + amount[i]`. A join reconciles when the newer side's
 * balance equals the older side's balance plus the newer side's amount. `delta` is what the missing transactions
 * must sum to, in chronological terms: the newer side's opening balance minus the older side's closing balance.
 * Zero means the seam reconciles.
 */
function seam(older: { valueDate: string; balanceCents: number }, newer: { valueDate: string; balanceCents: number; amountCents: number }): Seam {
  return { from: older.valueDate, to: newer.valueDate, delta: newer.balanceCents - newer.amountCents - older.balanceCents }
}

export async function analyseGap(accountId: string, rows: ReadonlyArray<CandidateRow>): Promise<GapReport> {
  const newest = rows[0]
  const oldest = rows[rows.length - 1]
  if (!newest || !oldest) throw new Error('Cannot analyse a file with no rows: it has no date window.')
  let start = oldest.valueDate
  let end = newest.valueDate
  for (const r of rows) {
    if (r.valueDate < start) start = r.valueDate
    if (r.valueDate > end) end = r.valueDate
  }

  const ranges = await coveredRanges(accountId)
  if (ranges.length === 0) return { kind: 'first-import' }

  // Touching existing days needs no seam test. The shared rows are matched by a key that includes the balance,
  // so where the windows overlap they provably agree; continuity is established by the overlap itself.
  const touching = ranges.filter((r) => r.start <= end && r.end >= start)
  if (touching.length > 0) {
    return touching.length === 1 && touching[0] && touching[0].start <= start && touching[0].end >= end
      ? { kind: 'overlap' }
      : { kind: 'contiguous' }
  }

  const before = [...ranges].reverse().find((r) => r.end < start)
  const after = ranges.find((r) => r.start > end)

  // ING emits rows only for days on which something happened, so calendar distance proves nothing: a quiet weekend
  // leaves an empty hole. The balance relation decides. A seam is evaluated whenever a stored row exists on that
  // side, however many days separate the windows; a delta of zero means nothing is missing there.
  // reExportFrom/reExportTo are the dates of the two rows at the seam, deliberately: re-exporting from the last
  // known-good day is what closes the hole. They are not calendar-gap days.
  // When an adjoining range has no stored row on its side, the join cannot be verified (`detached`), whatever the
  // calendar distance. `uncovered` is then the span to re-export to establish the join: the hole between the
  // windows if there is one, otherwise the adjoining range itself (re-exporting it produces the row the seam needs).
  const seams: Seam[] = []
  let uncovered: { from: string; to: string } | null = null

  if (before) {
    // FORWARD: the file's OLDEST row joins the stored NEWEST row.
    const stored = await newestStoredBefore(accountId, start)
    if (stored) seams.push(seam(stored, oldest))
    else uncovered = daysBetween(before.end, start) > 1
      ? { from: addDays(before.end, 1), to: addDays(start, -1) }
      : { from: before.start, to: before.end }
  }
  if (after) {
    // BACKWARD: the file's NEWEST row joins the stored OLDEST row.
    const stored = await oldestStoredAfter(accountId, end)
    if (stored) seams.push(seam(newest, stored))
    else if (!uncovered) {
      uncovered = daysBetween(end, after.start) > 1
        ? { from: addDays(end, 1), to: addDays(after.start, -1) }
        : { from: after.start, to: after.end }
    }
  }

  const broken = seams.find((s) => s.delta !== 0)
  if (broken) return { kind: 'gap', reExportFrom: broken.from, reExportTo: broken.to, balanceDelta: broken.delta }
  if (uncovered) return { kind: 'detached', uncoveredFrom: uncovered.from, uncoveredTo: uncovered.to }
  return { kind: 'contiguous' }
}
