import { unzipSync } from 'fflate'
import { detectFormat, ImportError, type ImportErrorCode } from './detect'

/**
 * XLSX container to a raw cell grid. This is the first code to touch a file the owner dropped into the page, so
 * it holds three promises: it terminates, it throws only ImportError (every fflate and DOMParser call is
 * contained), and it decides by content, never by name.
 */

/** The largest file accepted, checked before a single byte is decompressed. */
export const MAX_FILE_BYTES = 50 * 1024 * 1024
/** The largest a single part may inflate to, from its declared size, before inflating. A real sheet is kilobytes; even three years of rows is a few MiB. Held tight because an out-of-memory tab cannot be caught. */
export const MAX_PART_BYTES = 8 * 1024 * 1024
const MAX_ROWS = 200_000
const MAX_COLUMNS = 16_384 // Excel's own limit (column XFD)
/** Rows times columns of the padded grid. Two per-axis caps do not bound their product; this does. Real exports are about 7 columns by 10,000 rows. */
export const MAX_GRID_CELLS = 1_000_000

/** D0 CF 11 E0: the legacy binary Excel container (BIFF). A real spreadsheet, just not one we read. */
const startsWithOle2 = (bytes: Uint8Array): boolean =>
  bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0

const SHEET_PATH = 'xl/worksheets/sheet1.xml'
const SHARED_STRINGS_PATH = 'xl/sharedStrings.xml'

/** Shared with the import screen, which checks the size before reading the file, so the two cannot drift. */
export const TOO_LARGE_MESSAGE =
  'This file is larger than 50 MB, far bigger than any ING movements export, so it is probably not the right one. Choose the spreadsheet you downloaded from ING.'

const MESSAGES = {
  empty:
    'This file is empty, so there is nothing to import. Export your movements from ING again and choose the new file.',
  tooLarge: TOO_LARGE_MESSAGE,
  partTooLarge:
    'This spreadsheet unpacks to an unreasonable size, far bigger than any ING movements export, so it was not opened. Choose the spreadsheet you downloaded from ING.',
  corrupt:
    'This file looks damaged or incomplete, perhaps because the download stopped part-way. Download your movements from ING again and choose the new file.',
  notSpreadsheet:
    'This file is not an Excel spreadsheet, so it cannot be an ING movements export. Choose the .xlsx file you downloaded from ING.',
  noSheet:
    'This is a compressed file, but it does not contain a spreadsheet of movements. Choose the Excel file you downloaded from ING, not a folder or archive.',
  legacyXls:
    'This is an older Excel format (.xls), which cannot be imported. The export ING produces is the newer format, so download your movements from ING again and choose that file.',
  unsupported:
    'This PDF or CSV file is not one the app reads. For bank movements, export them from ING as an Excel spreadsheet and choose that file. The one CSV it does read is a Trading 212 history file.',
  unreadable:
    'The spreadsheet could be opened, but its contents could not be read. It may have been changed after ING exported it. Download your movements from ING again and choose the new file.',
  tooManyRows:
    'This spreadsheet has far more rows than any ING movements export, so it was not opened. Choose the spreadsheet you downloaded from ING.',
} as const

const refuse: (code: ImportErrorCode, message: string) => never = (code, message) => {
  throw new ImportError(code, message)
}

/** Runs one step of the read, turning any failure that is not already an ImportError into `onFail`. */
const contained = <T>(step: () => T, onFail: () => ImportError): T => {
  try {
    return step()
  } catch (error) {
    if (error instanceof ImportError) throw error
    throw onFail()
  }
}

const unzipNeeded = (bytes: Uint8Array): Record<string, Uint8Array> =>
  unzipSync(bytes, {
    // Only the two parts we read are ever inflated, and only if they declare a sane size. A zip bomb is harmless
    // as long as nothing decompresses it.
    filter: ({ name, originalSize }) => {
      if (name !== SHEET_PATH && name !== SHARED_STRINGS_PATH) return false
      if (originalSize > MAX_PART_BYTES) refuse('too-large', MESSAGES.partTooLarge)
      return true
    },
  })

const parseXml = (bytes: Uint8Array): Document => {
  const text = contained(
    () => new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    () => new ImportError('unreadable', MESSAGES.unreadable),
  )
  // Entity declarations are how XML expands a few bytes into gigabytes. A spreadsheet never needs one.
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) refuse('unreadable', MESSAGES.unreadable)
  return contained(
    () => {
      const doc = new DOMParser().parseFromString(text, 'application/xml')
      if (doc.getElementsByTagName('parsererror').length > 0) refuse('unreadable', MESSAGES.unreadable)
      return doc
    },
    () => new ImportError('unreadable', MESSAGES.unreadable),
  )
}

const children = (parent: Element, name: string): Element[] =>
  Array.from(parent.children).filter((child) => child.localName === name)

/** Text of a string item: its own `<t>`, or the `<t>` of each run `<r>`. Phonetic hints (`<rPh>`) are not text. */
const itemText = (item: Element): string => {
  const parts = [...children(item, 't'), ...children(item, 'r').flatMap((run) => children(run, 't'))]
  return parts.map((part) => part.textContent ?? '').join('')
}

const readSharedStrings = (bytes: Uint8Array | undefined): string[] => {
  if (!bytes) return []
  const root = parseXml(bytes).documentElement
  if (root.localName !== 'sst') refuse('unreadable', MESSAGES.unreadable)
  return children(root, 'si').map(itemText)
}

const columnIndex = (letters: string): number => {
  let index = 0
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64)
  return index - 1
}

const readSheet = (bytes: Uint8Array, shared: readonly string[]): string[][] => {
  const root = parseXml(bytes).documentElement
  if (root.localName !== 'worksheet') refuse('not-a-spreadsheet', MESSAGES.noSheet)
  const sheetData = children(root, 'sheetData')[0]
  const grid: string[][] = []
  let width = 1
  let rowNumber = 0
  for (const row of sheetData ? children(sheetData, 'row') : []) {
    const declared = Number(row.getAttribute('r'))
    rowNumber = Number.isInteger(declared) && declared > 0 ? declared : rowNumber + 1
    if (rowNumber > MAX_ROWS) refuse('too-large', MESSAGES.tooManyRows)
    if (rowNumber * width > MAX_GRID_CELLS) refuse('too-large', MESSAGES.tooManyRows)
    const cells = (grid[rowNumber - 1] ??= [])
    let column = -1
    for (const cell of children(row, 'c')) {
      const ref = /^([A-Z]{1,3})\d*$/.exec(cell.getAttribute('r') ?? '')
      column = ref?.[1] ? columnIndex(ref[1]) : column + 1
      if (column >= MAX_COLUMNS) refuse('unreadable', MESSAGES.unreadable)
      width = Math.max(width, column + 1)
      if (grid.length * width > MAX_GRID_CELLS) refuse('too-large', MESSAGES.tooManyRows)
      const type = cell.getAttribute('t')
      let text: string
      if (type === 'inlineStr') {
        const inline = children(cell, 'is')[0]
        text = inline ? itemText(inline) : ''
      } else {
        text = children(cell, 'v')[0]?.textContent ?? ''
        if (type === 's') {
          const resolved = /^\d+$/.test(text) ? shared[Number(text)] : undefined
          if (resolved === undefined) refuse('unreadable', MESSAGES.unreadable)
          text = resolved
        }
      }
      while (cells.length < column) cells.push('')
      cells[column] = text
    }
  }
  // Make the contract literally true: every row is a real array exactly `width` strings long, so `row[6]` is a
  // string even where a row ended early or never existed.
  for (let r = 0; r < grid.length; r++) {
    const row = (grid[r] ??= [])
    while (row.length < width) row.push('')
  }
  if (grid.length === 0 || grid.every((row) => row.every((cell) => cell === ''))) refuse('empty', MESSAGES.empty)
  return grid
}

/**
 * Row-major cell text exactly as written in the file, blanks as `''`. Rows 1-3 (the header block) and row 4
 * (the column titles) are included untouched; interpreting them is the next layer's job.
 */
export const readXlsxGrid = (bytes: Uint8Array): string[][] => {
  if (bytes.length === 0) refuse('empty', MESSAGES.empty)
  if (bytes.length > MAX_FILE_BYTES) refuse('too-large', MESSAGES.tooLarge)
  const format = detectFormat(bytes)
  if (format === 'pdf' || format === 'csv') refuse('unsupported-format', MESSAGES.unsupported)
  if (startsWithOle2(bytes)) refuse('unsupported-format', MESSAGES.legacyXls)
  if (format !== 'xlsx') refuse('not-a-spreadsheet', MESSAGES.notSpreadsheet)

  const parts = contained(
    () => unzipNeeded(bytes),
    () => new ImportError('corrupt-archive', MESSAGES.corrupt),
  )
  const sheet = parts[SHEET_PATH]
  if (!sheet) refuse('not-a-spreadsheet', MESSAGES.noSheet)
  return contained(
    () => readSheet(sheet, readSharedStrings(parts[SHARED_STRINGS_PATH])),
    () => new ImportError('unreadable', MESSAGES.unreadable),
  )
}
