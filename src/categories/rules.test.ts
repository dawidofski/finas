import { describe, expect, it } from 'vitest'
import { ruleCategoryFor } from './rules'

const known = new Set(['cat.a', 'cat.b'])
const rule = (id: string, contains: string, categoryId: string) => ({ id, contains, categoryId })

describe('ruleCategoryFor', () => {
  it('ignores case, accents and spaces on both sides', () => {
    const rules = [rule('r1', 'trading 212', 'cat.a')]
    expect(ruleCategoryFor('Transferencia a TRADING212 UK', rules, known)).toBe('cat.a')
    expect(ruleCategoryFor('Tráding  212', rules, known)).toBe('cat.a')
    expect(ruleCategoryFor('Trading\t 212', [rule('r2', 'TRÁDING212', 'cat.a')], known)).toBe('cat.a')
  })
  it('the first matching rule wins', () => {
    const rules = [rule('r1', 'shop', 'cat.b'), rule('r2', 'shop', 'cat.a')]
    expect(ruleCategoryFor('Corner SHOP', rules, known)).toBe('cat.b')
  })
  it('skips a rule whose category is missing', () => {
    const rules = [rule('r1', 'shop', 'cat.gone'), rule('r2', 'shop', 'cat.a')]
    expect(ruleCategoryFor('Corner shop', rules, known)).toBe('cat.a')
  })
  it('gives null when nothing matches or there are no rules', () => {
    expect(ruleCategoryFor('Corner shop', [rule('r1', 'bank', 'cat.a')], known)).toBeNull()
    expect(ruleCategoryFor('Corner shop', [], known)).toBeNull()
  })
})
