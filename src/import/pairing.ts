import { db } from '../db/db'
import { resolveMany, writeAnnotation, type ResolvedTransaction } from '../db/annotations'
import type { TransactionRow, TransferRow } from '../db/schema'
import { addDays, daysBetween } from '../lib/dates'
import type { CandidateRow } from './normalise'

// ING writes a round-up's parent into its description: "tu compra de 34 EUR y 78 cts".
// Cents are built from the two captured integer groups; no float ever touches money.
const ROUNDUP_RE = /tu (compra|recibo) de (\d+) EUR y (\d+) cts/

/** The parent purchase amount (positive cents) named by a round-up description, or null. */
export function parseRoundupParent(description: string): number | null {
  const m = ROUNDUP_RE.exec(description)
  if (!m) return null
  const euros = Number(m[2])
  const cents = Number(m[3])
  if (!Number.isSafeInteger(euros) || cents > 99) return null
  return euros * 100 + cents
}

export interface RoundupLink {
  roundupIndex: number
  parentIndex: number | null
  /**
   * 'none' means no purchase of that amount exists on that day in this file (the parent may live in an
   * earlier import). It is distinct from 'ambiguous', where candidates exist and the evidence cannot choose.
   */
  basis: 'adjacency' | 'unique-amount' | 'ambiguous' | 'none'
}

/**
 * Links each round-up outflow to its parent purchase within one file (rows in file order, newest first).
 * Amount and date alone are not enough (two identical same-day purchases are real), so the balance chain
 * is used as evidence: a round-up is posted right after its parent, so the parent sits immediately older
 * in the file (index + 1) and `parent.balance + roundup.amount === roundup.balance`. Only an adjacency
 * that actually holds is reported; if it also ties, the link is left null rather than guessed.
 * Inflow round-ups (the savings leg) are skipped: they reach their parent through their transfer pair.
 */
export function linkRoundups(rows: CandidateRow[]): RoundupLink[] {
  const parsed = rows.map((r) => (r.amountCents < 0 ? parseRoundupParent(r.description) : null))
  const links: RoundupLink[] = []
  parsed.forEach((parent, roundupIndex) => {
    const roundup = rows[roundupIndex]
    if (parent === null || !roundup) return
    const candidates: number[] = []
    rows.forEach((r, i) => {
      if (i !== roundupIndex && parsed[i] === null && r.valueDate === roundup.valueDate && r.amountCents === -parent) {
        candidates.push(i)
      }
    })
    if (candidates.length === 0) {
      links.push({ roundupIndex, parentIndex: null, basis: 'none' })
      return
    }
    // Several identical round-ups competing for a single purchase make "the only candidate" untrue.
    const siblings = parsed.filter((p, i) => p === parent && rows[i]?.valueDate === roundup.valueDate).length
    if (candidates.length === 1 && siblings === 1) {
      links.push({ roundupIndex, parentIndex: candidates[0] ?? null, basis: 'unique-amount' })
      return
    }
    const adjacent = candidates.filter((i) => {
      const p = rows[i]
      return i === roundupIndex + 1 && p !== undefined && p.balanceCents + roundup.amountCents === roundup.balanceCents
    })
    if (adjacent.length === 1) links.push({ roundupIndex, parentIndex: adjacent[0] ?? null, basis: 'adjacency' })
    else links.push({ roundupIndex, parentIndex: null, basis: 'ambiguous' })
  })
  return links
}

const WINDOW_DAYS = 3
const TRANSFER_KINDS: ReadonlyArray<TransactionRow['kind']> = ['internal', 'roundup']

// Exact integers so a test (and the preview) can reason about them: same day 100, minus 10 per day away.
const scoreFor = (dayDistance: number): number => 100 - 10 * dayDistance

const isLeg = (t: TransactionRow | undefined): t is TransactionRow =>
  t !== undefined && t.deletedAt === null && TRANSFER_KINDS.includes(t.kind)

interface Edge { committed: TransactionRow; other: TransactionRow; score: number }

const cmp = (a: string | number, b: string | number): number => (a < b ? -1 : a > b ? 1 : 0)

const linkedLegIds = async (): Promise<Set<string>> => {
  const taken = new Set<string>()
  for (const t of await db.transfers.toArray()) { taken.add(t.outTransactionId); taken.add(t.inTransactionId) }
  return taken
}

/**
 * Proposes transfers between the just-committed rows of `accountId` and rows in the other accounts.
 * Reads only: the caller writes the result inside its own transaction, so this must not open one.
 * A match needs different accounts, opposite sign and equal absolute amount. Internal legs may differ by up to
 * 3 days of value date; round-ups must be on the same day and name the same parent purchase (§9.2);
 * the ceil_to_euro identity is deliberately not used, since the multiplier is an ING setting.
 */
export async function pairAcrossAccounts(accountId: string, committedIds: string[]): Promise<TransferRow[]> {
  const committed = (await db.transactions.bulkGet(committedIds)).filter(isLeg).filter((t) => t.accountId === accountId)
  if (committed.length === 0) return []

  const taken = await linkedLegIds()
  const free = committed.filter((t) => !taken.has(t.id))
  if (free.length === 0) return []

  const otherAccounts = (await db.accounts.toArray()).map((a) => a.id).filter((id) => id !== accountId)
  const dates = free.map((t) => t.valueDate).sort()
  const lo = addDays(dates[0] ?? '', -WINDOW_DAYS)
  const hi = addDays(dates[dates.length - 1] ?? '', WINDOW_DAYS)
  const pool: TransactionRow[] = []
  for (const id of otherAccounts) {
    const rows = await db.transactions.where('[accountId+valueDate]').between([id, lo], [id, hi], true, true).toArray()
    pool.push(...rows.filter((t) => isLeg(t) && !taken.has(t.id)))
  }

  // §9.2: the parent phrase is part of a round-up's match key, so a round-up only ever pairs with a
  // round-up naming the same parent, on the same day. The +-3 day window exists for internal transfers
  // alone (ING sometimes dates the two legs differently); round-ups are same-day or nothing. A round-up
  // and an internal leg never pair, whatever their amounts.
  const edges: Edge[] = []
  for (const c of free) {
    for (const o of pool) {
      if (o.amountCents !== -c.amountCents || o.kind !== c.kind) continue
      if (c.kind === 'roundup') {
        const parent = parseRoundupParent(c.description)
        if (parent === null || parent !== parseRoundupParent(o.description) || c.valueDate !== o.valueDate) continue
        edges.push({ committed: c, other: o, score: scoreFor(0) })
      } else {
        const distance = Math.abs(daysBetween(c.valueDate, o.valueDate))
        if (distance <= WINDOW_DAYS) edges.push({ committed: c, other: o, score: scoreFor(distance) })
      }
    }
  }
  // Best score first; ties broken by the other leg's date, fileSeq, id, then the committed leg's, so the
  // pairing never depends on iteration order.
  edges.sort((a, b) =>
    b.score - a.score ||
    cmp(a.other.valueDate, b.other.valueDate) || cmp(a.other.fileSeq, b.other.fileSeq) || cmp(a.other.id, b.other.id) ||
    cmp(a.committed.valueDate, b.committed.valueDate) || cmp(a.committed.fileSeq, b.committed.fileSeq) ||
    cmp(a.committed.id, b.committed.id))

  const used = new Set<string>()
  const matchedAt = Date.now()
  const out: TransferRow[] = []
  for (const { committed: c, other: o, score } of edges) {
    if (used.has(c.id) || used.has(o.id)) continue
    used.add(c.id)
    used.add(o.id)
    const [outLeg, inLeg] = c.amountCents < 0 ? [c, o] : [o, c]
    out.push({
      id: crypto.randomUUID(), outTransactionId: outLeg.id, inTransactionId: inLeg.id,
      amountCents: Math.abs(c.amountCents), matchScore: score, confirmedByUser: false, matchedAt,
      linkKind: c.kind === 'roundup' ? 'roundup' : 'internal',
    })
  }
  return out
}

/** Internal movements of an account with no transfer yet: "unmatched transfer, the other account may not be imported yet". */
export async function unmatchedTransfers(accountId: string): Promise<TransactionRow[]> {
  const taken = await linkedLegIds()
  const rows = await db.transactions.where('accountId').equals(accountId).toArray()
  return rows.filter((t) => isLeg(t) && t.kind === 'internal' && !taken.has(t.id))
}

/**
 * How many internal movements, over every account, have no matching leg in another account yet (the same set as summing
 * `unmatchedTransfers` over the accounts). Counted from index KEYS only: no transaction or transfer row is read, so the
 * banner it feeds costs nothing per save however long the history is (spec 39.4).
 */
export async function unmatchedTransferCount(): Promise<number> {
  const [internal, deleted, asOut, asIn] = await Promise.all([
    db.transactions.where('kind').equals('internal').primaryKeys(),
    db.transactions.where('deletedAt').aboveOrEqual(0).primaryKeys(),
    db.transfers.orderBy('outTransactionId').keys(),
    db.transfers.orderBy('inTransactionId').keys(),
  ])
  const gone = new Set<unknown>(deleted)
  const taken = new Set<unknown>([...asOut, ...asIn])
  return internal.filter((id) => !gone.has(id) && !taken.has(id)).length
}

export interface RoundupContext {
  /** The purchase this round-up is currently linked to, by the bank's matching or the owner's choice; null when it has none. */
  parent: ResolvedTransaction | null
  /** Purchases it could be linked to: same account and bank day, for exactly the amount its description names. */
  candidates: ResolvedTransaction[]
}

/**
 * What the owner needs to see for one round-up, or null when `id` is not an outflow round-up whose description names a
 * parent purchase. Read-only. The import links a round-up only when the balance chain proves which purchase it follows;
 * when it ties ('ambiguous') or no such purchase is in that file ('none') the link stays empty (spec 32.3, 39.2), and
 * this is how the owner finds out and fixes it. The rule for "could be the parent" is stated here once: `chooseRoundupParent`
 * and the list the screen offers both come from this function, so the screen cannot offer a choice the write would refuse.
 * Bank values throughout (spec 41): the day and amount are what the bank recorded.
 */
export async function roundupContext(id: string): Promise<RoundupContext | null> {
  const bank = await db.transactions.get(id)
  if (!bank || bank.deletedAt !== null || bank.kind !== 'roundup' || bank.amountCents >= 0) return null
  const named = parseRoundupParent(bank.description)
  if (named === null) return null
  const sameDay = await db.transactions.where('[accountId+valueDate]').equals([bank.accountId, bank.valueDate]).toArray()
  const fits = sameDay.filter((t) => t.id !== bank.id && t.deletedAt === null && t.kind === 'spend' && t.amountCents === -named && parseRoundupParent(t.description) === null)
  const [self] = await resolveMany([bank])
  const parentRow = self?.roundupParentId ? await db.transactions.get(self.roundupParentId) : undefined
  const resolved = await resolveMany([...fits, ...(parentRow ? [parentRow] : [])])
  return {
    parent: parentRow ? resolved.find((r) => r.id === parentRow.id) ?? null : null,
    candidates: resolved.filter((r) => fits.some((f) => f.id === r.id)).sort((a, b) => a.fileSeq - b.fileSeq || (a.id < b.id ? -1 : 1)),
  }
}

/**
 * The owner's choice of parent purchase for a round-up: the first writer of `annotations.roundupParentIdOverride`.
 * It refuses anything `roundupContext` would not have offered, then writes through `writeAnnotation(..., 'owner')` like
 * every other owner edit, so the choice is one transaction and leaves its learning event.
 */
export async function chooseRoundupParent(roundupId: string, parentId: string): Promise<void> {
  const context = await roundupContext(roundupId)
  if (!context) throw new Error('This is not a round-up that names a purchase, so there is nothing to choose. Nothing was changed.')
  if (!context.candidates.some((c) => c.id === parentId)) {
    throw new Error('That purchase does not fit this round-up: it must be from the same day and account, for the amount the round-up names. Nothing was changed.')
  }
  await writeAnnotation(roundupId, { roundupParentIdOverride: parentId }, 'owner')
}
