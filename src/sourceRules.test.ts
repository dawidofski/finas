import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The one place the date and float rules are enforced, over EVERY source file under src/. Earlier each module carried its own
 * copy of this scan against a list of files, and the list went stale twice (transactionsInRange.ts, then Settings.tsx): a guard
 * that silently stops covering code reads as coverage. A new file is covered the moment it exists.
 *
 * Dates are 'YYYY-MM-DD' strings through src/lib/dates.ts, whose arithmetic uses UTC only, so the machine's timezone can never
 * shift a day. Any local-timezone Date method breaks that, and so does a locale-dependent date formatter.
 */
const SRC = resolve(import.meta.dirname)

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name)
    if (e.isDirectory()) return e.name === '__fixtures__' ? [] : sourceFiles(path)
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && e.name !== 'vite-env.d.ts' ? [path] : []
  })
}
/**
 * These rules are about what the code DOES, so they are scanned against the code with comments and string literals removed.
 * Without this, prose trips them: a doc comment that merely mentions `Date.now` to explain why the module does not call it was
 * reported as a clock read, which is a guard crying wolf about its own documentation. Strings go first so that a `//` inside
 * one cannot be mistaken for a comment. No rule here looks inside a string — they all match identifiers and calls — so
 * removing them loses no detection.
 */
export function code(text: string): string {
  return text
    .replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/gs, "''")
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
}

const files = sourceFiles(SRC).map((path) => {
  const text = readFileSync(path, 'utf8')
  return { rel: relative(SRC, path).split(sep).join('/'), text, code: code(text) }
})
const matches = (re: RegExp) => files.flatMap((f) => (f.code.match(re) ?? []).map((m) => `${f.rel}: ${m}`))

describe('source rules, over every file in src/', () => {
  it('strips comments and strings before judging, and still sees real code', () => {
    // The stripper is what stops these rules crying wolf about their own documentation, so it needs its own check: a guard
    // whose detector has quietly stopped working reads as coverage. Prose must not trip; code must.
    expect(code('// mentions Date.now in a comment')).not.toMatch(/Date\.now/)
    expect(code('/* a block comment about getFullYear */')).not.toMatch(/getFullYear/)
    expect(code("const why = 'we never call Date.now here'")).not.toMatch(/Date\.now/)
    expect(code('const t = Date.now() // and a trailing comment')).toMatch(/Date\.now/)
    expect(code('const d = new Date(ms)')).toMatch(/new Date/)
    // A `//` inside a string is not a comment, so the code after it must survive.
    expect(code("const u = 'https://example.test'; const t = Date.now()")).toMatch(/Date\.now/)
  })

  it('actually scans the code (a scan of nothing proves nothing)', () => {
    const names = files.map((f) => f.rel)
    expect(names.length).toBeGreaterThan(40)
    expect(names).toEqual(expect.arrayContaining(['lib/dates.ts', 'ui/screens/Settings.tsx', 'analysis/transactionsInRange.ts', 'ui/screens/Budget.tsx']))
  })

  it('uses no local-timezone or locale-dependent Date method anywhere', () => {
    const forbidden = /\b(getFullYear|getMonth|getDate|getHours|getMinutes|getSeconds|getMilliseconds|getDay|getYear|getTimezoneOffset|toLocaleDateString|toLocaleTimeString|toLocaleString|toDateString|toTimeString|setHours|setMinutes|setSeconds|setMilliseconds|setDate|setMonth|setFullYear|Date\.parse)\b|Intl\.DateTimeFormat/g
    expect(matches(forbidden)).toEqual([])
  })

  it('constructs a Date only where it is sanctioned, and says why', () => {
    // file -> the only constructor calls it may contain.
    const allowed: Record<string, RegExp> = {
      // The UTC conversions: `new Date(ms)` read back only through getUTC* accessors.
      'lib/dates.ts': /^new\s+Date\s*\(\s*ms\s*\)$/,
      // `exportedAt` is an instant written with toISOString (always UTC), not a calendar date read in any timezone.
      'db/backup.ts': /^new\s+Date\s*\(\s*\)$/,
    }
    const calls = files.flatMap((f) => (f.text.match(/new\s+Date\s*\([^)]*\)/g) ?? []).map((c) => ({ rel: f.rel, c })))
    expect(calls.filter(({ rel, c }) => !allowed[rel]?.test(c))).toEqual([])
    expect(calls.some(({ rel }) => rel === 'lib/dates.ts')).toBe(true) // the allowlist is not stale
    expect(calls.some(({ rel }) => rel === 'db/backup.ts')).toBe(true)
  })

  it('keeps dates.ts to the UTC accessors, with no implicit string conversion or Intl', () => {
    // `new Date(<string>)` parsing is covered by the constructor allowlist above (only `new Date(ms)`); this adds the module's own
    // stricter words. It cannot prove `ms` is never a string; the type checker and the behavioural tests cover that.
    const dates = files.find((f) => f.rel === 'lib/dates.ts')?.text ?? ''
    expect(dates.match(/\b(toString|Intl)\b/g) ?? []).toEqual([])
    expect(dates).toMatch(/getUTCFullYear/) // guards against the check passing on an empty file
  })

  it('never reads or formats money as a float', () => {
    expect(matches(/\b(parseFloat|toFixed)\b/g)).toEqual([])
  })

  it('writes no decimal literal and no ** anywhere, and says why where it does', () => {
    // Money and shares are integers; a decimal literal (`+ 0.5` to round, `* 0.01` to take a percent) is one footprint of float
    // arithmetic, and that is how a float rounding helper got past the parseFloat/toFixed rule above. It catches only that
    // spelling: it does NOT catch an exponent literal such as 1e-9, nor integer-looking rounding such as Math.round(n / d),
    // which is the same rounding bug written another way. Both are uncovered; Math.round and Math.ceil have benign call
    // sites that would need allowlisting first, so extending the rule is left to a later plan. This is the whole-tree
    // version of the scan src/learning/bayes.test.ts runs on its own file. It reads the code with comments and strings removed,
    // so a doc comment may mention a decimal. Division is NOT banned here: it is legitimate in too many places, and the rule
    // for it lives per file. file -> why a decimal in its code is not arithmetic.
    const allowed: Record<string, string> = {
      'ui/TransactionEditor.tsx': 'JSX hint copy that shows the example amount -1.850,00 (a thousands separator, not a number)',
    }
    const floatish = /(?<![\w.])\d*\.\d+|\*\*/g
    expect(' x + 0.5 '.match(floatish)).not.toBeNull() // the detector sees the footprint it exists to forbid
    expect(' x * .25 '.match(floatish)).not.toBeNull()
    expect(' x ** 2 '.match(floatish)).not.toBeNull()
    expect(code('const ok = 1 // rounds up by 0.5').match(floatish)).toBeNull() // prose in a comment is not code
    expect(code('const r = floor(q + 0.5)').match(floatish)).not.toBeNull()
    expect(' a[0].b + v1.2x '.match(floatish)).toBeNull() // member access and identifiers are not literals
    const users = files.filter((f) => (f.code.match(floatish) ?? []).length > 0).map((f) => f.rel)
    expect(users.filter((rel) => !(rel in allowed))).toEqual([])
    expect(Object.keys(allowed).filter((rel) => !users.includes(rel))).toEqual([]) // an exemption that is no longer needed
  })

  it('reads the clock only where it is sanctioned, and says why', () => {
    // Everything else takes "today" as an argument, so it can be tested with a fixed date: a new module is covered the moment it
    // exists. Each entry is a file that stamps or supplies "now" at a boundary; none reasons about calendar dates with it.
    const allowed: Record<string, string> = {
      'db/annotations.ts': 'stamps updatedAt and the learning-event time on an owner write',
      'import/commit.ts': 'stamps createdAt / importedAt on the rows of an import',
      'import/pairing.ts': 'stamps matchedAt on a proposed transfer',
      'import/refunds.ts': 'stamps matchedAt on a refund link',
      'ui/routes.tsx': "the one place the app learns today's date, handed down to Budget and WorthIt as a prop",
      'ui/screens/Settings.tsx': 'names the backup file with the UTC day (a file name, not a date the owner reads)',
      'ui/screens/Transactions.tsx': 'stamps deletedAt when the owner deletes a row, and createdAt when the owner names a merchant',
    }
    const users = files.filter((f) => /\bDate\.now\b/.test(f.code)).map((f) => f.rel)
    expect(users.filter((rel) => !(rel in allowed))).toEqual([]) // a clock read nobody sanctioned
    expect(Object.keys(allowed).filter((rel) => !users.includes(rel))).toEqual([]) // an exemption that is no longer needed
  })

  it('keeps the battery out of the learning engine: nothing in src/learning/ imports from src/battery/', () => {
    // Design 7.2: the battery FEEDS NOTHING ELSE. It reads the learning engine's own annotations (rank.ts and
    // contingency.ts both import src/learning/regret.ts) and hands its results to one screen; the arrow never turns
    // round. A statistic that reached the learning engine would let a bracket decide a category, a merchant or a
    // regret cluster, so the engine's behaviour would start depending on how many comparisons the battery happened to
    // run — and a figure the owner was shown as provisional would have quietly become a decision about their money.
    //
    // This rule cannot use `code()`: an import path IS a string literal, and code() replaces every string with ''.
    // Comments are stripped instead, so a doc comment that merely names a battery path (this one does not, on
    // purpose) cannot trip it, and the match is required to be import syntax rather than a bare mention.
    const withoutComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')
    const batteryImport = /\b(?:from|import|require)\s*\(?\s*['"][^'"]*\bbattery\b[^'"]*['"]/g
    const learning = files.filter((f) => f.rel.startsWith('learning/'))
    expect(learning.length).toBeGreaterThan(3) // the scan covers a real directory, not an empty one
    expect(learning.flatMap((f) => (withoutComments(f.text).match(batteryImport) ?? []).map((m) => `${f.rel}: ${m}`))).toEqual([])
    // The detector itself: it must see the imports it exists to forbid, in every spelling, and leave the rest alone.
    for (const bad of [
      "import { BATTERY } from '../battery/battery'",
      "import type { Gate } from '../battery/battery'\n",
      "export { findingFor } from '../../battery/finding'",
      "const m = await import('../battery/rank')",
      "const m = require('../battery/trend')",
    ]) expect(withoutComments(bad).match(batteryImport), bad).not.toBeNull()
    for (const good of [
      "import { db } from '../db/db'",
      "// the engine never imports from '../battery/battery'",
      "/* nothing here reads '../battery/finding' */",
      'const battery = 1',
      "const label = 'battery'",
    ]) expect(withoutComments(good).match(batteryImport), good).toBeNull()
  })

  it('reads db.<table> at call time, never captures it at module scope', () => {
    // A `const t = db.transactions` outside any function would bind the table when the module loads, before a test (or a
    // restore) has replaced the database, and the module would then read a stale handle. This replaces three per-file copies
    // that only checked a string appeared in the source. A top-level const/let/var is flagged when `db` appears in its
    // initialiser before any arrow or `function`, i.e. when it is evaluated at load. file -> why a load-time read is fine.
    const allowed: Record<string, string> = {}
    const topLevelCaptures = (text: string): string[] => {
      const chunks = text.split(/\r?\n(?=(?:export\s+)?(?:const|let|var)\s)/)
      return chunks.flatMap((chunk) => {
        if (!/^(?:export\s+)?(?:const|let|var)\s/.test(chunk)) return []
        const init = chunk.slice(chunk.indexOf('=') + 1)
        const evaluatedAtLoad = init.split(/=>|\bfunction\b/)[0] ?? ''
        // A column-0 line that starts something else (an `export function`, a type) ends the statement.
        const own = evaluatedAtLoad.split(/\r?\n(?=\S)/)[0] ?? ''
        return /\bdb\b/.test(own) ? [chunk.split('\n')[0] ?? chunk] : []
      })
    }
    const offenders = files.filter((f) => topLevelCaptures(f.text).length > 0).map((f) => f.rel)
    expect(offenders.filter((rel) => !(rel in allowed))).toEqual([])
    expect(Object.keys(allowed).filter((rel) => !offenders.includes(rel))).toEqual([]) // an exemption that is no longer needed
    // The detector itself: it must see the capture it exists to forbid, and leave code that reads at call time alone.
    expect(topLevelCaptures('const t = db.transactions\n')).toHaveLength(1)
    expect(topLevelCaptures('export const t = [db.transactions].map((x) => x)\n')).toHaveLength(1)
    expect(topLevelCaptures('const t = () => db.transactions\n')).toEqual([])
    expect(topLevelCaptures('const t = async function () { return db.transactions }\n')).toEqual([])
  })
})
