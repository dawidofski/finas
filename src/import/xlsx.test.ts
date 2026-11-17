import { describe, expect, it } from 'vitest'
import { Worker } from 'node:worker_threads'
import { createRequire } from 'node:module'
import { strToU8, unzipSync, zipSync } from 'fflate'
import { ImportError } from './detect'
import { MAX_FILE_BYTES, MAX_GRID_CELLS, MAX_PART_BYTES, readXlsxGrid } from './xlsx'
import {
  buildXlsx,
  FIXTURE_ACCOUNT_NUMBER,
  FIXTURE_DATA_ROWS,
  FIXTURE_HEADER_ROWS,
  FIXTURE_HOLDER,
  workbookParts,
  zipParts,
} from './__fixtures__/build'
import { buildZip64WithoutExtraField } from './__fixtures__/malformed'

const XML = '<?xml version="1.0" encoding="UTF-8"?>'
const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
const sheetOf = (rows: string) => `${XML}<worksheet ${NS}><sheetData>${rows}</sheetData></worksheet>`
const inline = (ref: string, text: string) => `<c r="${ref}" t="inlineStr"><is><t>${text}</t></is></c>`

/** Runs `run`, asserts it threw an ImportError (never anything else) and returns it. */
const pad = (row: string[], width = 7): string[] => [...row, ...Array<string>(width - row.length).fill('')]

const refusal = (run: () => unknown): ImportError => {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(ImportError)
    return error as ImportError
  }
  throw new Error('expected an ImportError, but nothing was thrown')
}

describe('readXlsxGrid', () => {
  const grid = readXlsxGrid(buildXlsx(FIXTURE_HEADER_ROWS, FIXTURE_DATA_ROWS))

  it('reads the three header rows and the row-4 column titles', () => {
    expect(grid[0]).toEqual(pad(['Número de cuenta', FIXTURE_ACCOUNT_NUMBER]))
    expect(grid[1]).toEqual(pad(['Titular', FIXTURE_HOLDER]))
    expect(grid[2]).toEqual(pad(['Fecha exportación', '15/11/2026 13:18:54']))
    expect(grid[3]).toEqual(['F. VALOR', 'CATEGORÍA', 'SUBCATEGORÍA', 'DESCRIPCIÓN', 'COMENTARIO', 'IMPORTE (€)', 'SALDO (€)'])
    expect(grid).toHaveLength(FIXTURE_HEADER_ROWS.length + FIXTURE_DATA_ROWS.length)
  })

  it('preserves cell text exactly, including accents and numbers as written', () => {
    expect(grid[4]?.[1]).toBe('Alimentación')
    expect(grid[5]?.[1]).toBe('Cafeterías y restaurantes')
    expect(grid[6]?.[1]).toBe('Vehículo y transporte')
    // Byte-exact against NFC literals: a decomposed accent would differ in length and in code units.
    expect(grid[4]?.[1]).toBe('Alimentación'.normalize('NFC'))
    expect(grid[4]?.[1]?.length).toBe(12)
    // Serial date and IEEE-754 noise survive as the file spelled them.
    expect(grid[4]?.[0]).toBe('46341')
    expect(grid[4]?.[5]).toBe('-12.449999999999999')
  })

  it('returns empty strings for blank cells rather than undefined', () => {
    expect(grid[4]?.[4]).toBe('') // COMENTARIO, absent from the XML
    const sparse = readXlsxGrid(buildXlsx([], [['a', '', '', 'd'], ['', 'b'], ['x', 'y', 'z', 'w']]))
    expect(sparse[0]).toEqual(['a', '', '', 'd'])
    expect(sparse[1]).toEqual(['', 'b', '', ''])
    for (const row of sparse) for (const cell of row) expect(typeof cell).toBe('string')
  })

  it('makes every row exactly as wide as the grid, so row[6] is always a string', () => {
    const sheet = sheetOf(`<row r="1">${inline('A1', 'short')}</row><row r="3">${inline('A3', 'a')}${inline('G3', 'last')}</row>`)
    const result = readXlsxGrid(zipParts(workbookParts(sheet)))
    expect(result).toHaveLength(3)
    for (const row of result) {
      expect(row).toHaveLength(7)
      for (let c = 0; c < 7; c++) expect(typeof row[c]).toBe('string')
    }
    expect(result[0]?.[6]).toBe('') // the trailing column a ragged row would have dropped
    expect(result[1]).toEqual(['', '', '', '', '', '', ''])
    expect(result[2]?.[6]).toBe('last')
    for (const row of grid) expect(row).toHaveLength(7)
  })

  it('keeps the grid row-aligned when whole rows are missing from the sheet', () => {
    const sheet = sheetOf(`<row r="1">${inline('A1', 'top')}</row><row r="4">${inline('B4', 'four')}</row>`)
    expect(readXlsxGrid(zipParts(workbookParts(sheet)))).toEqual([['top', ''], ['', ''], ['', ''], ['', 'four']])
  })

  it('resolves rich-text shared strings and entities, ignoring phonetic runs', () => {
    const shared = `${XML}<sst ${NS}><si><r><t>Cafeter</t></r><r><t xml:space="preserve">ías &amp; bar </t></r><rPh><t>IGNORED</t></rPh></si></sst>`
    const sheet = sheetOf('<row r="1"><c r="A1" t="s"><v>0</v></c></row>')
    expect(readXlsxGrid(zipParts(workbookParts(sheet, shared)))).toEqual([['Cafeterías & bar ']])
  })

  it('reads a workbook with no shared-strings part when every string is inline', () => {
    const sheet = sheetOf(`<row r="1">${inline('A1', 'solo')}<c r="B1"><v>7</v></c></row>`)
    expect(readXlsxGrid(zipParts(workbookParts(sheet)))).toEqual([['solo', '7']])
  })
})

describe('refusals (Review Focus 1)', () => {
  const sheetWithCell = sheetOf(`<row r="1">${inline('A1', 'x')}</row>`)

  it.each([
    ['an empty file', 'empty', () => new Uint8Array(0)],
    ['a truncated zip', 'corrupt-archive', () => buildXlsx(FIXTURE_HEADER_ROWS, FIXTURE_DATA_ROWS).slice(0, 200)],
    ['a zip with no workbook', 'not-a-spreadsheet', () => zipSync({ 'notes.txt': strToU8('this is a zip, not a spreadsheet') })],
    ['a file over 50 MB', 'too-large', () => new Uint8Array(MAX_FILE_BYTES + 1)],
    ['a PDF', 'unsupported-format', () => strToU8('%PDF-1.7\nhello')],
    ['a CSV', 'unsupported-format', () => strToU8('a;b;c\n1;2;3\n')],
    ['an old binary .xls', 'unsupported-format', () => Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0, 1, 2, 3])],
    ['a workbook whose sheet is not XML', 'unreadable', () => zipParts(workbookParts('this is { not xml'))],
    [
      'a sheet that declares an entity (XML bomb)',
      'unreadable',
      () => zipParts(workbookParts(`${XML}<!DOCTYPE x [<!ENTITY a "aaaa">]><worksheet ${NS}><sheetData/></worksheet>`)),
    ],
    ['a sheet whose root is not a worksheet', 'not-a-spreadsheet', () => zipParts(workbookParts(`${XML}<html><body/></html>`))],
    [
      'a sheet with an absurd row reference',
      'too-large',
      () => zipParts(workbookParts(sheetOf(`<row r="999999999">${inline('A999999999', 'x')}</row>`))),
    ],
    [
      'a shared-string index that does not exist',
      'unreadable',
      () => zipParts(workbookParts(sheetOf('<row r="1"><c r="A1" t="s"><v>5</v></c></row>'), `${XML}<sst ${NS}/>`)),
    ],
    ['a sheet that is valid but holds no cells', 'empty', () => zipParts(workbookParts(sheetOf('')))],
    ['(control) a minimal good sheet is NOT refused', 'ok', () => zipParts(workbookParts(sheetWithCell))],
  ] as const)('refuses %s with code %s', (_label, code, make) => {
    if (code === 'ok') {
      expect(readXlsxGrid(make())).toEqual([['x']])
      return
    }
    const error = refusal(() => readXlsxGrid(make()))
    expect(error.code).toBe(code)
    // The message is for the owner, not a developer: a sentence, none of the runtime's vocabulary.
    expect(error.message.length).toBeGreaterThan(20)
    expect(error.message).not.toMatch(/TypeError|undefined|null|Uncaught|\bat \w+\.|fflate|DOMParser/)
  })

  it('tells the owner an old-format .xls is a spreadsheet, just an older one', () => {
    const error = refusal(() => readXlsxGrid(Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0, 1, 2, 3])))
    expect(error.message).toMatch(/older Excel format/)
    expect(error.message).not.toMatch(/not an Excel spreadsheet/)
  })

  it('checks the size ceiling before it unzips', () => {
    // A buffer of zeros is not a zip, so reaching any later stage would raise 'not-a-spreadsheet'. Getting
    // 'too-large' proves the length check came first.
    const error = refusal(() => readXlsxGrid(new Uint8Array(MAX_FILE_BYTES + 1)))
    expect(error.code).toBe('too-large')
    expect(error.message).toMatch(/50 MB/)
  })

  it('refuses a zip bomb by its declared size, without inflating it', () => {
    const bomb = zipSync({ 'xl/worksheets/sheet1.xml': new Uint8Array(MAX_PART_BYTES + 1) })
    expect(bomb.length).toBeLessThan(MAX_FILE_BYTES) // it passes the input ceiling: that is what makes it a bomb
    expect(refusal(() => readXlsxGrid(bomb)).code).toBe('too-large')
  })

  it('does not inflate parts it never reads', () => {
    const archive = zipSync({
      'xl/worksheets/sheet1.xml': strToU8(sheetWithCell),
      'docProps/junk.bin': new Uint8Array(MAX_PART_BYTES + 1),
    })
    expect(readXlsxGrid(archive)).toEqual([['x']])
  })

  it('reads only the declared size when a header understates it, which then fails as unreadable', () => {
    // Observed against fflate 0.8.3 (not recalled): a part header claiming fewer bytes than the data inflates to
    // does not over-allocate and does not throw. fflate allocates exactly the declared size and silently stops
    // there. So the declared size really is a hard bound on memory, which is what the size guard relies on, and
    // the result is a truncated sheet. Claiming 10 bytes cuts the XML mid-element, so the parse fails.
    const real = zipSync({ 'xl/worksheets/sheet1.xml': strToU8(sheetOf('<row r="1"/>').padEnd(5000, ' ')) })
    const dv = new DataView(real.buffer, real.byteOffset, real.byteLength)
    let cd = -1
    for (let i = 0; i < real.length - 4; i++) if (dv.getUint32(i, true) === 0x02014b50) cd = i
    dv.setUint32(cd + 24, 10, true) // the central directory claims 10 bytes
    expect(unzipSync(real)['xl/worksheets/sheet1.xml']).toHaveLength(10) // the observation itself
    expect(refusal(() => readXlsxGrid(real)).code).toBe('unreadable')
  })

  it('bounds the padded grid by rows x columns, not by each axis alone', () => {
    // 100 rows, each with one cell in the last column (XFD). Each axis is within its own cap and the XML is tiny,
    // but padding would build 100 x 16,384 strings.
    const rows = Array.from({ length: 100 }, (_, i) => `<row r="${i + 1}">${inline(`XFD${i + 1}`, 'x')}</row>`).join('')
    const bomb = zipParts(workbookParts(sheetOf(rows)))
    expect(100 * 16_384).toBeGreaterThan(MAX_GRID_CELLS)
    expect(refusal(() => readXlsxGrid(bomb)).code).toBe('too-large')
  })
})

describe('malformed archives settle rather than hang', () => {
  // ORDER MATTERS. This test must stay above the direct call below: if fflate ever regresses to a looping reader,
  // the direct call freezes the thread and no later test can report anything. The worker reports 'hung' instead.
  it('terminates on that archive in a worker, so a regression fails instead of freezing the suite', async () => {
    // A synchronous loop cannot be interrupted from the thread it runs on. Run the same archive through the
    // installed fflate in a worker with a hard kill timer: if fflate ever loops again, terminate() fires and this
    // assertion fails in five seconds rather than stalling CI.
    const fflatePath = createRequire(import.meta.url).resolve('fflate')
    const archive = buildZip64WithoutExtraField()
    const outcome = await new Promise<string>((resolve) => {
      const worker = new Worker(
        `const { workerData, parentPort } = require('node:worker_threads')
         try { require(workerData.path).unzipSync(workerData.bytes); parentPort.postMessage('returned') }
         catch (e) { parentPort.postMessage('threw') }`,
        { eval: true, workerData: { path: fflatePath, bytes: archive } },
      )
      const timer = setTimeout(() => {
        void worker.terminate()
        resolve('hung')
      }, 5000)
      worker.once('message', (message: string) => {
        clearTimeout(timer)
        void worker.terminate()
        resolve(message)
      })
      worker.once('error', () => {
        clearTimeout(timer)
        resolve('threw')
      })
    })
    expect(outcome).toBe('threw')
  }, 15000)

  it('turns a ZIP64 archive with no ZIP64 extra field into corrupt-archive', () => {
    // fflate 0.8.2 spun forever on this exact archive; 0.8.3 rejects it. It must come back as an ImportError.
    expect(refusal(() => readXlsxGrid(buildZip64WithoutExtraField())).code).toBe('corrupt-archive')
  })

  it.each([
    ['random bytes behind a PK header', () => Uint8Array.from([0x50, 0x4b, 0x03, 0x04, ...Array.from({ length: 300 }, (_, i) => (i * 37) % 251)])],
    ['an archive with its end chopped off', () => buildXlsx(FIXTURE_HEADER_ROWS, FIXTURE_DATA_ROWS).slice(0, -30)],
    [
      'an archive with a flipped byte mid-way',
      () => {
        const copy = buildXlsx(FIXTURE_HEADER_ROWS, FIXTURE_DATA_ROWS).slice()
        const at = Math.floor(copy.length / 2)
        copy[at] = (copy[at] ?? 0) ^ 0xff
        return copy
      },
    ],
  ])('refuses %s as an ImportError', (_label, make) => {
    expect(['corrupt-archive', 'unreadable', 'not-a-spreadsheet']).toContain(refusal(() => readXlsxGrid(make())).code)
  })
})
