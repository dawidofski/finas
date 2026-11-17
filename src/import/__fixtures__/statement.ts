import { isoToExcelSerial } from '../../lib/dates'
import { buildXlsx, type FixtureCell } from './build'

/** Synthesised ING workbooks for the pipeline and screen tests (design 34.7). Every value is invented. */
// Invented in full: a made-up number that is not a valid IBAN, and a made-up holder.
export const NUMBER = 'ES00 1111 2222 33 4444555566'
export const HOLDER = 'PRUEBA ANÓNIMA TESTER'
export const OTHER_NUMBER = 'ES00 9999 8888 77 6666555544'

const TITLES = ['F. VALOR', 'CATEGORÍA', 'SUBCATEGORÍA', 'DESCRIPCIÓN', 'COMENTARIO', 'IMPORTE (€)', 'SALDO (€)']

export interface Move {
  date: string
  cents: number
  cat?: string
  sub?: string
  desc?: string
  comment?: string
}

/** An ING workbook. `moves` are oldest first, as a person thinks of them; the file lists them newest first. */
export function statement(opts: { moves: Move[]; opening: number; number?: string; holder?: string; exported?: string }): Uint8Array {
  let balance = opts.opening
  const data: FixtureCell[][] = opts.moves.map((m) => {
    balance += m.cents
    return [
      isoToExcelSerial(m.date), m.cat ?? 'Compras', m.sub ?? 'Compras (otros)', m.desc ?? 'Compra EN TIENDA INVENTADA',
      m.comment ?? '', m.cents / 100, balance / 100,
    ]
  })
  return buildXlsx(
    [
      ['Número de cuenta', opts.number ?? NUMBER],
      ['Titular', opts.holder ?? HOLDER],
      ['Fecha exportación', opts.exported ?? '15/11/2026 13:18:54'],
      TITLES,
    ],
    data.reverse(),
  )
}

export const BASE: Move[] = [
  { date: '2026-11-10', cents: -1245 },
  { date: '2026-11-11', cents: -320, cat: 'Ocio y viajes', sub: 'Cafeterías y restaurantes', desc: 'Compra EN CAFETERIA EJEMPLO' },
  { date: '2026-11-12', cents: -4000 },
]
