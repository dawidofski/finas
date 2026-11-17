import { describe, it, expect } from 'vitest'
import { parseAmountToCents, parseTypedAmount, centsToTypedString, centsToString, formatEur, sumCents, applyPercentBp, percentBpOf } from './money'

describe('parseAmountToCents', () => {
  it.each([
    ['-0.1', -10], ['-0.95', -95], ['80', 8000], ['-578.9', -57890],
    ['-12.449999999999999', -1245], ['-1.1000000000000001', -110],
    ['648.95000000000005', 64895], ['645.82000000000005', 64582],
    ['100', 10000], ['-0.02', -2], ['0', 0],
    ['0.950', 95], ['1.200', 120], ['10.5000', 1050], ['-0.100', -10],
    ['0.99999999999', 100], ['-0.99999999999', -100],
  ])('parses %s to %i cents', (raw, cents) => {
    expect(parseAmountToCents(raw)).toBe(cents)
  })
  it.each(['1.234', '', 'abc', '1,5', null as unknown as string,
    '1.2300000001', '1.23999999', '1e5', '+1', ' 1', '1.', '.5', '-', '99999999999999999999'])(
    'rejects %s', (raw) => expect(() => parseAmountToCents(raw)).toThrow())
})

describe('parseAmountToCents edge cases', () => {
  it('returns a true zero for -0 (Object.is)', () => expect(parseAmountToCents('-0')).toBe(0))
  it('accepts a nine-zero noise run', () => expect(parseAmountToCents('1.230000000001')).toBe(123))
  it('accepts a nine-nine noise run', () => expect(parseAmountToCents('1.22999999999')).toBe(123))
})

describe('centsToString', () => {
  it.each([[-1245, '-12.45'], [64895, '648.95'], [0, '0.00'], [-2, '-0.02'], [8000, '80.00']])(
    'renders %i as %s', (c, s) => expect(centsToString(c)).toBe(s))
  it('throws on a non-integer input', () => expect(() => centsToString(1.5)).toThrow())
})

describe('formatEur', () => {
  it.each([[-1245, '-12,45 €'], [8000, '80,00 €'], [0, '0,00 €'], [-2, '-0,02 €'], [-0, '0,00 €'], [1234567, '12.345,67 €'], [-123456, '-1.234,56 €'], [185000, '1.850,00 €'], [99999, '999,99 €'], [100000, '1.000,00 €']])(
    'formats %i as %s', (c, s) => expect(formatEur(c)).toBe(s))
})

describe('sumCents', () => {
  it('sums signed cents exactly', () => {
    expect(sumCents([-10, -95, -40, -80, -44])).toBe(-269)
  })
  it('returns 0 for an empty list', () => expect(sumCents([])).toBe(0))
  it('throws on a non-integer input', () => expect(() => sumCents([1.5])).toThrow())
})

describe('applyPercentBp', () => {
  it.each([[200000, 1500, 30000], [240000, 1500, 36000], [100003, 3333, 33331]])(
    '%i cents at %i bp is %i', (c, bp, r) => expect(applyPercentBp(c, bp)).toBe(r))
})

describe('applyPercentBp rounding', () => {
  // The module rounds halves away from zero, deliberately and consistently
  // (also in parseAmountToCents). Math.round would give -2 for the negative tie.
  it('rounds a positive tie up', () => expect(applyPercentBp(5, 5000)).toBe(3))
  it('rounds a negative tie away from zero', () => expect(applyPercentBp(-5, 5000)).toBe(-3))
})

describe('applyPercentBp round-down', () => {
  it('rounds a remainder below one half down', () => expect(applyPercentBp(100001, 3333)).toBe(33330))
})

describe('percentBpOf', () => {
  it('returns 1500 for 300 of 2000 euro', () => expect(percentBpOf(30000, 200000)).toBe(1500))
  it('rounds a negative part away from zero', () => expect(percentBpOf(-1, 3)).toBe(-3333))
  it('handles a negative whole', () => expect(percentBpOf(1, -3)).toBe(-3333))
  it('returns 0 when the whole is 0', () => expect(percentBpOf(1, 0)).toBe(0))
})

describe('parseTypedAmount: what the owner types, in the notation the app displays', () => {
  it.each([
    ['1.200', 120000], ['1.000', 100000], ['2.500', 250000], ['1.234', 123400], ['-1.234', -123400],
    ['1.200,50', 120050], ['1.850,00', 185000], ['-1.850,5', -185050], ['1.234.567', 123456700], ['12.345', 1234500],
    ['1.20', 120], ['1.5', 150], ['-12.5', -1250], ['12,50', 1250], ['-23,20', -2320], ['1850,00', 185000], ['1850', 185000],
    ['0,05', 5], ['0.05', 5], ['+12,50', 1250], [' 12,50 € ', 1250], ['-0', 0],
  ])('reads %s as %i cents', (raw, cents) => expect(parseTypedAmount(raw)).toBe(cents))

  it.each(['', 'abc', '1,200', '0.500', '0.200', '1.2.3', '1.23.456', '12,505', '1.2000', '1,5,5', '.5', '1.', '-', '1.200,', '1.200,505', '01.200', '1.20,5'])(
    'refuses %s rather than guessing', (raw) => expect(() => parseTypedAmount(raw)).toThrow(TypeError))

  it('round-trips every value the field can be populated with', () => {
    for (const cents of [0, 5, -2, 120, -2320, 185000, -185000, 120000, 100000, 123456789, -99999999]) {
      expect(parseTypedAmount(centsToTypedString(cents))).toBe(cents)
      // and the grouped form the list shows reads back as the same figure
      expect(parseTypedAmount(formatEur(cents).replace(/\s?€$/, ''))).toBe(cents)
    }
  })
})

describe('centsToTypedString', () => {
  it.each([[185000, '1850,00'], [-2320, '-23,20'], [0, '0,00'], [-2, '-0,02']])('renders %i as %s', (c, s) =>
    expect(centsToTypedString(c)).toBe(s))
})

describe('the import parser is unchanged by the typed one', () => {
  // The bank's exported values keep their old meaning: here "1.200" is a decimal with a trailing zero, never a thousand.
  it.each([['1.200', 120], ['1.000', 100], ['2.500', 250], ['1850.00', 185000], ['-23.2', -2320]])(
    'parseAmountToCents(%s) is still %i', (raw, cents) => expect(parseAmountToCents(raw)).toBe(cents))
  it.each(['1.234', '1,200', '1.850,00', '-23,20'])('still rejects %s', (raw) => expect(() => parseAmountToCents(raw)).toThrow())
})
