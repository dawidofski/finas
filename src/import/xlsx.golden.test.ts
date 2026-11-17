import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { detectFormat } from './detect'
import { readXlsxGrid } from './xlsx'

/**
 * Golden test against a REAL ING export. A fixture built from our own understanding of the format cannot falsify
 * that understanding; only the bank's own file can.
 *
 * Skipped by default, so CI on a clean checkout never sees (or needs) the file. To run it, point
 * FINANCE_REAL_XLSX at either export, for example in PowerShell:
 *
 *   $env:FINANCE_REAL_XLSX = 'C:\path\to\movements-15112026.xlsx'; npx vitest run src/import/xlsx.golden.test.ts
 *
 * The savings export is named .xls but is a ZIP; this test reads it by content like everything else.
 *
 * It asserts SHAPE and the public column titles only. No amount, balance, date or description text appears here,
 * even as an expected value: those are the owner's financial records and must not enter the repository.
 */
const path = process.env['FINANCE_REAL_XLSX']

const TITLES = ['F. VALOR', 'CATEGORÍA', 'SUBCATEGORÍA', 'DESCRIPCIÓN', 'COMENTARIO', 'IMPORTE (€)', 'SALDO (€)']

describe.skipIf(!path)('a real ING export (FINANCE_REAL_XLSX)', () => {
  const bytes = path ? new Uint8Array(readFileSync(path)) : new Uint8Array(0)

  it('is detected as xlsx by content', () => {
    expect(detectFormat(bytes)).toBe('xlsx')
  })

  it('has the header block, the seven column titles and the data rows', () => {
    const grid = readXlsxGrid(bytes)
    expect(grid.length).toBeGreaterThanOrEqual(54) // 3 header rows + title row + 50 data rows
    expect(grid[3]?.filter((cell) => cell !== '')).toHaveLength(7)
    expect(grid[3]?.slice(0, 7)).toEqual(TITLES)
  })

  it('round-trips accented text byte-exact', () => {
    const grid = readXlsxGrid(bytes)
    // Whole grid, not only data rows: the savings export has accents only in its header block and titles.
    const accented = grid.flatMap((row) => row).filter((cell) => /[áéíóúñÁÉÍÓÚÑ]/.test(cell))
    expect(accented.length).toBeGreaterThan(0)
    // Already NFC: normalising must change nothing, so no decomposed accent was introduced or lost on the way.
    for (const cell of accented) expect(cell.normalize('NFC')).toBe(cell)
  })
})
