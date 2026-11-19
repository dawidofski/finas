/**
 * Reads a Trading 212 history export (CSV) and sums it up. Pure: no database, no clock, no network. Money is integer
 * cents and share counts are integers of ten-billionths of a share, both read from the file's decimal TEXT digit by
 * digit, so nothing here is ever a floating-point number.
 *
 * What this can and cannot say: it knows what was paid in, what was bought and sold and at what total, the result the
 * broker itself printed on each sale, dividends and fees. It does NOT know what the holdings are worth today: the file
 * has no current prices and this application fetches none.
 */

export type InvestmentKind = 'deposit' | 'withdrawal' | 'buy' | 'sell' | 'dividend' | 'fee' | 'interest' | 'split-close' | 'split-open' | 'other'

export interface InvestmentEvent {
  /** The broker's own id for the row, or one derived from the row's content when the file gives none. */
  id: string
  kind: InvestmentKind
  /** The action exactly as the file names it, kept for a kind this reader does not know. */
  action: string
  /** UTC day, 'YYYY-MM-DD'. */
  date: string
  isin: string | null
  ticker: string | null
  name: string | null
  /** Shares in ten-billionths (the file gives ten decimals); 0 where the row has none. */
  sharesE10: number
  /** The row's total as the file gives it, in `currency`. Positive magnitudes for buys and sells; a fee is negative. */
  totalCents: number
  currency: string
  /** The broker's realised result on a sale, in euros; null where the row has none. */
  resultCents: number | null
  /** Currency conversion fee in euros; 0 where none. */
  feeCents: number
}

export class Trading212Error extends Error {}

const REQUIRED = ['Action', 'Time (UTC)', 'ISIN', 'Ticker', 'Name', 'ID', 'No. of shares', 'Result', 'Gross Total', 'Currency (Gross Total)'] as const

/** One CSV line into cells: commas separate, double quotes wrap a cell that may hold commas, a doubled quote is a quote. */
export function splitCsvLine(line: string): string[] {
  const cells: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line.charAt(i)
    if (quoted) {
      if (ch === '"' && line.charAt(i + 1) === '"') { cell += '"'; i++ }
      else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') { cells.push(cell); cell = '' }
    else cell += ch
  }
  cells.push(cell)
  return cells
}

/**
 * A decimal written as text ("-12.345") as an integer with `places` decimals, rounding half away from zero on the first
 * digit past them. Null for anything that is not a plain decimal. Digits only: no number is parsed as a fraction.
 */
export function decimalToInt(text: string, places: number): number | null {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text.trim())
  if (!m) return null
  const whole = m[2] ?? '0'
  const frac = m[3] ?? ''
  const kept = frac.slice(0, places).padEnd(places, '0')
  let value = Number(whole + kept)
  if (frac.length > places && Number(frac.charAt(places)) >= 5) value += 1
  if (!Number.isSafeInteger(value)) return null
  return m[1] === '-' && value !== 0 ? -value : value
}

function kindOf(action: string): InvestmentKind {
  const a = action.trim().toLowerCase()
  if (a === 'deposit') return 'deposit'
  if (a === 'withdrawal' || a === 'withdraw') return 'withdrawal'
  if (a === 'stock split close') return 'split-close'
  if (a === 'stock split open') return 'split-open'
  if (a.endsWith(' buy')) return 'buy'
  if (a.endsWith(' sell')) return 'sell'
  if (a.startsWith('dividend')) return 'dividend'
  if (a.startsWith('interest')) return 'interest'
  if (a.includes('fee') || a.includes('tax')) return 'fee'
  return 'other'
}

/**
 * Every row of the export as an event. Refuses a file that is not this export (the heading row is checked by name, so a
 * bank statement or another broker's file is turned away with a sentence, not half-read), and refuses a row whose date or
 * total cannot be read rather than skipping it silently.
 */
export function parseTrading212(text: string): InvestmentEvent[] {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim() !== '')
  const head = splitCsvLine(lines[0] ?? '').map((h) => h.trim())
  const missing = REQUIRED.filter((r) => !head.includes(r))
  if (missing.length > 0) throw new Trading212Error('This does not look like a Trading 212 history file: its first line does not have the headings that export has. Nothing was changed.')
  const at = (cells: string[], name: string): string => (cells[head.indexOf(name)] ?? '').trim()

  const events: InvestmentEvent[] = []
  const seen = new Map<string, number>()
  lines.slice(1).forEach((line, i) => {
    const cells = splitCsvLine(line)
    const action = at(cells, 'Action')
    const date = /^(\d{4}-\d{2}-\d{2})[ T]/.exec(at(cells, 'Time (UTC)'))?.[1]
    const total = decimalToInt(at(cells, 'Gross Total'), 2)
    if (action === '' || date === undefined || total === null) {
      throw new Trading212Error(`Row ${i + 2} of the file could not be read (its action, date or total is missing), so the file was not imported. Nothing was changed.`)
    }
    const sharesText = at(cells, 'No. of shares')
    const shares = sharesText === '' ? 0 : decimalToInt(sharesText, 10)
    const resultText = at(cells, 'Result')
    const feeText = head.includes('Currency conversion fee') ? at(cells, 'Currency conversion fee') : ''
    if (shares === null) throw new Trading212Error(`Row ${i + 2} of the file has a number of shares that could not be read, so the file was not imported. Nothing was changed.`)
    const isin = at(cells, 'ISIN')
    // A row with no id of its own (a dividend, a fee) is identified by what it says; a counter keeps two identical rows apart.
    const own = at(cells, 'ID')
    const base = own !== '' ? own : `${action}|${at(cells, 'Time (UTC)')}|${isin}|${at(cells, 'Gross Total')}`
    const count = (seen.get(base) ?? 0) + 1
    seen.set(base, count)
    events.push({
      id: count === 1 ? base : `${base}#${count}`,
      kind: kindOf(action),
      action,
      date,
      isin: isin === '' ? null : isin,
      ticker: at(cells, 'Ticker') || null,
      name: at(cells, 'Name') || null,
      sharesE10: shares,
      totalCents: total,
      currency: at(cells, 'Currency (Gross Total)') || 'EUR',
      resultCents: resultText === '' ? null : decimalToInt(resultText, 2),
      feeCents: feeText === '' ? 0 : decimalToInt(feeText, 2) ?? 0,
    })
  })
  return events
}

export interface Holding {
  isin: string
  ticker: string | null
  name: string | null
  /** Shares still held, in ten-billionths. */
  sharesE10: number
  /** What the shares still held cost, in euro cents: what was paid for them, less the cost of what was sold. */
  costCents: number
}

export interface InvestmentSummary {
  /** Paid in less paid out, euros. */
  depositedCents: number
  /** What the holdings still held cost, euros. NOT what they are worth today. */
  investedCents: number
  /** The sum of the results the broker printed on sales, euros. */
  realisedCents: number
  /** Dividends and interest received, euros. */
  incomeCents: number
  /** Conversion fees and other fees charged in euros (a positive number is a cost). */
  feesCents: number
  /** Holdings with shares left, largest cost first. */
  holdings: Holding[]
  /** Rows whose total is not in euros (for example a fee charged in dollars): counted nowhere above, listed so nothing is hidden. */
  otherCurrency: Array<{ action: string; date: string; totalCents: number; currency: string }>
  /** Rows of a kind this reader does not know: counted nowhere above. */
  unknown: number
  firstDate: string | null
  lastDate: string | null
}

/**
 * Sums the events up. A holding's cost is what was paid for it less the cost of what was sold, where the cost of a sale
 * is its proceeds less the result the broker printed for it (the broker's own figure, so the two always agree). A split
 * swaps the share count and leaves the cost as it was. Events are taken in date order; within a day in the order given.
 */
export function summarise(events: readonly InvestmentEvent[]): InvestmentSummary {
  const ordered = events.map((e, i) => ({ e, i })).sort((a, b) => (a.e.date < b.e.date ? -1 : a.e.date > b.e.date ? 1 : a.i - b.i)).map((x) => x.e)
  const byIsin = new Map<string, Holding>()
  const s: InvestmentSummary = {
    depositedCents: 0, investedCents: 0, realisedCents: 0, incomeCents: 0, feesCents: 0, holdings: [], otherCurrency: [], unknown: 0,
    firstDate: ordered[0]?.date ?? null, lastDate: ordered[ordered.length - 1]?.date ?? null,
  }
  for (const e of ordered) {
    s.feesCents += e.feeCents
    if (e.currency !== 'EUR') { s.otherCurrency.push({ action: e.action, date: e.date, totalCents: e.totalCents, currency: e.currency }); continue }
    const held = (): Holding => {
      const key = e.isin ?? e.ticker ?? e.name ?? '?'
      let h = byIsin.get(key)
      if (!h) { h = { isin: key, ticker: e.ticker, name: e.name, sharesE10: 0, costCents: 0 }; byIsin.set(key, h) }
      return h
    }
    switch (e.kind) {
      case 'deposit': s.depositedCents += e.totalCents; break
      case 'withdrawal': s.depositedCents -= Math.abs(e.totalCents); break
      case 'buy': { const h = held(); h.sharesE10 += e.sharesE10; h.costCents += e.totalCents; break }
      case 'sell': {
        const h = held()
        const result = e.resultCents ?? 0
        h.sharesE10 -= e.sharesE10
        h.costCents -= e.totalCents - result
        s.realisedCents += result
        break
      }
      case 'split-close': held().sharesE10 -= e.sharesE10; break
      case 'split-open': held().sharesE10 += e.sharesE10; break
      case 'dividend': case 'interest': s.incomeCents += e.totalCents; break
      case 'fee': s.feesCents += Math.abs(e.totalCents); break
      case 'other': s.unknown += 1; break
    }
  }
  // A position sold in full can be left a cent or a sliver of a share out by the broker's own rounding: it is closed, not held.
  s.holdings = [...byIsin.values()].filter((h) => h.sharesE10 > 1000).map((h) => ({ ...h, costCents: Math.max(0, h.costCents) }))
    .sort((a, b) => b.costCents - a.costCents || (a.isin < b.isin ? -1 : 1))
  s.investedCents = s.holdings.reduce((sum, h) => sum + h.costCents, 0)
  return s
}

/** Shares for display: up to four decimals, trailing zeros dropped, built from the integer (no division into a fraction). */
export function formatShares(sharesE10: number): string {
  const sign = sharesE10 < 0 ? '-' : ''
  const digits = String(Math.abs(sharesE10)).padStart(11, '0')
  const whole = digits.slice(0, -10)
  const frac = digits.slice(-10, -6).replace(/0+$/, '')
  return `${sign}${whole}${frac === '' ? '' : `,${frac}`}`
}
