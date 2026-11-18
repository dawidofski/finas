// Two of §12's ten relationships, both read off a contingency table: whether the purchases tagged as impulse buys are
// more common when the owner was bored, and whether the reason given for a purchase goes with how worthwhile it was
// judged afterwards. Nothing here says one thing makes the other happen; each result measures how far two answers the
// owner gave move together.
//
// Three things leave this module for each table and they are kept apart, because they answer different questions:
//   vBp      how STRONG the association is (Cramer's V, basis points; 10000 is 1.0). It floors, so it is at most a hair
//            low and never high.
//   bracket  how CERTAIN it is (p<0.01, p<0.05, or none). A result can be certain and tiny, and a result can be
//            sizeable and uncertain; collapsing the two into one score destroys the only distinction that makes the
//            screen honest (§12).
//   sparse   whether the table is too thin for the chi-square approximation behind the bracket to be believed.
// The gate in BATTERY decides whether there is enough data to show a figure at all; the bracket decides whether it may
// be called a finding. `bracket: 'none'` beside a real vBp is an ordinary answer, not an error.
//
// Only answered spends count. A purchase missing either answer contributes to neither the table nor the count, so no
// unanswered purchase is ever counted as some default category.
//
// A reason the owner has removed keeps its own row. The purchases already tagged with it still happened and still have
// an outcome. src/learning/regret.ts labels a reason id with no row in purchaseReasons 'Removed reason' and keeps it as
// its own cluster; this follows that convention. An archived reason (hidden from pickers, never deleted) still has its
// row, and so its own label.
//
// A table with an empty row or column has a zero expected count, so chi-square is undefined there and the result is
// withheld rather than computed around the gap.
//
// chiSquareBracket throws for df above 20. Reason x worthwhile has two columns, so df is the number of distinct reasons
// answered minus one, and past 21 of them the table has no critical value. That is refused BEFORE the bracket is asked
// for, as its own verdict: a thrown RangeError on the screen is the worst outcome, and a quiet 'none' would tell the
// owner their reasons do not predict their regrets when the truth is that the app declined to look.
//
// A result therefore has one of three verdicts, and the caller must read `verdict`, not `bracket`, to tell them apart:
//   'tested'               the bracket is a real finding or a real absence of one; it counts in Benjamini-Hochberg's m.
//   'sparse'               expected counts too small for chi-square to mean anything. No valid test was performed.
//   'too-many-categories'  more categories than the critical table covers. No test was performed.
// The last two carry the real vBp (strength survives) and bracket 'none' only so the type stays total; neither is an
// unremarkable result and neither belongs in m.

import { db } from '../db/db'
import { annotatedTransactions } from '../learning/regret'
import { cached } from '../analytics/cache'
import { spendsOf } from './rank'
import { chiSquareScaled, cramersVBp } from './stats'
import { CHI_TABLE_MAX_DF, chiSquareBracket, type Bracket } from './critical'
import { BATTERY, isMet, type BatteryData, type Gate, type RelationshipId } from './battery'

export interface ContingencyRow {
  key: string
  label: string
  /** One count per column of the table, in column order. */
  counts: [number, number]
}

/** The earliest and latest BANK date (§41/§43) among the spends that entered the table, as 'YYYY-MM-DD'. */
export interface Period {
  from: string
  to: string
}

export interface ContingencyResult {
  /** Answered spends the table was built from. */
  n: number
  /**
   * The span of the spends actually counted, never the window the caller asked about: the caller only knows what it asked
   * for, and this module is the only code that knows which dates its table really covers.
   */
  period: Period
  columns: [string, string]
  rows: ContingencyRow[]
  /** CHI_SCALE times chi-square, exactly as chiSquareScaled returns it. */
  chiScaled: number
  df: number
  /** Strength: Cramer's V in basis points. */
  vBp: number
  /** Certainty. Meaningful only when verdict is 'tested', where 'none' is an answer, not a failure. */
  bracket: Bracket
  /** Whether a test was performed at all. Anything but 'tested' means the bracket is a placeholder. */
  verdict: 'tested' | 'sparse' | 'too-many-categories'
}

/** There was enough data to try, but the table cannot carry the statistic. */
export interface Withheld {
  withheld: true
  n: number
  /** The span of what was counted. Null only when nothing was counted, which no gate-passing table can be; kept honest rather than ''. */
  period: Period | null
  why: string
}

/** Unmet gates when there is too little data; a withheld table; or the result. */
export type ContingencyOutcome = ContingencyResult | Withheld | Gate[]

const BORED = 'mood.bored'
const IMPULSE = 'reason.impulse'

/** Cochran's rule: an expected count of at least 5 in 80% of cells and of at least 1 in every cell. */
const EXPECTED_ENOUGH = 5
const EXPECTED_FLOOR = 1
const SMALL_CELLS_ALLOWED_PERCENT = 20

const NO_DATA: BatteryData = {
  discretionarySpendsWithMood: 0, moodGroupsOfTen: 0, weeksOfMoodCoverage: 0, stressedSpends: 0,
  unstressedSpends: 0, impulseTaggedSpends: 0, spendsWithReasonAndWorthwhile: 0, weekendsObserved: 0,
  incomeEvents: 0, fullMonths: 0, incomeLevelsWithTwoMonths: 0, monthsObserved: 0,
}

function unmetGates(id: RelationshipId, data: Partial<BatteryData>): Gate[] {
  const relationship = BATTERY.find((r) => r.id === id)
  if (relationship === undefined) throw new Error(`no relationship ${id} in the battery`)
  return relationship.gates({ ...NO_DATA, ...data }).filter((g) => !isMet(g))
}

/** Whether expected counts are too small to trust the chi-square approximation. Integers only: E = row*col/total. */
function isSparse(rows: readonly ContingencyRow[]): boolean {
  const colSums: [number, number] = [0, 0]
  let total = 0
  for (const r of rows) {
    colSums[0] += r.counts[0]
    colSums[1] += r.counts[1]
    total += r.counts[0] + r.counts[1]
  }
  let cells = 0
  let small = 0
  for (const r of rows) {
    const rowSum = r.counts[0] + r.counts[1]
    for (const colSum of colSums) {
      cells += 1
      const product = rowSum * colSum // E is below k exactly when product is below k * total
      if (product < EXPECTED_FLOOR * total) return true
      if (product < EXPECTED_ENOUGH * total) small += 1
    }
  }
  return small * 100 > cells * SMALL_CELLS_ALLOWED_PERCENT
}

/** Bank dates are 'YYYY-MM-DD', so string order is date order. Null for no spends: there is no period to invent. */
function periodOf(spends: readonly Answers[]): Period | null {
  const dates = spends.map((s) => s.bankDate).sort()
  const from = dates[0]
  const to = dates[dates.length - 1]
  return from === undefined || to === undefined ? null : { from, to }
}

function build(rows: ContingencyRow[], columns: [string, string], spends: readonly Answers[]): ContingencyResult | Withheld {
  const n = spends.length
  const period = periodOf(spends)
  const stat = chiSquareScaled(rows.map((r) => [r.counts[0], r.counts[1]]))
  if (stat === null) {
    return { withheld: true, n, period, why: 'A row or column of the table is empty, so there is nothing to compare.' }
  }
  const vBp = cramersVBp(stat.chiScaled, n, rows.length, 2)
  if (vBp === null || period === null) return { withheld: true, n, period, why: 'The strength of the association cannot be measured on this table.' }
  const base = { n, period, columns, rows, chiScaled: stat.chiScaled, df: stat.df, vBp }
  if (stat.df > CHI_TABLE_MAX_DF) return { ...base, bracket: 'none', verdict: 'too-many-categories' }
  if (isSparse(rows)) return { ...base, bracket: 'none', verdict: 'sparse' }
  return { ...base, bracket: chiSquareBracket(stat.chiScaled, stat.df), verdict: 'tested' }
}

interface Answers {
  /** The bank's valueDate, never an owner-corrected one (§41/§43). */
  bankDate: string
  moodId: string | null
  reasonId: string | null
  worthwhile: boolean | null
}

/**
 * The answers on every spend (rank.ts's spendsOf: money out and a spending treatment, §41/§43) that satisfies `keep`. The read goes through
 * annotatedTransactions, so it is bounded by the owner's own annotations and never reads the whole ledger (§39.4).
 */
async function answeredSpends(keep: (a: Omit<Answers, 'bankDate'>) => boolean): Promise<Answers[]> {
  const bank = await annotatedTransactions((a) => keep({ moodId: a.moodId, reasonId: a.purchaseReasonId, worthwhile: a.worthwhile }))
  const out: Answers[] = []
  // The one definition of a spend, shared with rank.ts: treatmentOf spending and a strictly negative bank amount.
  for (const s of await spendsOf(bank)) {
    const answers = { bankDate: s.date, moodId: s.moodId, reasonId: s.reasonId, worthwhile: s.worthwhile }
    if (keep(answers)) out.push(answers)
  }
  return out
}

/**
 * Bored against any other mood, impulse-tagged against any other reason, over spends that carry both a mood and a
 * reason. The gate counts the impulse-tagged spends that are in the table, since those are what the comparison is made of.
 */
export async function boredomImpulse(computedAt: number): Promise<ContingencyOutcome> {
  return cached('battery:boredom-impulse', async () => {
    const spends = await answeredSpends((a) => a.moodId !== null && a.reasonId !== null)
    const impulse = spends.filter((s) => s.reasonId === IMPULSE).length
    const gates = unmetGates('boredom-impulse', { impulseTaggedSpends: impulse })
    if (gates.length > 0) return gates
    const [mood, reason] = await Promise.all([db.moods.get(BORED), db.purchaseReasons.get(IMPULSE)])
    const bored: [number, number] = [0, 0]
    const other: [number, number] = [0, 0]
    for (const s of spends) (s.moodId === BORED ? bored : other)[s.reasonId === IMPULSE ? 0 : 1] += 1
    const impulseLabel = reason?.label ?? 'Impulse'
    return build(
      [
        { key: BORED, label: mood?.label ?? 'Bored', counts: bored },
        { key: 'mood.not-bored', label: 'Any other mood', counts: other },
      ],
      [impulseLabel, `Not ${impulseLabel.toLowerCase()}`],
      spends,
    )
  }, computedAt)
}

/** Each reason against worthwhile / not worthwhile, over spends that carry both. */
export async function reasonWorthwhile(computedAt: number): Promise<ContingencyOutcome> {
  return cached('battery:reason-worthwhile', async () => {
    const spends = await answeredSpends((a) => a.reasonId !== null && a.worthwhile !== null)
    const gates = unmetGates('reason-worthwhile', { spendsWithReasonAndWorthwhile: spends.length })
    if (gates.length > 0) return gates
    const labels = new Map((await db.purchaseReasons.toArray()).map((r) => [r.id, r.label]))
    const byReason = new Map<string, [number, number]>()
    for (const s of spends) {
      if (s.reasonId === null) continue
      const counts = byReason.get(s.reasonId) ?? [0, 0]
      counts[s.worthwhile === true ? 0 : 1] += 1
      byReason.set(s.reasonId, counts)
    }
    const rows: ContingencyRow[] = [...byReason.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, counts]) => ({ key, label: labels.get(key) ?? 'Removed reason', counts }))
    return build(rows, ['Worthwhile', 'Not worthwhile'], spends)
  }, computedAt)
}
