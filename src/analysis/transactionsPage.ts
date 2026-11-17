import Dexie from 'dexie'
import { db } from '../db/db'
import type { TransactionRow } from '../db/schema'

/**
 * One page of the transaction list, read as one page (spec 39.4).
 *
 * Before this, the screen read every transaction, resolved every one of them, and did it again after every save. This
 * reads the `PAGE` rows it will draw (plus, at most, the two same-day groups that straddle the page's edges, see below)
 * and COUNTS the rest from indexes without reading them.
 *
 * What it can and cannot push down. The list is ordered and filtered by the transaction's *resolved* values (an owner's
 * corrected date, amount, description, category), and none of those is indexed: an owner annotation lives in another
 * table. So only what the BANK recorded can be answered by an index: which account, deleted or not, and the bank's value
 * date. This function serves exactly that view, "browse", ordered by the bank's date. Anything that must look at a
 * resolved value (search, category, kind, a date range, ordering by amount) cannot be answered without reading the rows,
 * and the screen reads them all for those, as it always did.
 *
 * The cost this accepts, stated so nobody has to rediscover it: in browse mode a row whose date the owner corrected stays
 * on the page its BANK date puts it on. It shows its corrected date, and the page itself is ordered by the corrected
 * dates, but it does not jump to another page. Moving it would need an index on the annotation's date override, and that
 * is a schema change that waits on spec 29's gates. Figures are unaffected: they are bucketed by the bank's date (41). This is spec 42.1; the list marks such a row "Date changed" so it does not read as a sorting bug.
 */

export type Visibility = 'active' | 'deleted' | 'all'
export type BrowseOrder = 'newest' | 'oldest'

export interface PageQuery {
  visibility: Visibility
  /** Empty for every account. */
  accountId: string
  order: BrowseOrder
  /** Zero-based. */
  page: number
  pageSize: number
}

export interface Page {
  rows: TransactionRow[]
  /** How many rows match the query in all, counted, not read. */
  matching: number
}

const live = (t: TransactionRow) => t.deletedAt === null

type OrderKey = Pick<TransactionRow, 'valueDate' | 'fileSeq' | 'id'>

/**
 * THE list order, on the bank's values: newest date first; within one date a LOWER fileSeq is the NEWER row. The pager and the
 * screen both sort with this one function (the screen passes each row's BANK values, never the owner's corrected date), so
 * what the database pages and what the screen shows cannot drift apart (spec 42.1).
 */
export const newestFirst = (a: OrderKey, b: OrderKey): number =>
  a.valueDate < b.valueDate ? 1 : a.valueDate > b.valueDate ? -1 : a.fileSeq - b.fileSeq || (a.id < b.id ? -1 : 1)
export const oldestFirst = (a: OrderKey, b: OrderKey): number => newestFirst(b, a)
const inOrder = (order: BrowseOrder) => (order === 'newest' ? newestFirst : oldestFirst)

/** Every row, or one account's, in ascending bank-date order. */
function ascending(accountId: string) {
  return accountId
    ? db.transactions.where('[accountId+valueDate]').between([accountId, Dexie.minKey], [accountId, Dexie.maxKey], true, true)
    : db.transactions.orderBy('valueDate')
}

/** Rows of one bank date, optionally one account's. */
function sameDay(accountId: string, date: string) {
  return accountId ? db.transactions.where('[accountId+valueDate]').equals([accountId, date]) : db.transactions.where('valueDate').equals(date)
}

/** Deleted rows, from the `deletedAt` index (which holds only rows that ARE deleted: IndexedDB cannot index null). */
function deletedRows(accountId: string) {
  const all = db.transactions.where('deletedAt').aboveOrEqual(0)
  return accountId ? all.filter((t) => t.accountId === accountId) : all
}

/** Every row there is, deleted or not: a count, never a read. */
export const totalTransactions = (): Promise<number> => db.transactions.count()
/** How many rows are soft-deleted (one account's, or all): the index holds only those, so this is scoped exactly as the deleted view is. */
export const deletedTransactions = (accountId = ''): Promise<number> => deletedRows(accountId).count()

export async function transactionsPage(q: PageQuery): Promise<Page> {
  const { visibility, accountId, order, page, pageSize } = q
  const offset = page * pageSize

  if (visibility === 'deleted') {
    // Bounded by how many rows the owner has deleted, which is its own small set, not by the ledger.
    const rows = (await deletedRows(accountId).toArray()).sort(inOrder(order))
    return { rows: rows.slice(offset, offset + pageSize), matching: rows.length }
  }

  const [inScope, deletedInScope] = await Promise.all([
    accountId ? ascending(accountId).count() : db.transactions.count(),
    visibility === 'active' ? deletedRows(accountId).count() : Promise.resolve(0),
  ])
  const matching = inScope - deletedInScope
  if (offset >= matching) return { rows: [], matching }

  // The index yields a date's rows in primary-key order, but the list's order within one date is fileSeq. So the window
  // is read in index order, then the (at most two) dates at its edges are read whole and the window re-sorted in the
  // list's own order. `skip` is how many of the first date's rows the index put BEFORE this page; the same rows the
  // list's order would put first, since a date's group is contiguous in both.
  const stream = () => {
    const c = order === 'newest' ? ascending(accountId).reverse() : ascending(accountId)
    return visibility === 'active' ? c.filter(live) : c
  }
  const window = await stream().offset(offset).limit(pageSize).toArray()
  const first = window[0]
  const last = window[window.length - 1]
  if (!first || !last) return { rows: [], matching }

  const group = async (date: string) => {
    const c = sameDay(accountId, date)
    return (visibility === 'active' ? c.filter(live) : c).toArray()
  }
  const [head, tail] = await Promise.all([group(first.valueDate), group(last.valueDate)])
  const merged = new Map<string, TransactionRow>()
  for (const t of [...window, ...head, ...tail]) merged.set(t.id, t)

  // Index order within equal keys is primary key ascending, and descending when the cursor runs backwards.
  const before = (id: string) => (order === 'newest' ? id > first.id : id < first.id)
  const skip = head.filter((t) => before(t.id)).length
  return { rows: [...merged.values()].sort(inOrder(order)).slice(skip, skip + pageSize), matching }
}
