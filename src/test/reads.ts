import { db } from '../db/db'

/**
 * How many transaction rows the database handed back while `work` ran: every row a cursor, `toArray`, `get` or
 * `bulkGet` returned, which is the cost spec 39.4 is about. Index-only reads (`count`, `keys`, `primaryKeys`) return no
 * rows and so count as zero, which is exactly the difference between asking about the ledger and reading it.
 *
 * What this does NOT count: the hook sees only rows handed to Dexie's value mapper. A cursor that steps over records (the
 * `offset` of a filtered page, for one) is invisible to it, and because the live-row filter is attached before `offset`, a deep
 * page still makes the database walk through roughly page x 50 records. The expensive half of spec 39.4 (reading, resolving and
 * holding the whole ledger on every save) is what these numbers prove fixed; the cost of stepping a cursor to a deep page is not
 * measured here and is not claimed to be gone.
 */
export async function transactionRowReads(work: () => Promise<unknown>): Promise<number> {
  let reads = 0
  const count = (row: unknown) => { reads++; return row as never } // a reading hook must hand the row back
  db.transactions.hook('reading', count as never)
  try { await work() } finally { db.transactions.hook('reading').unsubscribe(count as never) }
  return reads
}
