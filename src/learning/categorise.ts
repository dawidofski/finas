import type { MerchantRow, TransactionRow } from '../db/schema'
import { merchantTokens } from './canonicalise'
import { matchMerchant } from './merchants'
import { rememberedCategoryFor, type CategoryMemory } from './memory'

// The categoriser (§7.2): four sources of a category, asked in a fixed order, and the first that answers wins.
// There is no blending and no voting. The point of a layered engine over one model is that it can say WHY, so every
// answer carries the sentence that explains it. This function is pure: every read happens in the caller (Task 6 builds
// one context per import file) and arrives through CategoriserContext.

export type Tier = 'owner' | 'memory' | 'ing' | 'classifier'

export interface Suggestion {
  categoryId: string
  tier: Tier
  /** Integer 0-100. */
  confidence: number
  /** The owner-facing evidence sentence. No jargon and no causal claim (§12). */
  because: string
}

export interface CategoriserContext {
  merchants: MerchantRow[]
  memory: CategoryMemory
  ingCategoryFor: (ing: string, ingSub: string) => string | null
  classify: (tokens: string[]) => { categoryId: string; confidence: number } | null
  categoryExists: (categoryId: string) => boolean
  ownerCategoryFor: (transactionId: string) => string | null
}

/**
 * The confidence each source reports is fixed, so the order shows in the number the owner sees. The classifier reports
 * what it computes, which is capped at 70 (MAX_CONFIDENCE in bayes.ts); that cap assumes the other three report at
 * least 80, and these values make that true.
 */
export const OWNER_CONFIDENCE = 100
export const MEMORY_CONFIDENCE = 90
export const ING_CONFIDENCE = 80

/**
 * The best category for a transaction, or null when nobody has anything to say. A source whose category no longer exists
 * counts as silent, so the chain moves on to the next source rather than suggesting a deleted category.
 */
export function suggestCategory(tx: TransactionRow, ctx: CategoriserContext): Suggestion | null {
  const owner = ctx.ownerCategoryFor(tx.id)
  if (owner !== null && ctx.categoryExists(owner)) {
    return {
      categoryId: owner, tier: 'owner', confidence: OWNER_CONFIDENCE,
      because: 'You chose this category for this transaction yourself.',
    }
  }

  const merchant = matchMerchant(tx.description, ctx.merchants)
  if (merchant !== null) {
    const entry = ctx.memory.get(merchant.id)
    // rememberedCategoryFor owns the two-corrections rule; it is not repeated here.
    const remembered = entry === undefined ? null : rememberedCategoryFor(merchant.id, ctx.memory)
    if (entry !== undefined && remembered !== null && ctx.categoryExists(remembered)) {
      return {
        categoryId: remembered, tier: 'memory', confidence: MEMORY_CONFIDENCE,
        because: `You have put ${merchant.canonicalName} in this category ${entry.corrections} times.`,
      }
    }
  }

  if (tx.ingCategory !== null && tx.ingSubcategory !== null) {
    const ing = ctx.ingCategoryFor(tx.ingCategory, tx.ingSubcategory)
    if (ing !== null && ctx.categoryExists(ing)) {
      return {
        categoryId: ing, tier: 'ing', confidence: ING_CONFIDENCE,
        because: `ING files this under ${tx.ingCategory}, ${tx.ingSubcategory}.`,
      }
    }
  }

  const guess = ctx.classify(merchantTokens(tx.description))
  if (guess !== null && ctx.categoryExists(guess.categoryId)) {
    return {
      // The context is injected, so hold the contract here: an integer from 0 to 100.
      categoryId: guess.categoryId, tier: 'classifier', confidence: Math.min(100, Math.max(0, Math.round(guess.confidence))),
      because: 'It looks like other transactions you have put in this category.',
    }
  }
  return null
}
