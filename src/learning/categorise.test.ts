import { describe, it, expect, vi } from 'vitest'
import type { MerchantRow, TransactionRow } from '../db/schema'
import { merchantTokens } from './canonicalise'
import type { CategoryMemory } from './memory'
import {
  suggestCategory, OWNER_CONFIDENCE, MEMORY_CONFIDENCE, ING_CONFIDENCE, type CategoriserContext,
} from './categorise'

const tx = (over: Partial<TransactionRow> = {}): TransactionRow => ({
  id: 't1', accountId: 'acc', valueDate: '2026-11-16', amountCents: -1000, balanceCents: 50000,
  description: 'Tienda Ejemplo 1234 Localidad ESP', comment: null, ingCategory: 'Food', ingSubcategory: 'Groceries',
  kind: 'spend', dedupKey: 'K1', importId: 'imp', fileSeq: 1, roundupParentId: null, createdAt: 1, deletedAt: null,
  ...over,
})
const merchant = (over: Partial<MerchantRow> = {}): MerchantRow => ({
  id: 'm1', canonicalName: 'Tienda Ejemplo', kind: 'merchant', matchPatterns: ['tienda ejemplo'],
  defaultCategoryId: null, isSubscription: false, createdAt: 1, ...over,
})
const memoryOf = (corrections: number, categoryId = 'cat-memory'): CategoryMemory =>
  new Map([['m1', { categoryId, corrections, lastAt: 1 }]])

/** Every source answers, each with a different category, so the winner is visible in the category id. */
const loud = (over: Partial<CategoriserContext> = {}): CategoriserContext => ({
  merchants: [merchant()],
  memory: memoryOf(3),
  ingCategoryFor: () => 'cat-ing',
  classify: () => ({ categoryId: 'cat-guess', confidence: 65 }),
  categoryExists: () => true,
  ownerCategoryFor: () => 'cat-owner',
  ...over,
})
/** Nobody has anything to say. */
const silent = (over: Partial<CategoriserContext> = {}): CategoriserContext => loud({
  merchants: [], memory: new Map(), ingCategoryFor: () => null, classify: () => null, ownerCategoryFor: () => null, ...over,
})

describe('suggestCategory order', () => {
  it('an owner override wins over memory, ING and the classifier', () => {
    const s = suggestCategory(tx(), loud())
    expect(s?.categoryId).toBe('cat-owner')
    expect(s?.tier).toBe('owner')
  })

  it('consults the tiers in order and stops at the first that answers', () => {
    const ingCategoryFor = vi.fn(() => 'cat-ing')
    const classify = vi.fn(() => ({ categoryId: 'cat-guess', confidence: 65 }))
    suggestCategory(tx(), loud({ ingCategoryFor, classify }))
    expect(ingCategoryFor).not.toHaveBeenCalled()
    expect(classify).not.toHaveBeenCalled()

    const classify2 = vi.fn(() => ({ categoryId: 'cat-guess', confidence: 65 }))
    suggestCategory(tx(), loud({ ownerCategoryFor: () => null, classify: classify2 }))
    expect(classify2).not.toHaveBeenCalled() // memory answered, so the classifier was never asked
  })

  it('memory wins over ING', () => {
    const s = suggestCategory(tx(), loud({ ownerCategoryFor: () => null }))
    expect(s?.categoryId).toBe('cat-memory')
    expect(s?.tier).toBe('memory')
  })

  it('ING wins over the classifier', () => {
    const s = suggestCategory(tx(), loud({ ownerCategoryFor: () => null, memory: new Map() }))
    expect(s?.categoryId).toBe('cat-ing')
    expect(s?.tier).toBe('ing')
  })

  it('the classifier answers only when the other three are silent', () => {
    const s = suggestCategory(tx(), loud({ ownerCategoryFor: () => null, memory: new Map(), ingCategoryFor: () => null }))
    expect(s?.categoryId).toBe('cat-guess')
    expect(s?.tier).toBe('classifier')
    expect(s?.confidence).toBe(65)
  })

  it('falls through to ING when memory has fewer than two corrections', () => {
    const s = suggestCategory(tx(), loud({ ownerCategoryFor: () => null, memory: memoryOf(1) }))
    expect(s?.categoryId).toBe('cat-ing')
    expect(s?.tier).toBe('ing')
  })

  it('uses memory at exactly two corrections', () => {
    const s = suggestCategory(tx(), loud({ ownerCategoryFor: () => null, memory: memoryOf(2) }))
    expect(s?.tier).toBe('memory')
  })

  it('returns null rather than guessing when every tier is silent', () => {
    expect(suggestCategory(tx(), silent())).toBeNull()
  })
})

describe('suggestCategory inputs', () => {
  it('asks the owner tier about this transaction by id', () => {
    const ownerCategoryFor = vi.fn((_id: string): string | null => null)
    suggestCategory(tx({ id: 'tx-42' }), silent({ ownerCategoryFor }))
    expect(ownerCategoryFor).toHaveBeenCalledWith('tx-42')
  })

  it('asks the ING tier with the transaction pair, in order', () => {
    const ingCategoryFor = vi.fn((_a: string, _b: string): string | null => null)
    suggestCategory(tx({ ingCategory: 'Food', ingSubcategory: 'Groceries' }), silent({ ingCategoryFor }))
    expect(ingCategoryFor).toHaveBeenCalledWith('Food', 'Groceries')
  })

  it('does not consult the ING tier unless both halves of the pair are present', () => {
    for (const over of [{ ingCategory: 'Food', ingSubcategory: null }, { ingCategory: null, ingSubcategory: 'Groceries' }]) {
      const ingCategoryFor = vi.fn((_a: string, _b: string): string | null => 'cat-ing')
      expect(suggestCategory(tx(over), silent({ ingCategoryFor }))).toBeNull()
      expect(ingCategoryFor).not.toHaveBeenCalled()
    }
  })

  it('asks the classifier with the merchant tokens of the description', () => {
    const classify = vi.fn((_t: string[]): { categoryId: string; confidence: number } | null => null)
    const description = 'Tienda Ejemplo 1234 Localidad ESP'
    suggestCategory(tx({ description }), silent({ classify }))
    const expected = merchantTokens(description)
    expect(expected.length).toBeGreaterThan(0)
    expect(classify).toHaveBeenCalledWith(expected)
  })

  it('does not use memory when the description matches no merchant', () => {
    const s = suggestCategory(tx({ description: 'Some Other Shop Utrecht NLD' }), loud({ ownerCategoryFor: () => null }))
    expect(s?.tier).toBe('ing') // memory is keyed by m1, which this description is not
  })

  it('uses the memory of the merchant that matched, not another merchant', () => {
    const other = merchant({ id: 'm2', canonicalName: 'Jumbo', matchPatterns: ['jumbo'] })
    const memory: CategoryMemory = new Map([
      ['m1', { categoryId: 'cat-ah', corrections: 2, lastAt: 1 }],
      ['m2', { categoryId: 'cat-jumbo', corrections: 5, lastAt: 1 }],
    ])
    const s = suggestCategory(tx(), loud({ ownerCategoryFor: () => null, merchants: [other, merchant()], memory }))
    expect(s?.categoryId).toBe('cat-ah')
  })
})

describe('suggestCategory confidence', () => {
  it('reports a fixed, strictly descending confidence for the first three tiers', () => {
    const owner = suggestCategory(tx(), loud())
    const memory = suggestCategory(tx(), loud({ ownerCategoryFor: () => null }))
    const ing = suggestCategory(tx(), loud({ ownerCategoryFor: () => null, memory: new Map() }))
    expect([owner?.confidence, memory?.confidence, ing?.confidence]).toEqual([100, 90, 80])
    expect([OWNER_CONFIDENCE, MEMORY_CONFIDENCE, ING_CONFIDENCE]).toEqual([100, 90, 80])
  })

  it('passes the classifier confidence through, as an integer within 0 to 100', () => {
    const at = (confidence: number) => suggestCategory(tx(), silent({ classify: () => ({ categoryId: 'cat-guess', confidence }) }))?.confidence
    expect(at(66)).toBe(66)
    expect(at(66.6)).toBe(67)
    expect(at(140)).toBe(100)
    expect(at(-5)).toBe(0)
  })
})

describe('suggestCategory because', () => {
  const NO_JARGON = /tier|bayes|classif|posterior|probab|model|algorithm|because|caus|therefore|due to|so that/i

  it('reports the tier that produced the answer, and an evidence sentence naming it', () => {
    const owner = suggestCategory(tx(), loud())
    const memory = suggestCategory(tx(), loud({ ownerCategoryFor: () => null, memory: memoryOf(3) }))
    const ing = suggestCategory(tx({ ingCategory: 'Food', ingSubcategory: 'Groceries' }), loud({ ownerCategoryFor: () => null, memory: new Map() }))
    const guess = suggestCategory(tx(), silent({ classify: () => ({ categoryId: 'cat-guess', confidence: 65 }) }))

    expect(owner?.because).toBe('You chose this category for this transaction yourself.')
    expect(memory?.because).toBe('You have put Tienda Ejemplo in this category 3 times.')
    expect(ing?.because).toBe('ING files this under Food, Groceries.')
    expect(guess?.because).toBe('It looks like other transactions you have put in this category.')
    for (const s of [owner, memory, ing, guess]) {
      expect(s?.because).not.toMatch(NO_JARGON)
      expect(s?.because.endsWith('.')).toBe(true)
    }
  })
})

describe('suggestCategory deleted categories', () => {
  const gone = (...ids: string[]) => (id: string) => !ids.includes(id)

  it('skips an owner category that no longer exists and moves on', () => {
    const s = suggestCategory(tx(), loud({ categoryExists: gone('cat-owner') }))
    expect(s?.categoryId).toBe('cat-memory')
  })

  it('skips a remembered category that no longer exists and moves on to ING', () => {
    const s = suggestCategory(tx(), loud({ ownerCategoryFor: () => null, categoryExists: gone('cat-memory') }))
    expect(s?.categoryId).toBe('cat-ing')
    expect(s?.tier).toBe('ing')
  })

  it('skips an ING category that no longer exists and moves on to the classifier', () => {
    const s = suggestCategory(tx(), loud({ ownerCategoryFor: () => null, memory: new Map(), categoryExists: gone('cat-ing') }))
    expect(s?.categoryId).toBe('cat-guess')
  })

  it('never suggests a deleted classifier category', () => {
    const s = suggestCategory(tx(), loud({ ownerCategoryFor: () => null, memory: new Map(), ingCategoryFor: () => null, categoryExists: gone('cat-guess') }))
    expect(s).toBeNull()
  })

  it('returns null when every answer is for a deleted category', () => {
    expect(suggestCategory(tx(), loud({ categoryExists: () => false }))).toBeNull()
  })
})
