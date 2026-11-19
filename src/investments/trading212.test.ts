import { describe, expect, it } from 'vitest'
import { Trading212Error, decimalToInt, formatShares, parseTrading212, splitCsvLine, summarise } from './trading212'

// Every row here is invented: made-up companies, tickers, ids and amounts.
const HEAD = 'Action,Time (UTC),ISIN,Ticker,Name,Notes,ID,No. of shares,Price / share,Currency (Price / share),Exchange rate,Result,Currency (Result),Gross Total,Currency (Gross Total),Withholding tax,Currency (Withholding tax),Currency conversion fee,Currency (Currency conversion fee),Record Date'
const row = (o: Partial<Record<string, string>>): string =>
  [o.action ?? 'Market buy', o.time ?? '2026-01-05 10:00:00+00:00', o.isin ?? 'XX0000000001', o.ticker ?? 'EJEM', `"${o.name ?? 'Empresa Ejemplo, S.A.'}"`, o.notes ?? '', o.id ?? '',
    o.shares ?? '', o.price ?? '', o.priceCur ?? '', o.rate ?? '', o.result ?? '', o.result ? '"EUR"' : '', o.total ?? '0.00', `"${o.cur ?? 'EUR'}"`, '', '', o.fee ?? '', o.fee ? '"EUR"' : '', ''].join(',')
const file = (...rows: string[]) => [HEAD, ...rows].join('\n')

describe('reading the file', () => {
  it('splits a line on commas, keeping a quoted cell with a comma or a doubled quote whole', () => {
    expect(splitCsvLine('a,"b, c",,"d ""e""",f')).toEqual(['a', 'b, c', '', 'd "e"', 'f'])
  })

  it('reads a decimal from its digits, with no fraction arithmetic', () => {
    expect(decimalToInt('50.00', 2)).toBe(5000)
    expect(decimalToInt('-0.26', 2)).toBe(-26)
    expect(decimalToInt('1008', 2)).toBe(100800)
    expect(decimalToInt('0.005', 2)).toBe(1)
    expect(decimalToInt('0.004', 2)).toBe(0)
    expect(decimalToInt('8.8207712600', 10)).toBe(88207712600)
    expect(decimalToInt('589.7324424000', 10)).toBe(5897324424000)
    expect(decimalToInt('8.82077126', 10)).toBe(88207712600)
    for (const bad of ['', 'abc', '1,5', '1e5', '.5', '--1']) expect(decimalToInt(bad, 2)).toBeNull()
  })

  it('turns each row into an event, with the day, the total in cents and the shares as an integer', () => {
    const events = parseTrading212(file(
      row({ action: 'Deposit', id: 'dep-1', total: '300.00', isin: '', ticker: '', name: '', notes: '"Bank Transfer"' }),
      row({ id: 'B1', shares: '8.8207712600', total: '50.00', fee: '0.08' }),
      row({ action: 'Market sell', id: 'S1', shares: '0.8913159600', total: '25.00', result: '4.26', fee: '0.04', time: '2026-02-07 15:03:52+00:00' }),
    ))
    expect(events.map((e) => e.kind)).toEqual(['deposit', 'buy', 'sell'])
    expect(events[0]).toMatchObject({ id: 'dep-1', date: '2026-01-05', totalCents: 30000, sharesE10: 0, isin: null, ticker: null, name: null, resultCents: null, feeCents: 0 })
    expect(events[1]).toMatchObject({ id: 'B1', sharesE10: 88207712600, totalCents: 5000, feeCents: 8, name: 'Empresa Ejemplo, S.A.', currency: 'EUR' })
    expect(events[2]).toMatchObject({ date: '2026-02-07', resultCents: 426, feeCents: 4 })
  })

  it('names every kind of row it knows, and keeps one it does not as "other"', () => {
    const kinds = (action: string) => parseTrading212(file(row({ action, id: 'x' })))[0]?.kind
    expect(kinds('Limit buy')).toBe('buy')
    expect(kinds('Stop sell')).toBe('sell')
    expect(kinds('Dividend (Dividend)')).toBe('dividend')
    expect(kinds('Interest on cash')).toBe('interest')
    expect(kinds('ADR Fee')).toBe('fee')
    expect(kinds('Withdrawal')).toBe('withdrawal')
    expect(kinds('Stock split close')).toBe('split-close')
    expect(kinds('Stock split open')).toBe('split-open')
    expect(kinds('Something new')).toBe('other')
  })

  it('gives a row with no id one from its content, and keeps two identical rows apart', () => {
    const d = row({ action: 'Dividend (Dividend)', total: '0.32' })
    const events = parseTrading212(file(d, d))
    expect(events[0]?.id).toBe('Dividend (Dividend)|2026-01-05 10:00:00+00:00|XX0000000001|0.32')
    expect(events[1]?.id).toBe(`${events[0]?.id}#2`)
    // The same file read again gives the same ids, which is what lets a second upload be recognised.
    expect(parseTrading212(file(d, d)).map((e) => e.id)).toEqual(events.map((e) => e.id))
  })

  it('refuses a file that is not this export, and a row it cannot read, with a sentence and without importing part of it', () => {
    expect(() => parseTrading212('F. VALOR,CATEGORIA\n1,2')).toThrow(Trading212Error)
    expect(() => parseTrading212('F. VALOR,CATEGORIA\n1,2')).toThrow(/does not look like a Trading 212 history file/)
    expect(() => parseTrading212(file(row({ id: 'ok', total: '1.00' }), row({ id: 'bad', total: 'x' })))).toThrow(/Row 3 of the file could not be read/)
    expect(() => parseTrading212(file(row({ id: 'bad', time: 'yesterday' })))).toThrow(/Row 2/)
    expect(parseTrading212(HEAD)).toEqual([])
  })

  it('ignores a byte-order mark and Windows line endings', () => {
    expect(parseTrading212(`﻿${file(row({ id: 'B1', total: '1.00' })).replace(/\n/g, '\r\n')}`)).toHaveLength(1)
  })
})

describe('summing it up', () => {
  const events = () => parseTrading212(file(
    row({ action: 'Deposit', id: 'd1', total: '300.00', isin: '', ticker: '', name: '' }),
    row({ id: 'b1', shares: '10.0000000000', total: '100.00', fee: '0.15' }),
    row({ id: 'b2', shares: '10.0000000000', total: '120.00', fee: '0.15', time: '2026-01-06 10:00:00+00:00' }),
    row({ id: 'b3', shares: '2.0000000000', total: '50.00', isin: 'XX0000000002', ticker: 'OTRA', name: 'Otra Empresa', time: '2026-01-07 10:00:00+00:00' }),
    // Half sold for 130,00 with a printed result of +20,00: the half sold had cost 110,00.
    row({ action: 'Market sell', id: 's1', shares: '10.0000000000', total: '130.00', result: '20.00', fee: '0.20', time: '2026-02-01 10:00:00+00:00' }),
    row({ action: 'Dividend (Dividend)', total: '0.32', time: '2026-02-10 10:00:00+00:00' }),
    row({ action: 'ADR Fee', total: '-0.26', cur: 'USD', time: '2026-02-11 10:00:00+00:00' }),
    row({ action: 'Withdrawal', id: 'w1', total: '-40.00', isin: '', ticker: '', name: '', time: '2026-02-12 10:00:00+00:00' }),
  ))

  it('works out what was paid in, what the holdings left cost, the result on sales, income and fees', () => {
    const s = summarise(events())
    expect(s.depositedCents).toBe(26000)
    expect(s.realisedCents).toBe(2000)
    expect(s.incomeCents).toBe(32)
    expect(s.feesCents).toBe(50)
    expect(s.holdings).toEqual([
      { isin: 'XX0000000001', ticker: 'EJEM', name: 'Empresa Ejemplo, S.A.', sharesE10: 100000000000, costCents: 11000 },
      { isin: 'XX0000000002', ticker: 'OTRA', name: 'Otra Empresa', sharesE10: 20000000000, costCents: 5000 },
    ])
    expect(s.investedCents).toBe(16000)
    expect(s.firstDate).toBe('2026-01-05')
    expect(s.lastDate).toBe('2026-02-12')
  })

  it('counts a row in another currency nowhere and lists it, so nothing is hidden or mixed into euros', () => {
    const s = summarise(events())
    expect(s.otherCurrency).toEqual([{ action: 'ADR Fee', date: '2026-02-11', totalCents: -26, currency: 'USD' }])
  })

  it('takes a holding sold in full off the list, and gives the same answer whatever order the rows come in', () => {
    const all = [...events(), ...parseTrading212(file(row({ action: 'Market sell', id: 's2', shares: '10.0000000000', total: '90.00', result: '-20.00', time: '2026-03-01 10:00:00+00:00' })))]
    const s = summarise(all)
    expect(s.holdings.map((h) => h.ticker)).toEqual(['OTRA'])
    expect(s.realisedCents).toBe(0)
    expect(summarise([...all].reverse())).toEqual(s)
  })

  it('a split swaps the number of shares and leaves the cost as it was', () => {
    const s = summarise(parseTrading212(file(
      row({ id: 'b1', shares: '88.5769552000', total: '50.00' }),
      row({ action: 'Stock split close', id: 'c1', shares: '88.5769552000', total: '49.92', result: '0.00', time: '2026-02-01 07:13:05+00:00' }),
      row({ action: 'Stock split open', id: 'o1', shares: '8.8576955200', total: '49.92', time: '2026-02-01 07:13:05+00:00' }),
    )))
    expect(s.holdings).toEqual([{ isin: 'XX0000000001', ticker: 'EJEM', name: 'Empresa Ejemplo, S.A.', sharesE10: 88576955200, costCents: 5000 }])
  })

  it('counts a row of a kind it does not know nowhere, and says how many there were', () => {
    expect(summarise(parseTrading212(file(row({ action: 'Something new', id: 'n1', total: '9.00' })))).unknown).toBe(1)
  })

  it('writes shares with up to four decimals, built from the integer', () => {
    expect(formatShares(88207712600)).toBe('8,8207')
    expect(formatShares(100000000000)).toBe('10')
    expect(formatShares(5000000000)).toBe('0,5')
    expect(formatShares(0)).toBe('0')
  })
})
