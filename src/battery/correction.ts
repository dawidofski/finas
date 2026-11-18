import { ALPHA_BP, type Bracket } from './critical'

export interface Corrected<T> {
  item: T
  bracket: Bracket
  survives: boolean
}

/** The false-discovery rate the whole battery is held to: 5 %, in basis points. */
export const FDR_BP = 500

/**
 * An unbracketed item is as far from significant as a p can be: p = 1, i.e. 10000 bp.
 *
 * ALPHA_BP has no entry for 'none', and that gap is a decision. 'none' is COUNTED in m rather than skipped, because
 * Benjamini-Hochberg's m is the number of hypotheses TESTED, not the number that looked promising. Dropping the
 * unbracketed ones would shrink m, make every surviving threshold k * 5 % / m looser, and let a hopeless relationship
 * added to the battery change what the others are allowed to claim: both are the direction this project never moves.
 * At p = 1 it can never satisfy p * m <= k * FDR for any k <= m, so it can never survive either.
 */
const NONE_BP = 10000

function pBp(bracket: Bracket): number {
  return bracket === 'none' ? NONE_BP : ALPHA_BP[bracket]
}

/**
 * Benjamini-Hochberg step-up over the brackets, at a false-discovery rate of 5 %.
 *
 * Each bracket's UPPER BOUND stands in for its p, so a result is judged as weaker than it may be: the procedure can
 * only withhold a finding, never invent one.
 *
 * Sort the m p-values ascending; the cutoff is the largest rank k with p(k) <= k * FDR / m, and every item whose p is
 * at or below p(k) survives. The comparison is cross-multiplied, p(k) * m <= k * FDR, so it is exact integer
 * arithmetic with no division.
 *
 * Determinism: the verdict depends on an item's p alone, never on where it sits in the input. Only the p values are
 * sorted (a total order on integers, and equal values are indistinguishable), and survival is `p <= p(cutoff)`, so a
 * tie group is judged together at its LAST rank, which is the most permissive rank its members share. Two items in the
 * same bracket therefore always get the same verdict, and results come back in input order, untouched.
 *
 * thresholdBp is the corrected threshold at the cutoff, k * FDR / m, rounded DOWN (exact BigInt floor) so the figure
 * shown is never looser than the one applied. It is null when nothing survives.
 */
export function benjaminiHochberg<T>(items: readonly { item: T; bracket: Bracket }[]): {
  results: Corrected<T>[]
  thresholdBp: number | null
  tested: number
} {
  const m = items.length
  const sorted = items.map((x) => pBp(x.bracket)).sort((a, b) => a - b)

  let cutoffRank = 0
  let cutoffP = -1
  for (let k = m; k >= 1; k--) {
    const p = sorted[k - 1]
    if (p === undefined) continue
    if (p * m <= k * FDR_BP) {
      cutoffRank = k
      cutoffP = p
      break
    }
  }

  const results = items.map(({ item, bracket }) => ({
    item,
    bracket,
    survives: cutoffRank > 0 && pBp(bracket) <= cutoffP,
  }))
  const thresholdBp = cutoffRank > 0 ? Number((BigInt(cutoffRank) * BigInt(FDR_BP)) / BigInt(m)) : null
  return { results, thresholdBp, tested: m }
}
