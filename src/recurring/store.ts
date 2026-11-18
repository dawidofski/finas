import { db } from '../db/db'
import type { RecurringRow } from '../db/schema'
import { liveTransactionsBetween } from '../analysis/transactionsInRange'
import { spendsOf } from '../battery/rank'
import { addDays, daysBetween, monthKeyOf } from '../lib/dates'
import { divRound } from '../lib/money'
import { detectRecurring, plausibleChange, type Detected, type Frequency } from './detect'

export interface RecurringView extends Detected {
  id: string
  confirmedByUser: boolean
  cancelled: boolean
  /** The payment as a cost per month, in integer cents; null for 'irregular', which has no honest monthly figure (0 would read as free). */
  monthlyCostCents: number | null
  /**
   * The payment has been missed by more than a whole cycle: today is later than the expected next date plus one more nominal
   * period. A lapsed payment is still returned, but with expectedNextDate and monthlyCostCents null so it is never shown as
   * due and never counts toward a total. An irregular payment has no expected date, so it is never lapsed.
   */
  lapsed: boolean
  /**
   * The expected next date has passed but the payment is not yet lapsed: it was expected around that date and has not appeared
   * yet. expectedNextDate is kept so the screen can say when, in the past tense; it is never upcoming.
   */
  overdue: boolean
}

/**
 * Months of history detection reads: the last 14 COMPLETED months before the month `today` falls in, plus the running month up
 * to `today`. The running month is read because a payment that happened is a payment: without it, a weekly payment last seen
 * on the last day of the previous month would look stopped for half of every month. (The rule that a part-month is not a whole
 * month is about totals of spending, not about whether a payment was made.)
 *
 * A YEARLY bill is not found by this window: it holds at most two payments of a yearly bill, and three are needed.
 */
export const WINDOW_MONTHS = 14

export function recurringWindow(today: string): { first: string; last: string } {
  const thisMonthStart = `${monthKeyOf(today)}-01`
  let cur = thisMonthStart
  for (let i = 0; i < WINDOW_MONTHS; i++) cur = `${monthKeyOf(addDays(cur, -1))}-01`
  return { first: monthKeyOf(cur), last: monthKeyOf(today) }
}

/** Nominal length of a cycle in days, for the lapsed rule only. */
export function periodDays(frequency: Frequency): number | null {
  switch (frequency) {
    case 'weekly': return 7
    case 'monthly': return 30
    case 'quarterly': return 91
    case 'annual': return 365
    case 'irregular': return null
  }
}

/** weekly x 52 / 12, quarterly / 3, annual / 12, monthly as is; integer arithmetic through divRound. */
export function monthlyCostOf(frequency: Frequency, amountCents: number): number | null {
  switch (frequency) {
    case 'weekly': return divRound(amountCents * 52, 12)
    case 'monthly': return amountCents
    case 'quarterly': return divRound(amountCents, 3)
    case 'annual': return divRound(amountCents, 12)
    case 'irregular': return null
  }
}

/**
 * Detection over the window, from the bank rows: spends only (via spendsOf, the project's one definition, so a refund can never
 * merge into the payments), by bank date, up to today. Spends with no merchant are left out: detection clusters by merchant,
 * and a spend without one has nothing to cluster on. Reads only; no clock.
 */
async function detectedNow(today: string): Promise<Detected[]> {
  const { first, last } = recurringWindow(today)
  const spends = await spendsOf(await liveTransactionsBetween(first, last))
  return detectRecurring(spends.flatMap(s => (s.merchantId === null || s.date > today ? [] : [{ merchantId: s.merchantId, valueDate: s.date, amountCents: s.centsOut }])))
}

/**
 * WHICH STORED ROW IS WHICH PAYMENT. An id is minted once, when a series is first seen, and is never recomputed, so a
 * correction stays with its payment through a price change, a cadence drift and a change of rank.
 *   1. Continuity: a stored row of the same merchant whose stored lastSeenDate is one of the series' payment dates is the same
 *      run of payments carrying on. (A price change, a cadence drift, an older payment ageing out of the window and a new
 *      subscription appearing beside it all leave that date among the series' payments.) When two series at one merchant were
 *      last paid on the same day, both rows fit both series: the pairs are then settled nearest stored amount first, so the row
 *      goes to the series whose price it recorded, whatever order detection lists them in.
 *   2. Fallback, for a series whose stored date is no longer among its payments (the last payment was deleted or re-dated, or a
 *      one-off that had been read as a price change no longer is): the stored row of that merchant whose stored amount is a
 *      plausible change away from the series' amount, nearest first, and whose stored lastSeenDate is not before the series'
 *      first payment. A row last seen before the series began belongs to an older payment that has ended, and a new
 *      subscription at a similar price never inherits what the owner decided about that one.
 *   3. Else the series is new and gets an id of its merchant and the date of its first payment, with a counter if that id is
 *      already in use.
 * Each stored row matches at most one series. All continuity matches are made before any fallback, so a fallback can never take
 * a row that another series continues. Frequency is in no part of this, so a confirmed payment whose cadence drifts keeps its
 * confirmation.
 *
 * What this cannot tell apart: two payments at one merchant, last paid on the same day, whose prices cross over between two
 * runs. Nothing in the bank rows says which is which, and the nearer amount is taken.
 */
function assignIds(detected: readonly Detected[], rows: readonly RecurringRow[]): string[] {
  const ids: (string | null)[] = detected.map(() => null)
  const taken = new Set<string>()
  const pairs = detected.flatMap((d, i) => {
    const dates = new Set(d.paymentDates)
    return rows.filter(r => r.merchantId === d.merchantId && dates.has(r.lastSeenDate)).map(r => ({ i, r, distance: Math.abs(r.amountCents - d.amountCents) }))
  })
  // Latest stored date first (the live row before a stale one), then nearest amount, then a fixed order.
  pairs.sort((a, b) => (a.r.lastSeenDate < b.r.lastSeenDate ? 1 : a.r.lastSeenDate > b.r.lastSeenDate ? -1 : a.distance - b.distance || a.i - b.i || (a.r.id < b.r.id ? -1 : 1)))
  for (const p of pairs) {
    if (ids[p.i] !== null || taken.has(p.r.id)) continue
    ids[p.i] = p.r.id
    taken.add(p.r.id)
  }
  detected.forEach((d, i) => {
    if (ids[i] !== null) return
    const began = d.paymentDates[0] ?? d.lastSeenDate
    const hit = rows
      .filter(r => r.merchantId === d.merchantId && !taken.has(r.id) && r.lastSeenDate >= began && plausibleChange(d.amountCents, r.amountCents))
      .sort((a, b) => Math.abs(a.amountCents - d.amountCents) - Math.abs(b.amountCents - d.amountCents) || (a.id < b.id ? -1 : 1))[0]
    if (hit) { ids[i] = hit.id; taken.add(hit.id) }
  })
  const used = new Set([...rows.map(r => r.id), ...taken])
  return detected.map((d, i) => {
    const matched = ids[i]
    if (matched) return matched
    const base = `${d.merchantId}|${d.paymentDates[0] ?? d.lastSeenDate}`
    let id = base
    for (let n = 2; used.has(id); n++) id = `${base}#${n}`
    used.add(id)
    return id
  })
}

function viewOf(d: Detected, id: string, row: RecurringRow, today: string): RecurringView {
  const period = periodDays(d.frequency)
  const expected = d.expectedNextDate
  const lapsed = expected !== null && period !== null && daysBetween(addDays(expected, period), today) > 0
  const overdue = !lapsed && expected !== null && daysBetween(expected, today) > 0
  return {
    ...d, id, confirmedByUser: row.confirmedByUser, cancelled: row.cancelled, lapsed, overdue,
    expectedNextDate: lapsed ? null : expected,
    monthlyCostCents: lapsed ? null : monthlyCostOf(d.frequency, d.amountCents),
  }
}

/** A payment is shown unless the owner hid it, and an irregular one only once the owner has confirmed it (three payments in a day are not a subscription). */
const shown = (d: Detected, row: RecurringRow): boolean => row.dismissed !== true && (d.frequency !== 'irregular' || row.confirmedByUser)

function rowFor(d: Detected, id: string, prior: RecurringRow | undefined): RecurringRow {
  return {
    id, merchantId: d.merchantId, amountCents: d.amountCents, toleranceCents: d.toleranceCents, frequency: d.frequency,
    lastSeenDate: d.lastSeenDate, expectedNextDate: d.expectedNextDate, matchScore: d.matchScoreBp,
    confirmedByUser: prior?.confirmedByUser ?? false, cancelled: prior?.cancelled ?? false,
    ...(prior?.dismissed === true ? { dismissed: true } : {}),
  }
}

/**
 * Detects over the window and stores one row per detected payment, keeping what the owner decided. A dismissed payment is not
 * returned (hiddenRecurring lists them); a cancelled one is, flagged. Rows the owner never touched and that are no longer
 * detected are removed; rows the owner touched are kept even then. The stored rows are read and written in ONE transaction, so
 * a correction made while a detection runs is never overwritten by it. Reads only the window, by bank date; the clock is an argument.
 */
export async function recurringPayments(today: string, computedAt: number): Promise<RecurringView[]> {
  void computedAt   // not cached: nothing here is expensive and the table is the owner's.
  const detected = await detectedNow(today)
  return db.transaction('rw', db.recurring, async () => {
    const existing = await db.recurring.toArray()
    const byId = new Map(existing.map(r => [r.id, r]))
    const ids = assignIds(detected, existing)
    const writes = detected.map((d, i) => rowFor(d, ids[i] as string, byId.get(ids[i] as string)))
    const keep = new Set(ids)
    await db.recurring.bulkDelete(existing.filter(r => !keep.has(r.id) && !r.confirmedByUser && !r.cancelled && r.dismissed !== true).map(r => r.id))
    await db.recurring.bulkPut(writes)
    return detected.flatMap((d, i) => {
      const row = writes[i] as RecurringRow
      return shown(d, row) ? [viewOf(d, row.id, row, today)] : []
    })
  })
}

/**
 * The same payments recurringPayments would return, worked out WITHOUT writing a row. For a screen that only needs to know
 * whether anything recurs (Learning), so that visiting it cannot change what the Recurring screen shows.
 */
export async function recurringPreview(today: string): Promise<RecurringView[]> {
  const detected = await detectedNow(today)
  const existing = await db.recurring.toArray()
  const byId = new Map(existing.map(r => [r.id, r]))
  const ids = assignIds(detected, existing)
  return detected.flatMap((d, i) => {
    const row = rowFor(d, ids[i] as string, byId.get(ids[i] as string))
    return shown(d, row) ? [viewOf(d, row.id, row, today)] : []
  })
}

/** The payments the owner said are not recurring: always visible, so a hidden payment can be shown again. */
export async function hiddenRecurring(): Promise<RecurringRow[]> {
  return (await db.recurring.filter(r => r.dismissed === true).toArray()).sort((a, b) => (a.merchantId < b.merchantId ? -1 : a.merchantId > b.merchantId ? 1 : a.id < b.id ? -1 : 1))
}

/*
 * No learning event is written by any correction: no existing LearningEventType fits (recommendationAccepted and
 * recommendationRejected are about advice, and a type is not to be added for this).
 */
async function amend(id: string, change: Partial<RecurringRow>): Promise<void> {
  const updated = await db.recurring.update(id, change)
  if (updated === 0) throw new Error(`No recurring payment ${id}`)
}

/** "Yes, this recurs." */
export const confirmRecurring = (id: string): Promise<void> => amend(id, { confirmedByUser: true, dismissed: false })
/** "This is not recurring." Stored in `dismissed`, never in `cancelled`. */
export const dismissRecurring = (id: string): Promise<void> => amend(id, { dismissed: true, confirmedByUser: false })
/** "Show it again": clears the dismissal. */
export const restoreRecurring = (id: string): Promise<void> => amend(id, { dismissed: false })
/** "I cancelled it." The payment did recur; this changes neither confirmed nor dismissed. */
export const markCancelled = (id: string): Promise<void> => amend(id, { cancelled: true })
