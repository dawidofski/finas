import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../db/db'
import { seedDatabase } from '../db/seed'
import type { ImportRow } from '../db/schema'
import type { CandidateRow } from './normalise'
import { analyseGap, coveredRanges } from './coverage'

let uid = 0

/**
 * Builds a file the way ING writes it: newest first, with a balance chain that holds.
 * `moves` are given oldest first, which is how a person thinks about them.
 */
const file = (accountId: string, opening: number, moves: Array<[string, number]>): CandidateRow[] => {
  let balance = opening
  const rows = moves.map(([valueDate, amountCents], i): CandidateRow => {
    balance += amountCents
    return {
      accountId, valueDate, amountCents, balanceCents: balance, description: 'Pago en TIENDA INVENTADA',
      comment: null, ingCategory: 'Compras', ingSubcategory: 'Compras (otros)', kind: 'spend',
      dedupKey: `key.${++uid}.${i}`, fileSeq: 0, roundupParentId: null,
    }
  })
  return rows.reverse().map((r, i) => ({ ...r, fileSeq: i + 1 }))
}

/** Stores a file as an already-committed import, so the account has real transactions and real coverage. */
const commit = async (rows: CandidateRow[]): Promise<void> => {
  const dates = rows.map((r) => r.valueDate).sort()
  const first = rows[0]
  if (!first) throw new Error('empty fixture')
  const importId = `imp.${++uid}`
  const imp: ImportRow = {
    id: importId, filename: 'x.xlsx', format: 'xlsx', fileHash: `hash.${uid}`, accountId: first.accountId, importedAt: uid,
    coverageStart: dates[0] ?? '', coverageEnd: dates[dates.length - 1] ?? '', rowsDetected: rows.length,
    rowsNew: rows.length, rowsDuplicate: 0, rowsErrored: 0, rowsNeedsReview: 0, balanceChainOk: true,
    scrubReport: null, notes: null,
  }
  await db.imports.add(imp)
  for (const r of rows) {
    await db.transactions.add({ ...r, id: `t.${++uid}`, importId, createdAt: 1, deletedAt: null })
  }
}

/** An import row with no transactions behind it: enough for range arithmetic. */
const window = async (accountId: string, coverageStart: string, coverageEnd: string): Promise<void> => {
  await db.imports.add({
    id: `imp.${++uid}`, filename: 'x.xlsx', format: 'xlsx', fileHash: `hash.${uid}`, accountId, importedAt: uid,
    coverageStart, coverageEnd, rowsDetected: 0, rowsNew: 0, rowsDuplicate: 0, rowsErrored: 0, rowsNeedsReview: 0,
    balanceChainOk: true, scrubReport: null, notes: null,
  })
}

beforeEach(async () => {
  uid = 0
  await db.delete(); await db.open(); await seedDatabase()
})

describe('coveredRanges', () => {
  it('is empty for an account with no imports', async () => {
    expect(await coveredRanges('acc.1')).toEqual([])
  })

  it('merges adjacent and overlapping import windows into one range', async () => {
    await window('acc.1', '2026-11-01', '2026-11-05')
    await window('acc.1', '2026-11-06', '2026-11-08') // starts the day after the first ends
    await window('acc.1', '2026-11-07', '2026-11-12') // overlaps the second
    expect(await coveredRanges('acc.1')).toEqual([{ start: '2026-11-01', end: '2026-11-12' }])
  })

  it('keeps separated windows separate and returns them ascending', async () => {
    await window('acc.1', '2026-11-20', '2026-11-25')
    await window('acc.1', '2026-11-01', '2026-11-05')
    await window('acc.1', '2026-11-07', '2026-11-09') // one clear day (the 6th) after the first
    expect(await coveredRanges('acc.1')).toEqual([
      { start: '2026-11-01', end: '2026-11-05' },
      { start: '2026-11-07', end: '2026-11-09' },
      { start: '2026-11-20', end: '2026-11-25' },
    ])
  })

  it('treats each account independently', async () => {
    await window('acc.1', '2026-11-01', '2026-11-05')
    await window('acc.2', '2026-11-03', '2026-11-15')
    expect(await coveredRanges('acc.1')).toEqual([{ start: '2026-11-01', end: '2026-11-05' }])
    expect(await coveredRanges('acc.2')).toEqual([{ start: '2026-11-03', end: '2026-11-15' }])
  })
})

describe('analyseGap', () => {
  it('reports first-import when the account has no coverage at all', async () => {
    // §34.8: "detached" on day one would be true and useless.
    const incoming = file('acc.1', 18675, [['2026-11-03', -500], ['2026-11-04', -700]])
    expect(await analyseGap('acc.1', incoming)).toEqual({ kind: 'first-import' })
  })

  it('treats each account independently: another account having coverage does not make this a continuation', async () => {
    await commit(file('acc.2', 58675, [['2026-11-01', -100], ['2026-11-10', -100]]))
    const incoming = file('acc.1', 18675, [['2026-11-03', -500]])
    expect(await analyseGap('acc.1', incoming)).toEqual({ kind: 'first-import' })
  })

  // FORWARD: stored window 1-10 Nov closes at 248,15 EUR. The file begins the next day and its oldest row
  // opens from exactly that balance. The join is: file OLDEST row  <->  stored NEWEST row.
  it('reports contiguous when a file continues the chain forward', async () => {
    await commit(file('acc.1', 26315, [['2026-11-01', -500], ['2026-11-10', -1000]])) // closes at 248,15
    const incoming = file('acc.1', 24815, [['2026-11-11', -700], ['2026-11-12', -300]])
    expect(incoming[incoming.length - 1]?.balanceCents).toBe(24115) // oldest row: 24815 - 700
    expect(await analyseGap('acc.1', incoming)).toEqual({ kind: 'contiguous' })
  })

  // BACKWARD: stored window 10-12 Nov; its OLDEST row (10 Nov, -10,00) closes at 248,15, so before it the
  // balance was 258,15. The file ends on 9 Nov at exactly 258,15. The join is: file NEWEST row <-> stored OLDEST row.
  // The numbers differ from the forward fixture on purpose, so reading the wrong end of either side fails here.
  it('reports contiguous when a file extends the chain backward', async () => {
    await commit(file('acc.1', 25815, [['2026-11-10', -1000], ['2026-11-12', -250]]))
    const incoming = file('acc.1', 28675, [['2026-11-08', -1860], ['2026-11-09', -1000]])
    expect(incoming[0]?.balanceCents).toBe(25815) // newest row of the file
    expect(await analyseGap('acc.1', incoming)).toEqual({ kind: 'contiguous' })
  })

  it('reports a forward gap with the missing euro delta (248,15 -> 181,01, §5.3)', async () => {
    await commit(file('acc.1', 25815, [['2026-11-10', -1000]])) // ends at 248,15
    const incoming = file('acc.1', 18401, [['2026-11-11', -300]]) // oldest row opens from 184,01 and lands on 181,01
    expect(await analyseGap('acc.1', incoming)).toEqual({
      kind: 'gap', reExportFrom: '2026-11-10', reExportTo: '2026-11-11', balanceDelta: -6414, // 184,01 - 248,15
    })
  })

  it('reports a backward gap, and the delta is the net the missing rows must carry', async () => {
    await commit(file('acc.1', 25815, [['2026-11-10', -1000]])) // oldest stored row opens from 258,15
    const incoming = file('acc.1', 28675, [['2026-11-09', -500]]) // newest file row closes at 281,75
    expect(await analyseGap('acc.1', incoming)).toEqual({
      kind: 'gap', reExportFrom: '2026-11-09', reExportTo: '2026-11-10', balanceDelta: -2360, // 258,15 - 281,75
    })
  })

  it('reports contiguous for a file that fills a hole and joins both seams', async () => {
    const before = file('acc.1', 38675, [['2026-11-01', -1000], ['2026-11-03', -500]]) // closes 371,75
    const middle = file('acc.1', 37175, [['2026-11-04', -400], ['2026-11-06', -600]]) // closes 361,75
    const after = file('acc.1', 36175, [['2026-11-07', -100], ['2026-11-09', -200]])
    await commit(before)
    await commit(after)
    expect(await analyseGap('acc.1', middle)).toEqual({ kind: 'contiguous' })
  })

  it('reports a gap for a hole-filling file whose far seam does not reconcile', async () => {
    await commit(file('acc.1', 38675, [['2026-11-01', -1000], ['2026-11-03', -500]]))
    await commit(file('acc.1', 36175, [['2026-11-07', -100], ['2026-11-09', -200]]))
    const middle = file('acc.1', 37175, [['2026-11-04', -400], ['2026-11-06', -300]]) // closes 364,75, not 361,75
    expect(await analyseGap('acc.1', middle)).toEqual({
      kind: 'gap', reExportFrom: '2026-11-06', reExportTo: '2026-11-07', balanceDelta: -300,
    })
  })

  // ING only writes rows for days with activity, so a calendar hole may hold nothing at all.
  it('reports contiguous across a calendar hole whose balances reconcile (a quiet weekend)', async () => {
    await commit(file('acc.1', 18675, [['2026-11-01', -100], ['2026-11-05', -100]])) // closes 184,75
    const incoming = file('acc.1', 18475, [['2026-11-10', -100], ['2026-11-12', -100]])
    expect(await analyseGap('acc.1', incoming)).toEqual({ kind: 'contiguous' })
  })

  it('reports contiguous across a calendar hole before existing coverage when balances reconcile', async () => {
    await commit(file('acc.1', 18475, [['2026-11-10', -100], ['2026-11-12', -100]]))
    const incoming = file('acc.1', 18675, [['2026-11-01', -100], ['2026-11-03', -100]]) // closes 184,75
    expect(await analyseGap('acc.1', incoming)).toEqual({ kind: 'contiguous' })
  })

  it('reports a gap with the delta across a calendar hole whose balances do not reconcile', async () => {
    await commit(file('acc.1', 18675, [['2026-11-01', -100], ['2026-11-05', -100]])) // closes 184,75
    const incoming = file('acc.1', 17675, [['2026-11-10', -100], ['2026-11-12', -100]]) // opens 176,75
    expect(await analyseGap('acc.1', incoming)).toEqual({
      kind: 'gap', reExportFrom: '2026-11-05', reExportTo: '2026-11-10', balanceDelta: -800,
    })
  })

  it('reports detached only when no stored row exists to join to', async () => {
    await window('acc.1', '2026-11-01', '2026-11-05') // an import with no transactions behind it
    const incoming = file('acc.1', 17675, [['2026-11-10', -100], ['2026-11-12', -100]])
    expect(await analyseGap('acc.1', incoming)).toEqual({
      kind: 'detached', uncoveredFrom: '2026-11-06', uncoveredTo: '2026-11-09',
    })
  })

  it('reports detached for a backfill before coverage that has no stored rows', async () => {
    await window('acc.1', '2026-11-10', '2026-11-12')
    const incoming = file('acc.1', 28675, [['2026-11-01', -100], ['2026-11-03', -100]])
    expect(await analyseGap('acc.1', incoming)).toEqual({
      kind: 'detached', uncoveredFrom: '2026-11-04', uncoveredTo: '2026-11-09',
    })
  })

  it('reports detached with the adjoining range itself when it has no stored rows and no calendar hole lies before the file', async () => {
    await window('acc.1', '2026-11-01', '2026-11-05') // ends 5 Nov, holds no transactions
    const incoming = file('acc.1', 17675, [['2026-11-06', -100], ['2026-11-08', -100]]) // starts the very next day
    expect(await analyseGap('acc.1', incoming)).toEqual({
      kind: 'detached', uncoveredFrom: '2026-11-01', uncoveredTo: '2026-11-05',
    })
  })

  it('reports detached with the adjoining range itself when it has no stored rows and no calendar hole lies after the file', async () => {
    await window('acc.1', '2026-11-10', '2026-11-14') // starts 10 Nov, holds no transactions
    const incoming = file('acc.1', 28675, [['2026-11-07', -100], ['2026-11-09', -100]]) // ends the day before
    expect(await analyseGap('acc.1', incoming)).toEqual({
      kind: 'detached', uncoveredFrom: '2026-11-10', uncoveredTo: '2026-11-14',
    })
  })

  it('reports overlap when the window is already fully covered', async () => {
    await commit(file('acc.1', 18675, [['2026-11-01', -100], ['2026-11-05', -100], ['2026-11-10', -100]]))
    const incoming = file('acc.1', 18575, [['2026-11-03', -100], ['2026-11-04', -50]])
    expect(await analyseGap('acc.1', incoming)).toEqual({ kind: 'overlap' })
  })

  it('reports contiguous for a file that overlaps existing coverage and extends it', async () => {
    await commit(file('acc.1', 18675, [['2026-11-01', -100], ['2026-11-10', -100]])) // 10 Nov closes at 184,75
    // The incoming file opens from 185,75 so its 10 Nov row is the very same row: -1,00 landing on 184,75.
    const incoming = file('acc.1', 18575, [['2026-11-10', -100], ['2026-11-12', -50]])
    // Make the sharing visible: the stored and incoming rows for the overlapping day agree on amount and balance.
    const stored10 = (await db.transactions.where('accountId').equals('acc.1').toArray()).find((r) => r.valueDate === '2026-11-10')
    const incoming10 = incoming.find((r) => r.valueDate === '2026-11-10')
    expect(stored10).toBeDefined()
    expect(incoming10).toBeDefined()
    expect([incoming10?.amountCents, incoming10?.balanceCents]).toEqual([stored10?.amountCents, stored10?.balanceCents])
    expect(incoming10?.balanceCents).toBe(18475)
    expect(await analyseGap('acc.1', incoming)).toEqual({ kind: 'contiguous' })
  })

  it('refuses a file with no rows rather than inventing a window', async () => {
    await expect(analyseGap('acc.1', [])).rejects.toThrow(/no rows/i)
  })
})
