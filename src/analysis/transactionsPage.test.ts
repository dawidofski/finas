import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../db/db'
import type { TransactionRow } from '../db/schema'
import { transactionRowReads } from '../test/reads'
import { deletedTransactions, totalTransactions, transactionsPage, type BrowseOrder, type Visibility } from './transactionsPage'

const SIZE = 7

/** Deterministic and tie-heavy: 4-6 rows to a day, two accounts, fileSeq unrelated to id order, some deleted. */
async function seed(): Promise<TransactionRow[]> {
  const rows: TransactionRow[] = []
  let n = 0
  for (let day = 1; day <= 40; day++) {
    const date = `2026-${day <= 30 ? '10' : '11'}-${String(day <= 30 ? day : day - 30).padStart(2, '0')}`
    const count = 4 + (day % 3)
    for (let k = 0; k < count; k++) {
      n++
      rows.push({
        // ids that sort differently from fileSeq, so the same-day order is genuinely the list's, not the index's
        id: `t${String(1000 - n * 7 % 997).padStart(4, '0')}`, accountId: n % 3 === 0 ? 'acc.2' : 'acc.1', valueDate: date,
        amountCents: -100 * n, balanceCents: 0, description: `Invented ${n}`, comment: null, ingCategory: null, ingSubcategory: null,
        kind: 'spend', dedupKey: `k${n}`, importId: 'imp.1', fileSeq: (n * 5) % 11, roundupParentId: null, createdAt: 1,
        deletedAt: n % 9 === 0 ? 5 : null,
      })
    }
  }
  await db.transactions.bulkAdd(rows)
  return rows
}

const newest = (a: TransactionRow, b: TransactionRow) =>
  a.valueDate < b.valueDate ? 1 : a.valueDate > b.valueDate ? -1 : a.fileSeq - b.fileSeq || (a.id < b.id ? -1 : 1)

beforeEach(async () => { await db.delete(); await db.open() })

describe('transactionsPage', () => {
  const cases: Array<[Visibility, string, BrowseOrder]> = []
  for (const v of ['active', 'deleted', 'all'] as const) for (const a of ['', 'acc.1', 'acc.2']) for (const o of ['newest', 'oldest'] as const) cases.push([v, a, o])

  it.each(cases)('pages through exactly the list the full sort would give: %s, account "%s", %s', async (visibility, accountId, order) => {
    const all = await seed()
    const wanted = all
      .filter((t) => (visibility === 'all' || (visibility === 'active') === (t.deletedAt === null)) && (accountId === '' || t.accountId === accountId))
      .sort(order === 'newest' ? newest : (a, b) => newest(b, a))
      .map((t) => t.id)
    const seen: string[] = []
    for (let page = 0; page * SIZE < wanted.length + SIZE; page++) {
      const result = await transactionsPage({ visibility, accountId, order, page, pageSize: SIZE })
      expect(result.matching).toBe(wanted.length)
      expect(result.rows.length).toBeLessThanOrEqual(SIZE)
      seen.push(...result.rows.map((t) => t.id))
    }
    expect(seen).toEqual(wanted)
  })

  it('reads one page of rows, plus the same-day rows at its two edges, never the ledger', async () => {
    await seed()
    const reads = await transactionRowReads(async () => {
      const result = await transactionsPage({ visibility: 'active', accountId: '', order: 'newest', page: 3, pageSize: SIZE })
      expect(result.rows).toHaveLength(SIZE)
    })
    // 7 rows, and at most 6 more on each of two edge days (a day has 4-6 rows): far from the ~190 stored.
    expect(reads).toBeGreaterThanOrEqual(SIZE)
    expect(reads).toBeLessThanOrEqual(SIZE + 2 * 6)
    expect(await totalTransactions()).toBeGreaterThan(150)
  })

  it('counts without reading: totals and deleted rows come from indexes', async () => {
    const all = await seed()
    const reads = await transactionRowReads(async () => {
      expect(await totalTransactions()).toBe(all.length)
      expect(await deletedTransactions()).toBe(all.filter((t) => t.deletedAt !== null).length)
    })
    expect(reads).toBe(0)
  })

  it('returns an empty page, and the true count, past the end', async () => {
    await seed()
    const result = await transactionsPage({ visibility: 'all', accountId: '', order: 'newest', page: 99, pageSize: SIZE })
    expect(result.rows).toEqual([])
    expect(result.matching).toBeGreaterThan(0)
  })
})
