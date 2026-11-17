import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MAX_CONFIDENCE, MIN_CONFIDENCE, MIN_EXAMPLES, classify, train } from './bayes'

const ex = (categoryId: string, ...tokens: string[]) => ({ tokens, categoryId })
const many = (n: number, categoryId: string, ...tokens: string[]) => Array.from({ length: n }, () => ex(categoryId, ...tokens))

// 12 supermarket rows and 9 fuel rows, the last naming its tokens in a different order: a clear, well-trained model.
const training = [...many(12, 'groceries', 'Supermercado'), ...many(8, 'fuel', 'Estacion', 'Gasolinera'), ex('fuel', 'Express', 'Gasolinera')]

describe('bayes (tier 4)', () => {
  it('stays silent below the training floor, however lopsided the examples', () => {
    const n = MIN_EXAMPLES - 1
    const below = train([...many(n - 1, 'groceries', 'Supermercado'), ex('fuel', 'Estacion')])
    expect(below.examples).toBe(n)
    expect(classify(['Supermercado'], below)).toBeNull()
    // One more example and the very same evidence is acted on: the floor is exactly MIN_EXAMPLES.
    const at = train([...many(n, 'groceries', 'Supermercado'), ex('fuel', 'Estacion')])
    expect(classify(['Supermercado'], at)?.categoryId).toBe('groceries')
  })

  it('stays silent when only one category was ever seen, even with plenty of examples', () => {
    const model = train(many(30, 'groceries', 'Supermercado'))
    expect(classify(['Supermercado'], model)).toBeNull()
  })

  it('stays silent when its best guess is below the confidence floor', () => {
    // 'Comercio' is split 6 / 5 between two categories: a near coin-flip.
    const model = train([...many(6, 'shopping', 'Comercio'), ...many(5, 'books', 'Comercio')])
    expect(model.examples).toBeGreaterThanOrEqual(MIN_EXAMPLES)
    expect(classify(['Comercio'], model)).toBeNull()
    // The same model is not silent about a token it can tell apart, so the null above is the floor, not a broken model.
    const clearer = train([...many(6, 'shopping', 'Comercio', 'Ropa'), ...many(5, 'books', 'Comercio', 'Libreria')])
    expect(classify(['Comercio', 'Libreria'], clearer)?.categoryId).toBe('books')
    expect(MIN_CONFIDENCE).toBeGreaterThan(50)
  })

  it('classifies a clearly-seen merchant into the category it was trained on', () => {
    const model = train(training)
    const grocery = classify(['Supermercado'], model)
    expect(grocery?.categoryId).toBe('groceries')
    expect(classify(['Estacion', 'Gasolinera'], model)?.categoryId).toBe('fuel')
    expect(Number.isInteger(grocery?.confidence)).toBe(true)
    expect(grocery?.confidence).toBeGreaterThanOrEqual(MIN_CONFIDENCE)
  })

  it('never reports more than MAX_CONFIDENCE, however certain the evidence', () => {
    const model = train([...many(500, 'groceries', 'Supermercado'), ...many(500, 'fuel', 'Estacion')])
    expect(classify(['Supermercado'], model)).toEqual({ categoryId: 'groceries', confidence: MAX_CONFIDENCE })
    expect(MAX_CONFIDENCE).toBeLessThan(80)
  })

  it('is unaffected by the order the examples were given in', () => {
    const forward = train(training)
    const reversed = train([...training].reverse())
    const rotated = train([...training.slice(7), ...training.slice(0, 7)])
    expect(reversed).toEqual(forward)
    expect(rotated).toEqual(forward)
    expect(classify(['Supermercado'], reversed)).toEqual(classify(['Supermercado'], forward))
  })

  it('handles an unseen token without dividing by zero or returning NaN', () => {
    const model = train(training)
    expect(classify(['Zzz'], model)).toBeNull()
    expect(classify([], model)).toBeNull()
    // An unseen token beside a known one changes nothing: it says nothing about any category.
    expect(classify(['Supermercado', 'Zzz'], model)).toEqual(classify(['Supermercado'], model))
    // Nor does training on rows with no tokens, which would otherwise make 0/0 terms.
    expect(train([...training, ex('groceries')])).toEqual(model)
    expect(classify(['Supermercado'], train([]))).toBeNull()
  })

  it('survives a JSON round trip (the IndexedDB cache) with identical answers', () => {
    const model = train([...training, ...many(5, 'fuel', 'Supermercado', 'Express')])
    const revived: typeof model = JSON.parse(JSON.stringify(model))
    expect(revived).toEqual(model)
    for (const tokens of [['Supermercado'], ['Estacion'], ['Supermercado', 'Express'], ['Zzz'], []]) {
      expect(classify(tokens, revived)).toEqual(classify(tokens, model))
    }
  })

  it('uses no floating-point arithmetic', () => {
    const raw = readFileSync(resolve(import.meta.dirname, 'bayes.ts'), 'utf8')
    // Code only: drop comments and string literals so prose like "n / d" cannot hide or fake a match.
    const code = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
      .replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, '""')
    expect(code).toMatch(/function divFloor/) // the scan is looking at the real file
    // The single division in the file is the integer floor in divFloor; no other `/` may appear.
    expect(code.split('\n').filter((l) => l.includes('/')).map((l) => l.trim())).toEqual(['return Math.floor(n / d)'])
    expect(code).not.toMatch(/\b(parseFloat|toFixed|toPrecision)\b/)
    expect(code).not.toMatch(/Math\.(log|log2|log10|exp|pow|sqrt|cbrt|random|fround|hypot)\b/)
    expect(code).not.toMatch(/\*\*/)
    expect(code).not.toMatch(/\d\.\d|\d\.(?!\w)|(?<![\w.])\.\d/) // no decimal literal
  })
})
