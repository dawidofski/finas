import { db } from '../db/db'
import type { RecurringRow } from '../db/schema'
import { liveTransactionsBetween } from '../analysis/transactionsInRange'
import { spendsOf } from '../battery/rank'
import { addDays, daysBetween, monthKeyOf } from '../lib/dates'
import { divRound } from '../lib/money'
import { detectRecurring, type Detected, type Frequency } from './detect'

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
}

/** Months of history detection reads: the last 14 COMPLETED months before the month `today` falls in. */
export const WINDOW_MONTHS = 14

/**
 * A payment the owner has not confirmed is shown only at or above this score (basis points). Three payments score at most 5000,
 * so this keeps a steady short run and hides a ragged one. A confirmed payment is shown whatever its score.
 */
export const MIN_SHOWN_SCORE_BP = 3000

export function recurringWindow(today: string): { first: string; last: string } {
  const thisMonthStart = `${monthKeyOf(today)}-01`
  let cur = thisMonthStart
  for (let i = 0; i < WINDOW_MONTHS; i++) cur = `${monthKeyOf(addDays(cur, -1))}-01`
  return { first: monthKeyOf(cur), last: monthKeyOf(addDays(thisMonthStart, -1)) }
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
 * STABLE IDS. An id is `merchantId|frequency|k`: the merchant, the cadence, and k, the position (from 0, by typical amount)
 * among that merchant's detected payments of the same cadence. Nothing in it is an amount, so a price rise within the
 * cluster's tolerance leaves it alone and the owner's correction stays attached. Two distinct payments at one merchant (an
 * app's 9.99 and 54.99 subscriptions) have the same cadence only by coincidence, and then take k = 0 and 1 by price; a price
 * change moves k only if the two prices swap order. What does orphan an id: the cadence changing (a monthly payment going
 * irregular), or two same-cadence payments crossing in price. A dismissal then stops applying, so the payment comes back,
 * which errs toward showing the owner something over hiding it for good.
 */
function idsOf(detected: readonly Detected[]): string[] {
  const seen = new Map<string, number>()
  return detected.map(d => {   // detectRecurring orders by merchant, then amount, so k follows price
    const key = `${d.merchantId}|${d.frequency}`
    const k = seen.get(key) ?? 0
    seen.set(key, k + 1)
    return `${key}|${k}`
  })
}

/**
 * Detects over the window and stores one row per detected payment, keeping what the owner decided. Spends with no merchant are
 * left out: detection clusters by merchant, and a spend without one has nothing to cluster on. A dismissed payment is not
 * returned; a cancelled one is, flagged; a confirmed one is returned whatever its score. Rows the owner never touched and that
 * are no longer detected are removed; rows the owner touched are kept even then.
 * Reads only the window, by bank date; the clock is an argument.
 */
export async function recurringPayments(today: string, computedAt: number): Promise<RecurringView[]> {
  void computedAt   // not cached: nothing here is expensive and the table is the owner's. Kept so callers need not change if it is.
  const { first, last } = recurringWindow(today)
  const spends = await spendsOf(await liveTransactionsBetween(first, last))
  const rows = spends.flatMap(s => (s.merchantId === null ? [] : [{ merchantId: s.merchantId, valueDate: s.date, amountCents: s.centsOut }]))
  const detected = detectRecurring(rows)
  const ids = idsOf(detected)
  const existing = new Map((await db.recurring.toArray()).map(r => [r.id, r]))

  const writes: RecurringRow[] = []
  const views: RecurringView[] = []
  detected.forEach((d, i) => {
    const id = ids[i] as string
    const prior = existing.get(id)
    const row: RecurringRow = {
      id, merchantId: d.merchantId, amountCents: d.amountCents, toleranceCents: d.toleranceCents, frequency: d.frequency,
      lastSeenDate: d.lastSeenDate, expectedNextDate: d.expectedNextDate, matchScore: d.matchScoreBp,
      confirmedByUser: prior?.confirmedByUser ?? false, cancelled: prior?.cancelled ?? false,
      ...(prior?.dismissed === true ? { dismissed: true } : {}),
    }
    writes.push(row)
    if (row.dismissed === true) return
    // Three payments in a day are not a subscription: an irregular cluster is shown only once the owner has confirmed it.
    if (d.frequency === 'irregular' && !row.confirmedByUser) return
    if (!row.confirmedByUser && d.matchScoreBp < MIN_SHOWN_SCORE_BP) return
    const period = periodDays(d.frequency)
    const lapsed = d.expectedNextDate !== null && period !== null && daysBetween(addDays(d.expectedNextDate, period), today) > 0
    views.push({
      ...d, id, confirmedByUser: row.confirmedByUser, cancelled: row.cancelled, lapsed,
      expectedNextDate: lapsed ? null : d.expectedNextDate,
      monthlyCostCents: lapsed ? null : monthlyCostOf(d.frequency, d.amountCents),
    })
  })
  const keep = new Set(ids)
  const stale = [...existing.values()].filter(r => !keep.has(r.id) && !r.confirmedByUser && !r.cancelled && r.dismissed !== true).map(r => r.id)
  await db.transaction('rw', db.recurring, async () => {
    await db.recurring.bulkDelete(stale)
    await db.recurring.bulkPut(writes)
  })
  return views
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
/** "I cancelled it." The payment did recur; this changes neither confirmed nor dismissed. */
export const markCancelled = (id: string): Promise<void> => amend(id, { cancelled: true })
