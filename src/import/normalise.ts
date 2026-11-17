import type { TransactionKind, TransactionRow } from '../db/schema'
import { excelSerialToIso, parseSpanishDate } from '../lib/dates'
import { sha256Hex } from '../lib/hash'
import { parseAmountToCents } from '../lib/money'
import { ImportError } from './detect'
import { scrubAll, type ScrubReport } from './scrub'

/**
 * Raw grid to candidate rows (design 8.2, 9, 37). Every value here comes from the bank's file; nothing is inferred.
 * The grid is the ING layout: three header-block rows, then the seven column titles on row 4, then data newest first.
 */

/** A transaction before the import mints its id. */
export type CandidateRow = Omit<TransactionRow, 'id' | 'importId' | 'createdAt' | 'deletedAt'>

/** Byte-exact from the owner's real exports. Widening this list would defeat the check it exists to make. */
export const EXPECTED_TITLES = [
  'F. VALOR', 'CATEGORÍA', 'SUBCATEGORÍA', 'DESCRIPCIÓN', 'COMENTARIO', 'IMPORTE (€)', 'SALDO (€)',
] as const

const TITLE_ROW = 3 // zero-based: row 4
const FIRST_DATA_ROW = TITLE_ROW + 1

/**
 * Throws unless row 4 carries exactly the seven expected titles in order. A moved column would otherwise put amounts
 * in the balance field and nothing downstream would notice.
 */
function assertTitles(grid: string[][]): void {
  const found = grid[TITLE_ROW]
  if (!found) {
    throw new ImportError('unreadable', 'This file has no column title row, so it does not look like an ING export.')
  }
  const filled = found.filter((cell) => cell.trim() !== '').length
  if (filled < EXPECTED_TITLES.length) {
    throw new ImportError(
      'unreadable',
      `The ING export should have seven columns (${EXPECTED_TITLES.join(', ')}) but this file has ${filled}. Nothing was imported.`,
    )
  }
  EXPECTED_TITLES.forEach((expected, i) => {
    const actual = found[i] ?? ''
    // Trim and NFC only: this checks column identity, so it cannot mask a rename. Case stays significant.
    const comparable = actual.trim().normalize('NFC')
    if (comparable !== expected) {
      const lookAlike = comparable.replace(/\s+/g, '').toLowerCase() === expected.replace(/\s+/g, '').toLowerCase()
      throw new ImportError(
        'unreadable',
        `Column ${i + 1} of the ING export is titled "${actual}" but "${expected}" was expected. ` +
          (lookAlike ? 'The two look alike but differ in letter case or inner spacing. ' : '') +
          'The columns have moved or been renamed, so nothing was imported.',
      )
    }
  })
}

/** §8.2, in order. */
export function classifyKind(
  ingCategory: string | null,
  ingSubcategory: string | null,
  amountCents: number,
): TransactionKind {
  if (ingCategory === 'Ahorro' && ingSubcategory === 'Redondeo') return 'roundup'
  if (ingCategory === 'Movimientos excluidos') return 'internal'
  return amountCents > 0 ? 'income' : 'spend'
}

/** Serial 1 is 1900 and 80000 is about 2119. A compact date such as 20261115 is all digits too and must be refused. */
const MAX_SERIAL = 80000

function readDate(raw: string, row: number): string {
  try {
    if (!/^\d+$/.test(raw)) return parseSpanishDate(raw)
    const serial = Number(raw)
    if (serial < 1 || serial > MAX_SERIAL) throw new RangeError('serial out of range')
    return excelSerialToIso(serial)
  } catch {
    throw new ImportError('unreadable', `Row ${row}: the F. VALOR value is not a plausible date.`)
  }
}

/** `row` is the 1-based spreadsheet row, so the message points at what the owner sees. */
function readCents(raw: string, column: string, row: number): number {
  try {
    return parseAmountToCents(raw.trim())
  } catch {
    throw new ImportError('unreadable', `Row ${row}: the ${column} value is not a readable amount.`)
  }
}

const orNull = (text: string): string | null => (text.trim() === '' ? null : text)

export async function normaliseGrid(
  grid: string[][],
  tokens: string[],
  accountId: string,
): Promise<{ rows: CandidateRow[]; scrub: ScrubReport }> {
  assertTitles(grid)

  const lines: Array<{ cells: string[]; sheetRow: number }> = []
  grid.slice(FIRST_DATA_ROW).forEach((cells, i) => {
    if (cells.some((cell) => cell.trim() !== '')) lines.push({ cells, sheetRow: FIRST_DATA_ROW + i + 1 })
  })

  // COMENTARIO is free text the owner typed, so it takes the same scrub as DESCRIPCIÓN. One call, so counts are shared
  // (`descriptionsScrubbed` therefore counts any scrubbed free-text field).
  const texts = lines.map((l) => l.cells[3] ?? '')
  const { descriptions: scrubbed, report } = scrubAll([...texts, ...lines.map((l) => l.cells[4] ?? '')], tokens)
  const descriptions = scrubbed.slice(0, lines.length)
  const comments = scrubbed.slice(lines.length)

  const rows: CandidateRow[] = []
  for (const [i, { cells, sheetRow }] of lines.entries()) {
    const valueDate = readDate((cells[0] ?? '').trim(), sheetRow)
    const ingCategory = orNull(cells[1] ?? '')
    const ingSubcategory = orNull(cells[2] ?? '')
    const amountCents = readCents(cells[5] ?? '', 'IMPORTE (€)', sheetRow)
    const balanceCents = readCents(cells[6] ?? '', 'SALDO (€)', sheetRow)
    const candidate: CandidateRow = {
      accountId,
      valueDate,
      amountCents,
      balanceCents,
      description: descriptions[i] ?? '',
      comment: orNull(comments[i] ?? ''),
      ingCategory,
      ingSubcategory,
      kind: classifyKind(ingCategory, ingSubcategory, amountCents),
      dedupKey: '',
      fileSeq: i + 1,
      roundupParentId: null,
    }
    candidate.dedupKey = await dedupKeyFor(candidate)
    rows.push(candidate)
  }
  return { rows, scrub: report }
}

/**
 * sha256(accountId | valueDate | amountCents | balanceCents), hex (design 37). The description is deliberately absent:
 * a running balance plus an amount places a row at one point in the ledger, and the key must not depend on the scrub.
 * Rows that differ only in description share a key; the dedup stage separates them by comparing descriptions.
 */
export async function dedupKeyFor(
  row: Pick<CandidateRow, 'accountId' | 'valueDate' | 'amountCents' | 'balanceCents'>,
): Promise<string> {
  const joined = [row.accountId, row.valueDate, row.amountCents, row.balanceCents].join('|')
  return sha256Hex(new TextEncoder().encode(joined))
}

/**
 * Newest first, so `balance[i] === balance[i+1] + amount[i]`. A break lowers confidence but does not block an import,
 * so it is reported, never thrown. `index` is the newer row of the broken pair.
 */
export function verifyBalanceChain(
  rows: ReadonlyArray<Pick<CandidateRow, 'amountCents' | 'balanceCents'>>,
): { ok: boolean; breaks: Array<{ index: number; expected: number; found: number }> } {
  const breaks: Array<{ index: number; expected: number; found: number }> = []
  for (let i = 0; i + 1 < rows.length; i++) {
    const row = rows[i]
    const older = rows[i + 1]
    if (!row || !older) continue
    const expected = older.balanceCents + row.amountCents
    if (row.balanceCents !== expected) breaks.push({ index: i, expected, found: row.balanceCents })
  }
  return { ok: breaks.length === 0, breaks }
}
