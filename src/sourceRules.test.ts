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
const files = sourceFiles(SRC).map((path) => ({ rel: relative(SRC, path).split(sep).join('/'), text: readFileSync(path, 'utf8') }))
const matches = (re: RegExp) => files.flatMap((f) => (f.text.match(re) ?? []).map((m) => `${f.rel}: ${m}`))

describe('source rules, over every file in src/', () => {
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
      'ui/screens/Transactions.tsx': 'stamps deletedAt when the owner deletes a row',
    }
    const users = files.filter((f) => /\bDate\.now\b/.test(f.text)).map((f) => f.rel)
    expect(users.filter((rel) => !(rel in allowed))).toEqual([]) // a clock read nobody sanctioned
    expect(Object.keys(allowed).filter((rel) => !users.includes(rel))).toEqual([]) // an exemption that is no longer needed
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
