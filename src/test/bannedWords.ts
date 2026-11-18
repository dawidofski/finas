import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * THE ONE PLACE THE BANNED-LANGUAGE LISTS ARE READ, for every test that checks owner-facing wording.
 *
 * Two test files OWN these lists and are where they are maintained:
 *   src/ui/screens/Reports.test.tsx  `causalWords`, `jargonWords`
 *   src/learning/categorise.test.ts  `NO_JARGON`
 * Everything else reads them FROM those files rather than restating them, because a drifted copy of a language ban is
 * the worst kind to have: it silently permits in one screen the wording another forbids. This repository has already
 * paid for that twice — battery.test.ts carried copies marked "reused from" whose jargon list had four terms the
 * owning list did not, and three separate copies of the extraction below existed before this module.
 *
 * WHY A NON-TEST MODULE. The extraction cannot live in one of the test files and be imported by the others:
 * importing a `.test.ts` module re-registers its `describe` blocks inside the importing file's suite, so every other
 * file would run that file's tests as well. A plain module has no such effect, so this is one.
 *
 * TWO PROPERTIES ARE THE WHOLE VALUE OF THIS MECHANISM, and a shared helper that lost either would be worse than the
 * three copies it replaces:
 *
 *   1. IT THROWS rather than scanning a stale pattern. If an owning line is reworded or renamed, `regexFrom` cannot
 *      find it and raises — at import time, so every importing file fails loudly — instead of quietly going on with
 *      a pattern that no longer reflects the rule.
 *   2. IT IS NOT VACUOUS. A pattern that matched nothing would make every assertion in every importer pass on
 *      anything at all, which is the silent failure this file exists to prevent, so each extracted list is probed
 *      here against a word it exists to forbid and a sentence it must leave alone. The probe runs on import and
 *      throws, so no importer can skip it; `BANNED_LISTS` exports the same probes so each test file can assert them
 *      visibly as well.
 */
const SRC = resolve(import.meta.dirname, '..')

/**
 * The regex literal assigned to `const <name>` in `src/<file>`, as a live RegExp.
 *
 * Deliberately brittle, and deliberately not clever: it matches one `const name = /…/flags` line to the end of the
 * line. A reworded declaration is meant to break this, since the alternative is a guard that has quietly stopped
 * reflecting the rule it names while still reporting success.
 */
export function regexFrom(file: string, name: string): RegExp {
  const text = readFileSync(resolve(SRC, file), 'utf8')
  const match = new RegExp(`const ${name} = /(.*)/([a-z]*)\\s*$`, 'm').exec(text)
  const source = match?.[1]
  if (source === undefined) throw new Error(`no regex named ${name} in src/${file}`)
  return new RegExp(source, match?.[2] ?? '')
}

/** Causal claims: the app may say two things moved together, never that one made the other happen. */
export const causalWords = regexFrom('ui/screens/Reports.test.tsx', 'causalWords')
/** Statistical and engineering jargon that has no place in a sentence about someone's own money. */
export const jargonWords = regexFrom('ui/screens/Reports.test.tsx', 'jargonWords')
/** The learning engine's own list, which overlaps the two above and is not identical to either. */
export const noJargon = regexFrom('learning/categorise.test.ts', 'NO_JARGON')

export interface BannedList {
  /** The name it carries in the file that owns it. */
  name: string
  pattern: RegExp
  /** A word this list exists to forbid. If the pattern stops matching it, the pattern is no longer the rule. */
  forbids: string
  /** Plain owner-facing wording this list must leave alone, so it cannot pass by matching everything. */
  allows: string
}

export const BANNED_LISTS: readonly BannedList[] = [
  { name: 'causalWords', pattern: causalWords, forbids: 'because', allows: 'a plain sentence about your own money' },
  { name: 'jargonWords', pattern: jargonWords, forbids: 'percentile', allows: 'a plain sentence about your own money' },
  { name: 'NO_JARGON', pattern: noJargon, forbids: 'bayes', allows: 'a plain sentence about your own money' },
]

/**
 * Wording that presumes what the owner can afford (anti-goal A1). "just" and "only" are ordinary words, so this list
 * matches the PRESUMING usages ("just stop", "you only need to", "simply", "cut back on luxuries"), not the words.
 * OWNED HERE, unlike the three above: no test file carries this rule, so a copy elsewhere would be the first drift.
 */
export const meansAssumption = /\b(simply|just (stop|skip|cut|drop|save|put|set|use|say|try|don'?t|stick|spend less)|(you|you'?ll) (only|just) (need|have)|only (need|have) to|cut back on (the )?luxur\w*|should be able to|(it'?s|is) easy to (save|cut|stop|skip|afford)|easily (afford|save|cut))\b/i
/** Judging wording (anti-goal A1): the app describes what happened, it does not grade the person who did it. */
export const shamingWords = /\b(should(n'?t)?|waste[ds]?|wasteful|overspen[dt]\w*|bad (habit|decision|choice)s?|irresponsible|reckless|guilty|lazy|careless|splurg\w*|blew)\b/i

/**
 * The owner-facing wording rules owned in THIS file. Kept apart from BANNED_LISTS, which names the three lists read
 * out of test files (and which src/battery/finding.test.ts pins at three), so adding a rule here changes no count
 * that file asserts. Probed on import exactly like BANNED_LISTS.
 */
export const WORDING_LISTS: readonly BannedList[] = [
  { name: 'meansAssumption', pattern: meansAssumption, forbids: 'you only need to', allows: 'Only the card payments are counted, just as the bank lists them' },
  { name: 'shamingWords', pattern: shamingWords, forbids: 'a wasted month', allows: 'a plain sentence about your own money' },
]

/**
 * Throws unless every list still matches a word it exists to forbid and still leaves ordinary wording alone.
 *
 * A pattern matching NOTHING would make every assertion in every importer pass on any wording at all; one matching
 * EVERYTHING would fail on all of it. Both are silent failures of the mechanism rather than of the rule, which is
 * why this is checked rather than assumed.
 *
 * Exported so it can be tested directly — src/battery/finding.test.ts hands it a deliberately vacuous list and a
 * deliberately universal one and requires it to throw for each. Without that, the only thing exercising this
 * function would be its own success, and a version that never threw would look identical.
 */
export function assertNotVacuous(lists: readonly BannedList[]): void {
  for (const list of lists) {
    if (!list.pattern.test(list.forbids)) {
      throw new Error(`${list.name} no longer matches ${list.forbids}, so it is not the rule it is named after`)
    }
    if (list.pattern.test(list.allows)) {
      throw new Error(`${list.name} matches ordinary wording (${list.allows}), so it would pass on anything`)
    }
  }
}

/**
 * Run once on import, so a vacuous list fails every importing file at load rather than only the files that remember
 * to assert it.
 *
 * DEFENCE IN DEPTH, AND NOT OBSERVABLE TODAY — said plainly rather than claimed as covered. All three readers assert
 * `BANNED_LISTS` themselves, so deleting this call breaks no test: mutation testing confirmed it survives. What it
 * guards is the NEXT reader, which may import `causalWords` and scan with it without probing it first. The function
 * above is tested directly; this call is the one line here that nothing observes, and it stays because the cost is a
 * single loop at import and the failure it prevents is a whole file of assertions that silently pass on anything.
 */
assertNotVacuous(BANNED_LISTS)


