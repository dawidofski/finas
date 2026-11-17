import { divRound } from './money'

/**
 * The one integer median in the app, with its one tie rule, so two statistics modules cannot drift apart on it.
 *
 * For an odd count it is the middle value. For an even count the two middle values are averaged and, since there is no
 * half-cent, a .5 rounds away from zero (up, for the non-negative amounts we hold): `divRound`, the same rounding as every other
 * figure in the app, so the median stays an integer with no float anywhere. Returns null exactly when there is nothing to take a
 * median of; the input is not modified.
 */
export function medianOf(values: readonly number[]): number | null {
  const sorted = [...values].sort((a, b) => a - b)
  const n = sorted.length
  const upper = sorted[Math.floor(n / 2)]
  if (upper === undefined) return null
  if (n % 2 === 1) return upper
  const lower = sorted[Math.floor(n / 2) - 1]
  if (lower === undefined) return null
  return divRound(lower + upper, 2)
}
