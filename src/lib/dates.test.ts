import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect, beforeAll } from 'vitest'
import { excelSerialToIso, isoToExcelSerial, parseSpanishDate, monthKeyOf, daysBetween, addDays, addMonths, formatSpanishDate, formatMonthTitle, isoWeekday, spanishWeekdayName } from './dates'

// Local hour of 2026-01-01T00:00Z in each zone: UTC+0, UTC+14, UTC-11 (not the 1970 epoch: Kiritimati was UTC-10:40 then).
const EXPECTED_EPOCH_HOUR: Record<string, number> = { 'UTC': 0, 'Pacific/Kiritimati': 14, 'Pacific/Niue': 13 }

describe.each(['UTC', 'Pacific/Kiritimati', 'Pacific/Niue'])('in timezone %s', (tz) => {
  beforeAll(() => { process.env.TZ = tz })
  // Probe only: proves the TZ switch really took effect, so the cases below are not theatre.
  // getHours is a local-timezone method and must never appear in dates.ts itself.
  it('the timezone switch is real', () => expect(new Date(Date.UTC(2026, 0, 1)).getHours()).toBe(EXPECTED_EPOCH_HOUR[tz]))
  it.each([[46341, '2026-11-15'], [46336, '2026-11-10'], [45658, '2025-01-01'], [25569, '1970-01-01']])(
    'serial %i is %s', (s, iso) => expect(excelSerialToIso(s)).toBe(iso))
  it('round-trips every serial in the export range', () => {
    for (let s = 46336; s <= 46341; s++) expect(isoToExcelSerial(excelSerialToIso(s))).toBe(s)
  })
  it('parses the PDF date format', () => expect(parseSpanishDate('15/11/2026')).toBe('2026-11-15'))
})

describe('validation', () => {
  it.each(['2026-11-15', '15-11-2026', '32/01/2026', '15/13/2026', '31/02/2026', ''])(
    'rejects %s', (raw) => expect(() => parseSpanishDate(raw)).toThrow())
  it.each([0, -1, 1.5, NaN])('rejects serial %s', (s) => expect(() => excelSerialToIso(s)).toThrow())
})

describe('helpers', () => {
  it('month key', () => expect(monthKeyOf('2026-11-15')).toBe('2026-11'))
  it('days between', () => expect(daysBetween('2026-11-10', '2026-11-15')).toBe(5))
  it('crosses a month boundary', () => expect(addDays('2026-11-30', 1)).toBe('2026-12-01'))
  it('handles leap days', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29')
    expect(addDays('2028-02-29', 1)).toBe('2028-03-01')
    expect(addDays('2100-02-28', 1)).toBe('2100-03-01')
    expect(parseSpanishDate('29/02/2028')).toBe('2028-02-29')
    expect(() => parseSpanishDate('29/02/2100')).toThrow()
  })
  it('throws on out-of-range results instead of returning garbage', () => {
    expect(() => excelSerialToIso(1e12)).toThrow()
    expect(() => excelSerialToIso(3_000_000)).toThrow() // year > 9999
    expect(excelSerialToIso(2958465)).toBe('9999-12-31') // last supported day
    expect(() => excelSerialToIso(2958466)).toThrow() // 10000-01-01
    expect(() => addDays('2026-11-15', 1e10)).toThrow()
    expect(() => addDays('2026-11-15', 1e300)).toThrow()
    expect(() => addDays('2026-11-15', 3_000_000)).toThrow()
  })
  it('crosses a year boundary', () => expect(addDays('2026-12-31', 1)).toBe('2027-01-01'))
})

describe('formatSpanishDate (display only)', () => {
  it('writes dd/MM/yyyy', () => {
    expect(formatSpanishDate('2026-11-16')).toBe('16/11/2026')
    expect(formatSpanishDate('2026-01-05')).toBe('05/01/2026')
    expect(formatSpanishDate('2024-02-29')).toBe('29/02/2024')
  })
  it('is the exact inverse of parseSpanishDate, so what the owner reads is what they could type', () => {
    for (const iso of ['2026-11-16', '2026-12-31', '2027-01-01', '2024-02-29']) expect(parseSpanishDate(formatSpanishDate(iso))).toBe(iso)
  })
  it('refuses what is not a real calendar date rather than printing it as one', () => {
    for (const bad of ['', '16/11/2026', '2026-1-5', '2026-02-30', '2026-13-01', '2026-11-16T00:00', 'tomorrow']) {
      expect(() => formatSpanishDate(bad)).toThrow()
    }
  })
  it('puts a month key in words, and leaves anything else alone', () => {
    expect(formatMonthTitle('2026-11')).toBe('November 2026')
    expect(formatMonthTitle('2026-13')).toBe('2026-13')
    expect(formatMonthTitle('')).toBe('')
  })
  it('says in the source that it is display-only, above the formatter', () => {
    const src = readFileSync(resolve(import.meta.dirname, 'dates.ts'), 'utf8')
    const marker = src.indexOf('DISPLAY ONLY')
    expect(marker).toBeGreaterThan(src.indexOf('export function epochMsToIso'))
    expect(marker).toBeLessThan(src.indexOf('export function formatSpanishDate'))
  })
})

describe('isoWeekday', () => {
  it('numbers Monday 1 to Sunday 7, across leap days and before the epoch', () => {
    expect(isoWeekday('2026-11-16')).toBe(1)
    expect(isoWeekday('2026-11-22')).toBe(7)
    expect(isoWeekday('1970-01-01')).toBe(4)
    expect(isoWeekday('2024-02-29')).toBe(4)
    expect(isoWeekday('1969-12-31')).toBe(3)
    expect(() => isoWeekday('2026-02-31')).toThrow()
  })
  it('names the weekdays in Spanish', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(spanishWeekdayName)).toEqual(['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'])
  })
})

describe('addMonths', () => {
  it('moves a month forward or back across year ends', () => {
    expect(addMonths('2026-10', 0)).toBe('2026-10')
    expect(addMonths('2026-10', 1)).toBe('2026-11')
    expect(addMonths('2026-10', 3)).toBe('2027-01')
    expect(addMonths('2026-10', 40)).toBe('2030-02')
    expect(addMonths('2026-01', -1)).toBe('2025-12')
    expect(addMonths('2026-01', -13)).toBe('2024-12')
    expect(addMonths('0999-12', 1)).toBe('1000-01')
  })
  it('throws on a malformed month or a count that is not a whole number', () => {
    for (const bad of ['2026-13', '2026-00', '2026-1', '26-10', '2026-10-01', '', 'NaN-NaN']) {
      expect(() => addMonths(bad, 1), bad).toThrow()
    }
    for (const n of [1.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => addMonths('2026-10', n)).toThrow()
  })
})
