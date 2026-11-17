import { strToU8, zipSync } from 'fflate'

/**
 * Synthesised XLSX bytes for tests (design 34.7). `.gitignore` excludes every spreadsheet extension and CI runs on
 * a clean checkout, so a committed binary would be silently absent there. Everything below is invented: the account
 * number, the holder and the amounts. Only the ING category strings are real, and those are public taxonomy.
 */

/** Text, a number, or `{ raw }`: numeric text written verbatim (IEEE-754 noise such as -12.449999999999999). */
export type FixtureCell = string | number | { raw: string }

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'

export const FIXTURE_ACCOUNT_NUMBER = 'ES00 0000 0000 00 0000000000'
export const FIXTURE_HOLDER = 'TITULAR DE PRUEBA'

/** Rows 1-3 (account number, holder, export timestamp) and the row-4 column titles, as ING lays them out. */
export const FIXTURE_HEADER_ROWS: FixtureCell[][] = [
  ['Número de cuenta', FIXTURE_ACCOUNT_NUMBER],
  ['Titular', FIXTURE_HOLDER],
  ['Fecha exportación', '15/11/2026 13:18:54'],
  ['F. VALOR', 'CATEGORÍA', 'SUBCATEGORÍA', 'DESCRIPCIÓN', 'COMENTARIO', 'IMPORTE (€)', 'SALDO (€)'],
]

/** Serial dates and IEEE-754 noise exactly as the real export writes them. Newest row first. */
export const FIXTURE_DATA_ROWS: FixtureCell[][] = [
  [46341, 'Alimentación', 'Supermercados', 'Compra EN SUPERMERCADO EJEMPLO, MADRID', '', { raw: '-12.449999999999999' }, 997.55],
  [46341, 'Cafeterías y restaurantes', 'Cafeterías', 'Compra EN CAFETERIA EJEMPLO', '', -3.2, 1010],
  [46340, 'Vehículo y transporte', 'Combustible', 'Compra EN GASOLINERA EJEMPLO', 'nota', -40, 1013.2],
]

const columnName = (index: number): string => {
  let name = ''
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name
  return name
}

const escapeXml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Raw ZIP from named text parts, for building both well-formed and deliberately broken workbooks. */
export const zipParts = (parts: Record<string, string>): Uint8Array => {
  const files: Record<string, Uint8Array> = {}
  for (const [name, text] of Object.entries(parts)) files[name] = strToU8(text)
  return zipSync(files)
}

/** Minimal valid workbook parts around the given sheet and shared-strings XML. */
export const workbookParts = (sheetXml: string, sharedStringsXml?: string): Record<string, string> => ({
  '[Content_Types].xml': `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`,
  'xl/workbook.xml': `${XML_HEAD}<workbook ${NS}><sheets><sheet name="Movimientos" sheetId="1" r:id="rId1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></sheets></workbook>`,
  'xl/worksheets/sheet1.xml': sheetXml,
  ...(sharedStringsXml === undefined ? {} : { 'xl/sharedStrings.xml': sharedStringsXml }),
})

/**
 * Builds an XLSX the way ING does: strings through `xl/sharedStrings.xml` (`t="s"`), numbers as bare `<v>`.
 * `headerRows` is everything above the data, titles row included. An empty string is a blank cell: it is omitted
 * from the XML entirely, as Excel does, so its column is skipped through the `r` reference.
 */
export const buildXlsx = (headerRows: FixtureCell[][], dataRows: FixtureCell[][]): Uint8Array => {
  const strings: string[] = []
  const indexOf = new Map<string, number>()
  const rowsXml = [...headerRows, ...dataRows]
    .map((row, r) => {
      const cells = row
        .map((value, c) => {
          if (value === '') return ''
          const ref = `${columnName(c)}${r + 1}`
          if (typeof value === 'number') return `<c r="${ref}"><v>${value}</v></c>`
          if (typeof value === 'object') return `<c r="${ref}"><v>${value.raw}</v></c>`
          let index = indexOf.get(value)
          if (index === undefined) {
            index = strings.length
            strings.push(value)
            indexOf.set(value, index)
          }
          return `<c r="${ref}" t="s"><v>${index}</v></c>`
        })
        .join('')
      return `<row r="${r + 1}">${cells}</row>`
    })
    .join('')
  const sheet = `${XML_HEAD}<worksheet ${NS}><sheetData>${rowsXml}</sheetData></worksheet>`
  const shared = `${XML_HEAD}<sst ${NS} count="${strings.length}" uniqueCount="${strings.length}">${strings
    .map((s) => `<si><t xml:space="preserve">${escapeXml(s)}</t></si>`)
    .join('')}</sst>`
  return zipParts(workbookParts(sheet, shared))
}
