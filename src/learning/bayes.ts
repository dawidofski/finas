// Tier 4 of the categoriser: a multinomial naive Bayes over merchant tokens. It is the only tier that GUESSES, and the spec
// (§7.2) allows it only as a low-confidence suggestion the owner confirms, so its main virtue is staying quiet: `classify`
// returns null unless there is enough training data AND the evidence clearly favours one category.
//
// Everything is integer arithmetic. Probabilities are never multiplied (that needs floats); instead each term is a base-2
// logarithm held as an integer in units of 1/LOG_SCALE bit, and the terms are added. Counts are compared, never divided.
// The one integer division in this file is `divFloor`; src/learning/bayes.test.ts asserts it is the only division in the code.
//
// The model is a plain object of integers, strings and arrays (no Map, no class) because it is cached in IndexedDB.

/**
 * Below this many usable training examples in total, classify() stays silent. Naive Bayes on a handful of rows is
 * overconfident (a merchant seen twice looks "certain"), and a wrong suggestion on a new user's first import is worse than none.
 */
export const MIN_EXAMPLES = 10

/**
 * Below this posterior (percent) for the best category, classify() stays silent. 60 means the best category is clearly ahead
 * of the rest rather than a coin-flip between two: a near-tie is not evidence, and the owner is better served by no suggestion.
 */
export const MIN_CONFIDENCE = 60

/**
 * The most confidence tier 4 ever reports. The spec calls this tier "only ever a low-confidence suggestion the owner confirms":
 * a guess from text alone must never look as sure as the owner's own override, their repeated corrections, or the bank's own
 * category (tiers 1-3, assumed to report at or above 80). Capped at 70 so the UI can say "this looks like X", not "this is X".
 */
export const MAX_CONFIDENCE = 70

// log2 values are held as integers in units of 1/1024 bit.
const LOG_SCALE = 1024
const LOG_SCALE_BITS = 10
// Fixed-point scale (2^20) for the mantissa and for posterior weights.
const ONE_BITS = 20
const ONE = 1 << ONE_BITS
// Posterior weights below 2^-20 of the best are zero.
const MAX_SHIFT = 20

export interface CategoryModel {
  categoryId: string
  /** Training examples (with at least one token) of this category. */
  examples: number
  /** Total token occurrences seen in this category. */
  tokenTotal: number
  /** [token, occurrences] pairs, sorted by token. */
  tokens: [string, number][]
}

export interface Model {
  /** Total usable training examples. */
  examples: number
  /** Distinct tokens across all categories (the smoothing vocabulary V). */
  vocabulary: number
  /** Sorted by categoryId. */
  categories: CategoryModel[]
}

/** floor(n / d) for non-negative integers, d > 0. The only division in this file. */
function divFloor(n: number, d: number): number {
  return Math.floor(n / d)
}

/** round(n / d), halves up, integer-only. n >= 0, d > 0. */
function divRound(n: number, d: number): number {
  const q = divFloor(n, d)
  return (n - q * d) * 2 >= d ? q + 1 : q
}

/** log2(x) * 1024 for an integer x >= 1, truncated, by repeated squaring of the mantissa. */
function log2Scaled(x: number): number {
  const k = 31 - Math.clz32(x)
  // mantissa in [1, 2) scaled by 2^20
  let m = k <= ONE_BITS ? x << (ONE_BITS - k) : x >> (k - ONE_BITS)
  let frac = 0
  for (let i = 0; i < LOG_SCALE_BITS; i++) {
    m = divFloor(m * m, ONE)
    frac <<= 1
    if (m >= 2 * ONE) {
      frac |= 1
      m >>= 1
    }
  }
  return (k << LOG_SCALE_BITS) + frac
}

const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

export function train(examples: { tokens: string[]; categoryId: string }[]): Model {
  const byCategory = new Map<string, { examples: number; tokenTotal: number; tokens: Map<string, number> }>()
  const vocabulary = new Set<string>()
  let usable = 0
  for (const ex of examples) {
    if (ex.tokens.length === 0) continue // no merchant, no evidence
    usable++
    let cat = byCategory.get(ex.categoryId)
    if (!cat) {
      cat = { examples: 0, tokenTotal: 0, tokens: new Map() }
      byCategory.set(ex.categoryId, cat)
    }
    cat.examples++
    for (const t of ex.tokens) {
      cat.tokenTotal++
      cat.tokens.set(t, (cat.tokens.get(t) ?? 0) + 1)
      vocabulary.add(t)
    }
  }
  // Sorted so the model (and so the cache) does not depend on the order the examples arrived in.
  const categories = [...byCategory.keys()].sort(byString).map((categoryId): CategoryModel => {
    const cat = byCategory.get(categoryId)!
    return {
      categoryId,
      examples: cat.examples,
      tokenTotal: cat.tokenTotal,
      tokens: [...cat.tokens.entries()].sort((a, b) => byString(a[0], b[0])),
    }
  })
  return { examples: usable, vocabulary: vocabulary.size, categories }
}

/**
 * The category the tokens most likely belong to, or null when the model is silent: too few examples, fewer than two
 * categories to tell apart, no token the model has ever seen, or a best category whose posterior is below MIN_CONFIDENCE.
 * Tokens the model never saw are ignored (they carry no information about any category), not smoothed into every score.
 * `confidence` is the best category's posterior in percent (integer), capped at MAX_CONFIDENCE.
 */
export function classify(tokens: string[], model: Model): { categoryId: string; confidence: number } | null {
  if (model.examples < MIN_EXAMPLES) return null
  // With one category there is nothing to discriminate between; its "posterior" would be a vacuous 100.
  if (model.categories.length < 2) return null

  const known = tokens.filter((t) => model.categories.some((c) => c.tokens.some((p) => p[0] === t)))
  if (known.length === 0) return null

  // score = log2 P(c) + sum over tokens of log2 P(t | c), Laplace-smoothed; the shared log2 N term of the prior is dropped.
  const scores = model.categories.map((c) => {
    const counts = new Map(c.tokens)
    let score = log2Scaled(c.examples)
    const denominator = log2Scaled(c.tokenTotal + model.vocabulary)
    for (const t of known) score += log2Scaled((counts.get(t) ?? 0) + 1) - denominator
    return score
  })

  let best = 0
  scores.forEach((s, i) => {
    if (s > (scores[best] ?? s)) best = i
  })
  const bestScore = scores[best] ?? 0

  // Posterior of the best category: its weight over the sum of all weights, where a category `gap` below the best weighs
  // 2^-gap, interpolated linearly between powers of two. That chord lies above the curve, so the rivals are slightly
  // over-weighted and the confidence slightly under-reported: the error is on the cautious side.
  let total = 0
  for (const s of scores) {
    const gap = bestScore - s
    const shift = gap >> LOG_SCALE_BITS
    if (shift >= MAX_SHIFT) continue
    const base = ONE >> shift
    total += base - ((base * (gap & (LOG_SCALE - 1))) >> 11)
  }
  const posterior = divRound(100 * ONE, total)
  if (posterior < MIN_CONFIDENCE) return null
  const category = model.categories[best]
  if (!category) return null
  return { categoryId: category.categoryId, confidence: Math.min(posterior, MAX_CONFIDENCE) }
}
