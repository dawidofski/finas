import { describe, expect, it } from 'vitest'
import { ImportError } from './detect'
import { FIXTURE_DATA_ROWS, FIXTURE_HEADER_ROWS, buildXlsx } from './__fixtures__/build'
import { readXlsxGrid } from './xlsx'
import { classifyKind, dedupKeyFor, normaliseGrid, verifyBalanceChain, type CandidateRow } from './normalise'

const gridOf = (header = FIXTURE_HEADER_ROWS, data = FIXTURE_DATA_ROWS): string[][] =>
  readXlsxGrid(buildXlsx(header, data))

const TITLES = ['F. VALOR', 'CATEGORÍA', 'SUBCATEGORÍA', 'DESCRIPCIÓN', 'COMENTARIO', 'IMPORTE (€)', 'SALDO (€)']
const withTitles = (titles: string[]) => [...FIXTURE_HEADER_ROWS.slice(0, 3), titles]

const row = (over: Partial<CandidateRow> = {}): CandidateRow => ({
  accountId: 'acc.1', valueDate: '2026-11-15', amountCents: -2320, balanceCents: 50000,
  description: 'Pago en COMERCIO EJEMPLO SL', comment: null, ingCategory: 'Compras', ingSubcategory: 'Compras (otros)',
  kind: 'spend', dedupKey: '', fileSeq: 1, roundupParentId: null, ...over,
})

describe('normaliseGrid', () => {
  it('maps the seven ING columns in order', async () => {
    const { rows } = await normaliseGrid(gridOf(), [], 'acc.1')
    expect(rows).toHaveLength(3)
    expect(rows[2]).toMatchObject({
      accountId: 'acc.1', valueDate: '2026-11-14', ingCategory: 'Vehículo y transporte',
      ingSubcategory: 'Combustible', description: 'Compra EN GASOLINERA EJEMPLO', comment: 'nota',
      amountCents: -4000, balanceCents: 101320, fileSeq: 3,
    })
    expect(rows[0]?.comment).toBeNull()
    expect(rows[0]?.dedupKey).toMatch(/^[0-9a-f]{64}$/)
  })

  it('converts the Excel serial date', async () => {
    const { rows } = await normaliseGrid(gridOf(), [], 'a')
    expect(rows[0]?.valueDate).toBe('2026-11-15')
  })

  it('parses amounts carrying float noise', async () => {
    const { rows } = await normaliseGrid(gridOf(), [], 'a')
    expect(rows[0]?.amountCents).toBe(-1245)
    expect(rows[0]?.balanceCents).toBe(99755)
  })

  it('scrubs the description and reports counts only', async () => {
    const data = [[46341, 'Otros gastos', 'Transferencias', 'Traspaso emitido a TITULAR DE PRUEBA', '', -5, 100]]
    const { rows, scrub } = await normaliseGrid(gridOf(FIXTURE_HEADER_ROWS, data), ['TITULAR', 'PRUEBA'], 'a')
    expect(rows[0]?.description).not.toContain('PRUEBA')
    expect(scrub.descriptionsScrubbed).toBe(1)
  })

  it('refuses a grid whose headers are not the expected seven, naming both', async () => {
    const moved = [...TITLES]
    ;[moved[5], moved[6]] = [moved[6] as string, moved[5] as string]
    const err = await normaliseGrid(gridOf(withTitles(moved)), [], 'a').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ImportError)
    expect((err as ImportError).message).toBe(
      'Column 6 of the ING export is titled "SALDO (€)" but "IMPORTE (€)" was expected. ' +
        'The columns have moved or been renamed, so nothing was imported.',
    )
  })

  it('refuses a renamed column', async () => {
    const renamed = [...TITLES]
    renamed[5] = 'AMOUNT'
    await expect(normaliseGrid(gridOf(withTitles(renamed)), [], 'a')).rejects.toThrow(/"AMOUNT".*"IMPORTE \(€\)"/)
  })

  it('refuses a grid with fewer than seven columns', async () => {
    const narrow = [['Número de cuenta', 'x'], ['Titular', 'y'], ['Fecha exportación', 'z'], ['F. VALOR', 'CATEGORÍA']]
    const err = await normaliseGrid(narrow, [], 'a').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ImportError)
    expect((err as ImportError).message).toMatch(/seven/)
  })

  it('refuses a grid too short to have a title row', async () => {
    await expect(normaliseGrid([['a']], [], 'a')).rejects.toBeInstanceOf(ImportError)
  })

  it('names the row when an amount cannot be read', async () => {
    const data = [[46341, 'Compras', 'Compras (otros)', 'x', '', 'abc', 10]]
    await expect(normaliseGrid(gridOf(FIXTURE_HEADER_ROWS, data), [], 'a')).rejects.toThrow(/Row 5/)
  })

  it('keeps an unseen ING pair as the bank wrote it rather than throwing', async () => {
    const data = [
      [46341, 'Compras', 'Compras (otros)', 'a', '', -1, 100],
      [46341, 'Categoría Nueva', 'Subcategoría Nueva', 'b', '', -2, 101],
    ]
    const { rows } = await normaliseGrid(gridOf(FIXTURE_HEADER_ROWS, data), [], 'a')
    expect(rows).toHaveLength(2)
    expect(rows[1]?.kind).toBe('spend')
    expect(rows[1]?.ingCategory).toBe('Categoría Nueva')
  })
})

describe('classifyKind', () => {
  it.each([
    ['Ahorro', 'Redondeo', -10, 'roundup'],
    ['Ahorro', 'Redondeo', 10, 'roundup'],
    ['Movimientos excluidos', 'Traspaso entre cuentas', 8000, 'internal'],
    ['Movimientos excluidos', 'Traspaso entre cuentas', -8000, 'internal'],
    ['Alimentación', 'Supermercados y alimentación', -265, 'spend'],
    ['Otros gastos', 'Transferencias', 150000, 'income'],
    [null, null, 100, 'income'],
    [null, null, -100, 'spend'],
  ] as const)('classifies %s/%s (%i) as %s', (cat, sub, cents, kind) => {
    expect(classifyKind(cat, sub, cents)).toBe(kind)
  })
})

describe('dedupKeyFor', () => {
  it('keys from bank values only', async () => {
    const a = await dedupKeyFor(row({ kind: 'spend', comment: null, ingCategory: 'Compras' }))
    const b = await dedupKeyFor(row({ kind: 'income', comment: 'edited', ingCategory: 'Otros', fileSeq: 9, roundupParentId: 'x' }))
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })

  it('does not include the description in the key', async () => {
    const a = await dedupKeyFor(row({ description: 'Pago en COMERCIO EJEMPLO SL' }))
    const b = await dedupKeyFor(row({ description: 'Pago en OTRO COMERCIO' }))
    const c = await dedupKeyFor(row({ description: '' }))
    expect(a).toBe(b)
    expect(a).toBe(c)
  })

  it('changes with each of account, date, amount and balance', async () => {
    const base = await dedupKeyFor(row())
    for (const over of [{ accountId: 'acc.2' }, { valueDate: '2026-11-14' }, { amountCents: -1121 }, { balanceCents: 50001 }]) {
      expect(await dedupKeyFor(row(over))).not.toBe(base)
    }
  })

  it('does not let adjacent fields run together', async () => {
    const a = await dedupKeyFor(row({ amountCents: 12, balanceCents: 3 }))
    const b = await dedupKeyFor(row({ amountCents: 1, balanceCents: 23 }))
    expect(a).not.toBe(b)
  })

  it('gives distinct keys to two same-day same-amount rows', async () => {
    const data = [
      [46341, 'Compras', 'Compras (otros)', 'Pago en COMERCIO EJEMPLO SL', '', -23.2, 200],
      [46341, 'Compras', 'Compras (otros)', 'Pago en COMERCIO EJEMPLO SL', '', -23.2, 223.2],
    ]
    const { rows } = await normaliseGrid(gridOf(FIXTURE_HEADER_ROWS, data), [], 'a')
    expect(rows[0]).toMatchObject({ valueDate: rows[1]?.valueDate, amountCents: rows[1]?.amountCents })
    expect(rows[0]?.description).toBe(rows[1]?.description)
    expect(rows[0]?.dedupKey).not.toBe(rows[1]?.dedupKey)
  })

  it('is stable across normalisations of the same grid', async () => {
    const a = await normaliseGrid(gridOf(), [], 'a')
    const b = await normaliseGrid(gridOf(), [], 'a')
    expect(a.rows.map((r) => r.dedupKey)).toEqual(b.rows.map((r) => r.dedupKey))
  })
})

describe('verifyBalanceChain', () => {
  it('verifies a continuous balance chain', async () => {
    const { rows } = await normaliseGrid(gridOf(), [], 'a')
    expect(verifyBalanceChain(rows)).toEqual({ ok: true, breaks: [] })
  })

  it('treats zero or one row as continuous', () => {
    expect(verifyBalanceChain([])).toEqual({ ok: true, breaks: [] })
    expect(verifyBalanceChain([row()])).toEqual({ ok: true, breaks: [] })
  })

  it('reports the index and amounts of a break', () => {
    // Newest first: rows[i].balance must equal rows[i+1].balance + rows[i].amount.
    const rows = [
      row({ amountCents: -100, balanceCents: 900 }), // 1000 - 100: fine
      row({ amountCents: -50, balanceCents: 1000 }), // 1100 - 50 = 1050 expected, 1000 found
      row({ amountCents: -25, balanceCents: 1100 }),
    ]
    const result = verifyBalanceChain(rows)
    expect(result.ok).toBe(false)
    expect(result.breaks).toEqual([{ index: 1, expected: 1050, found: 1000 }])
  })
})

describe('fixes after review', () => {
  it('scrubs the holder name out of COMENTARIO as well as the description', async () => {
    const data = [[46341, 'Otros gastos', 'Transferencias', 'x', 'para TITULAR DE PRUEBA gracias', -5, 100]]
    const { rows } = await normaliseGrid(gridOf(FIXTURE_HEADER_ROWS, data), ['TITULAR', 'PRUEBA'], 'a')
    expect(rows[0]?.comment).not.toMatch(/TITULAR|PRUEBA/)
    expect(rows[0]?.comment).toContain('gracias')
  })

  it.each(['20261115', '0', '80001'])('refuses the implausible date cell %s, naming the row and column', async (cell) => {
    const data = [[{ raw: cell }, 'Compras', 'Compras (otros)', 'x', '', -1, 100]]
    await expect(normaliseGrid(gridOf(FIXTURE_HEADER_ROWS, data), [], 'a')).rejects.toThrow(/Row 5.*F\. VALOR/)
  })

  it('accepts decomposed accents and stray spaces in the titles', async () => {
    const titles = TITLES.map((t, i) => (i === 1 || i === 2 || i === 3 ? ` ${t.normalize('NFD')} ` : t))
    const { rows } = await normaliseGrid(gridOf(withTitles(titles)), [], 'a')
    expect(rows).toHaveLength(3)
  })

  it('still refuses a title that differs only in case, and says the two look alike', async () => {
    const titles = [...TITLES]
    titles[3] = 'Descripción'
    await expect(normaliseGrid(gridOf(withTitles(titles)), [], 'a')).rejects.toThrow(/look alike/)
  })

  it('reads a blank category as null', async () => {
    const data = [[46341, '', '', 'x', '', -1, 100]]
    const { rows } = await normaliseGrid(gridOf(FIXTURE_HEADER_ROWS, data), [], 'a')
    expect(rows[0]).toMatchObject({ ingCategory: null, ingSubcategory: null })
  })
})

/** Real-file check, skipped without FINANCE_REAL_XLSX. Asserts shape and chain continuity only: no amount or text. */
const realPath = process.env['FINANCE_REAL_XLSX']
describe.skipIf(!realPath)('a real ING export (FINANCE_REAL_XLSX)', () => {
  it('normalises with a continuous chain and unique keys', async () => {
    const { readFileSync } = await import('node:fs')
    const grid = readXlsxGrid(new Uint8Array(readFileSync(realPath as string)))
    const { rows } = await normaliseGrid(grid, [], 'real')
    expect(rows.length).toBeGreaterThan(0)
    expect(verifyBalanceChain(rows).ok).toBe(true)
    expect(new Set(rows.map((r) => r.dedupKey)).size).toBe(rows.length)
  })
})
