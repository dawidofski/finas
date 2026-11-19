import type { CategoryRule } from '../db/schema'
import { fold } from '../lib/text'

/** Case, accents and every kind of whitespace ignored: "Trading 212", "TRADING212" and "Tráding  212" are the same text. */
export const ruleText = (text: string): string => fold(text).toLowerCase().replace(/\s+/gu, '')

/**
 * The category the owner's first matching rule files a bank description under, or null. A rule whose category no longer
 * exists (`known`) is skipped, and so is a rule with no text. The one place this decision is made.
 */
export function ruleCategoryFor(
  description: string,
  rules: readonly CategoryRule[],
  known: ReadonlySet<string>,
): string | null {
  const haystack = ruleText(description)
  for (const rule of rules) {
    const needle = ruleText(rule.contains)
    if (needle === '' || !known.has(rule.categoryId)) continue
    if (haystack.includes(needle)) return rule.categoryId
  }
  return null
}
