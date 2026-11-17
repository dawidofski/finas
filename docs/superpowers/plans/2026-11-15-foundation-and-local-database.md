# Foundation and Local Database Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A deployable static PWA shell on GitHub Pages with a versioned local database, exact money and date primitives, seed reference data, and a verified export/restore round-trip.

**Architecture:** React + TypeScript single-page app, hash-routed so every URL resolves without server rewrites, built by Vite with relative asset paths so the same artifact works under any GitHub Pages path. All persistence is Dexie over IndexedDB with explicit schema versions and a migration registry. Money is integer cents in a value module with no floating-point arithmetic anywhere; dates are timezone-independent ISO strings.

**Tech Stack:** React 18.3.1, react-dom 18.3.1, TypeScript 5.5.4, Vite 8.3.8, @vitejs/plugin-react 6.3.0, Dexie 4.0.8, fflate 0.8.3, vite-plugin-pwa 2.0.0, Vitest 5.1.0, fake-indexeddb 6.0.0, @testing-library/react 16.0.1, jsdom 25.0.1, @types/node 24. Build-tool majors were raised from the original draft (Vite 5, Vitest 2, vite-plugin-pwa 0.20) to clear two critical and one high advisory in the dev tree; see the ledger's ruling R8.

**Spec:** `docs/superpowers/specs/2026-11-15-personal-finance-intelligence-design.md`

## Amendment to the spec

Design §7.3 names SheetJS for XLSX parsing. This plan replaces it with
`fflate@0.8.2` plus the platform `DOMParser`, and a focused reader for ING's
own sheet layout. Reasons: the npm `xlsx` package's last published release
carries a known ReDoS advisory and SheetJS has moved distribution off npm;
SheetJS is ~900 KB against fflate's ~8 KB; and the XLSX-as-zip-plus-XML
approach was already validated against the owner's real export before this
plan was written. The parser itself is Plan 2; this plan only records the
dependency decision. No other part of §7.3 changes.

## Global Constraints

- EUR only. All money is integer cents (`number`, signed). No `parseFloat` on a
  monetary value, no floating-point arithmetic in any stored or displayed figure.
- All dates are `YYYY-MM-DD` strings in UTC-independent arithmetic. No `Date`
  method that depends on the local timezone may appear in a date conversion.
- `vite.config.ts` must set `base: './'`. Routing is hash-based (`#/path`).
- No runtime asset, font or script may be fetched from a CDN. Everything is
  bundled and served from the Pages origin.
- No financial record may enter the repository. `.gitignore` must cover
  `*.xlsx`, `*.pdf`, `*.csv`, `*.finbak`, `*.json` export files at the repo root.
- No API key in source. No analytics, no tracking, no telemetry.
- The account number and account holder name must never be written to the
  database in any task.
- Node 24 (current LTS) in CI, matching the development machine's v24.13.0.
  An earlier draft of this plan said Node 20; that was an arbitrary choice of
  mine, not a requirement from the spec, and it blocked the toolchain versions
  that clear two critical advisories. Nothing in the spec constrains the Node
  version, and CI drifting below the dev machine buys nothing.
  Tests gate both the build and the deploy, in two stages:
  `npm test` (unit tests, runnable on a clean checkout — `src/build.test.ts`
  is excluded from it) must pass before `npm run build`, and
  `npm run verify:dist` (which runs `src/build.test.ts` alone against the
  freshly built `dist/`) must pass before the Pages artifact is uploaded.
  A single `npm test` covering both is impossible: the dist assertions
  require a build that has not happened yet on a clean checkout.
- Copy rules: no shaming language, no assumption about the owner's means.
- Target devices: Android Chrome on a Galaxy S26 (390×844 CSS px) and desktop.
- WCAG AA contrast in both themes; no colour-only encoding.

## Review Focus

Failure modes the spec implies that no task's happy-path tests would reach.
Each line names the task that owns its test.

1. **IndexedDB unavailable or blocked** (private window, blocked site data, or
   a browser that denies storage): opening the database throws, and the app
   must render a plain explanatory screen rather than a blank page. — Task 4.
2. **Timezone shifting a date by one day**: a user east or west of UTC must get
   `2026-11-15` from serial `46341` identically. Every date conversion is
   tested under at least two `TZ` values. — Task 3.
3. **Restore of a bundle from a newer schema version than the running app**:
   must be refused whole, with nothing written, rather than partially applied.
   — Task 6.
4. **A stale service worker serving a mix of old and new assets after a
   deploy**: the registration must take over immediately and discard outdated
   caches. — Task 7.
5. **Quota exceeded part-way through a bulk write**: the write must roll back
   whole and surface a storage-full message, leaving the database as it was.
   — Task 6.

---

## File Structure

| File | Responsibility |
|---|---|
| `package.json`, `tsconfig.json`, `tsconfig.node.json` | Toolchain and scripts |
| `vite.config.ts` | Build config, relative base, PWA plugin, Vitest config |
| `index.html` | App host document |
| `.gitignore`, `public/.nojekyll` | Repo hygiene, Pages asset serving |
| `.github/workflows/deploy.yml` | Test → build → deploy to Pages |
| `README.md` | Upload, open, install, backup instructions |
| `src/main.tsx` | Mount point, database init, error boundary |
| `src/App.tsx` | Shell: routing outlet, navigation, theme provider |
| `src/lib/money.ts` | Integer-cent parsing, arithmetic, percent, formatting |
| `src/lib/dates.ts` | Excel serial and Spanish date conversion, month helpers |
| `src/db/schema.ts` | Table row types |
| `src/db/db.ts` | Dexie instance, version registry, open with failure reporting |
| `src/db/migrations.ts` | Ordered migration registry |
| `src/db/seed.ts` | Categories, moods, purchase reasons, settings singleton |
| `src/db/backup.ts` | Export bundle, restore with mode and version gate |
| `src/ui/routes.tsx` | Route table and the 13 screen stubs |
| `src/ui/Nav.tsx` | Bottom tab bar (mobile) and sidebar (desktop) |
| `src/ui/theme.tsx` | Theme context, system preference, manual override |
| `src/ui/StorageError.tsx` | Screen shown when the database cannot open |
| `src/test/setup.ts` | Vitest setup: fake-indexeddb, RTL cleanup |

---

### Task 1: Repository and a build that deploys to GitHub Pages

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.node.json`, `vite.config.ts`, `index.html`, `.gitignore`, `public/.nojekyll`, `src/main.tsx`, `src/App.tsx`, `src/test/setup.ts`, `.github/workflows/deploy.yml`
- Test: `src/build.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `npm run dev`, `npm run build`, `npm test`, `npm run preview`. `App` default export from `src/App.tsx` rendering the literal text `Personal Finance Intelligence`.

- [ ] **Step 1: Initialise the repository and install pinned dependencies**

```bash
cd C:/Users/dawid/Downloads/finance
git init -b main
npm init -y
npm i react@18.3.1 react-dom@18.3.1 dexie@4.0.8 fflate@0.8.2
npm i -D typescript@5.5.4 vite@5.4.8 @vitejs/plugin-react@4.3.1 vite-plugin-pwa@0.20.5 vitest@2.1.1 jsdom@25.0.1 fake-indexeddb@6.0.0 @testing-library/react@16.0.1 @testing-library/jest-dom@6.5.0 @types/react@18.3.5 @types/react-dom@18.3.0
```

- [ ] **Step 2: Write `.gitignore` before anything else is added**

Must contain, at minimum: `node_modules/`, `dist/`, `*.xlsx`, `*.pdf`, `*.csv`, `*.finbak`, `/*.json` with a `!package.json` and `!tsconfig*.json` negation, `.env*`, `.DS_Store`.

- [ ] **Step 3: Write the failing build test**

```ts
// src/build.test.ts
import { readFileSync, existsSync } from 'node:fs'
import { describe, it, expect } from 'vitest'

describe('production build', () => {
  it('emits relative asset URLs so any Pages path works', () => {
    const html = readFileSync('dist/index.html', 'utf8')
    expect(html).toMatch(/(src|href)="\.\/assets\//)
    expect(html).not.toMatch(/(src|href)="\/assets\//)
  })
  it('emits .nojekyll so hashed asset filenames are served', () => {
    expect(existsSync('dist/.nojekyll')).toBe(true)
  })
})
```

- [ ] **Step 4: Run it to confirm it fails**

Run: `npx vitest run src/build.test.ts`
Expected: FAIL — `dist/index.html` does not exist.

- [ ] **Step 5: Write the toolchain and app skeleton**

`vite.config.ts`: `base: './'`, the React plugin, `VitePWA` with
`registerType: 'autoUpdate'`, and a `test` block using `environment: 'jsdom'`,
`setupFiles: ['src/test/setup.ts']`, `globals: true`.
`package.json` scripts: `dev`, `build` (`tsc -b && vite build`), `preview`,
`test` (`vitest run`), `test:watch`.
`tsconfig.json`: `strict: true`, `target: ES2022`, `jsx: react-jsx`,
`moduleResolution: bundler`, `noUncheckedIndexedAccess: true`.
`src/App.tsx` renders an `<h1>` containing `Personal Finance Intelligence`.
`src/main.tsx` mounts it into `#root`.
`src/test/setup.ts` imports `fake-indexeddb/auto` and
`@testing-library/jest-dom/vitest`.

- [ ] **Step 6: Build, then run the test to verify it passes**

Run: `npm run build && npx vitest run src/build.test.ts`
Expected: both tests PASS.

- [ ] **Step 7: Write the deploy workflow**

`.github/workflows/deploy.yml`: trigger on `push` to `main` and
`workflow_dispatch`; `permissions: { contents: read, pages: write, id-token: write }`;
`concurrency: { group: 'pages', cancel-in-progress: false }`; one `build` job
(checkout → `actions/setup-node@v4` with `node-version: 24` and `cache: npm` →
`npm ci` → `npm test` → `npm run build` → `npm run verify:dist` →
`actions/configure-pages@v5` →
`actions/upload-pages-artifact@v3` with `path: dist`) and one `deploy` job
needing it (`actions/deploy-pages@v4`, `environment: github-pages`).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: project skeleton with Pages-compatible build and deploy workflow"
```

---

### Task 2: Money — integer cents

**Files:**
- Create: `src/lib/money.ts`
- Test: `src/lib/money.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  `parseAmountToCents(raw: string): number`,
  `centsToString(cents: number): string`,
  `formatEur(cents: number): string`,
  `sumCents(values: number[]): number`,
  `applyPercentBp(cents: number, bp: number): number`,
  `percentBpOf(part: number, whole: number): number`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest'
import { parseAmountToCents, formatEur, sumCents, applyPercentBp, percentBpOf } from './money'

describe('parseAmountToCents', () => {
  it.each([
    ['-0.1', -10], ['-0.95', -95], ['80', 8000], ['-578.9', -57890],
    ['-12.449999999999999', -1245], ['-1.1000000000000001', -110],
    ['648.95000000000005', 64895], ['645.82000000000005', 64582],
    ['100', 10000], ['-0.02', -2], ['0', 0],
  ])('parses %s to %i cents', (raw, cents) => {
    expect(parseAmountToCents(raw)).toBe(cents)
  })
  it.each(['1.234', '', 'abc', '1,5', null as unknown as string])(
    'rejects %s', (raw) => expect(() => parseAmountToCents(raw)).toThrow())
})

describe('formatEur', () => {
  it.each([[-1245, '-12,45 €'], [8000, '80,00 €'], [0, '0,00 €'], [-2, '-0,02 €']])(
    'formats %i as %s', (c, s) => expect(formatEur(c)).toBe(s))
})

describe('sumCents', () => {
  it('sums signed cents exactly', () => {
    expect(sumCents([-10, -95, -40, -80, -44])).toBe(-269)
  })
  it('returns 0 for an empty list', () => expect(sumCents([])).toBe(0))
  it('throws on a non-integer input', () => expect(() => sumCents([1.5])).toThrow())
})

describe('centsToString', () => {
  it.each([[-1245, '-12.45'], [64895, '648.95'], [0, '0.00'], [-2, '-0.02'], [8000, '80.00']])(
    'renders %i as %s', (c, s) => expect(centsToString(c)).toBe(s))
  it('throws on a non-integer', () => expect(() => centsToString(1.5)).toThrow())
})

describe('applyPercentBp', () => {
  it.each([[200000, 1500, 30000], [240000, 1500, 36000], [100003, 3333, 33331]])(
    '%i cents at %i bp is %i', (c, bp, r) => expect(applyPercentBp(c, bp)).toBe(r))
})

describe('percentBpOf', () => {
  it('returns 1500 for 300 of 2000 euro', () => expect(percentBpOf(30000, 200000)).toBe(1500))
  it('returns 0 when the whole is 0', () => expect(percentBpOf(1, 0)).toBe(0))
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/money.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the six functions in `src/lib/money.ts`**

`parseAmountToCents` works on the string, never on a `number`: match
`/^-?\d+(\.\d+)?$/` and reject anything else. Split on `.` and let `frac` be
the fractional digits. Then exactly two cases:

- **`frac.length <= 2`** — pad to two digits and read as cents. Exact, no
  rounding.
- **`frac.length > 2`** — let `tail = frac.slice(2)`. Accept in two cases and
  reject otherwise:
  1. **`tail` is entirely `0`s, of any length** — a plain trailing-zero
     representation, exact, round down. `"0.950"` → `95`, `"1.200"` → `120`.
     This case matters for CSV imports, which may carry trailing zeros that
     XLSX's shortest-representation numerics never produce.
  2. **`tail` begins with at least nine consecutive `0`s or at least nine
     consecutive `9`s** — IEEE-754 noise around a two-decimal value. A run of
     `0`s rounds the first two digits down (`648.95000000000005` → `64895`); a
     run of `9`s rounds them up (`-12.449999999999999` → `-1245`,
     `-1.1000000000000001` → `-110`).

  Anything else is a genuine sub-cent value and must throw — `1.234` has tail
  `4` and is rejected. Case 1 is not a special case of case 2: a tail of one
  to eight zeros is valid and must not throw, which an earlier draft of this
  rule got wrong. See the ledger's ruling R14.

  Case (b) is intentionally permissive about what follows the run: a tail of
  `"000000000123"` satisfies the nine-zero rule, so `"1.23000000000123"`
  parses to `123` and discards the remainder. That is deliberate — the
  discarded quantity is below 1e-9 of a cent, far beyond any amount a bank
  can represent — and it is recorded here so the behaviour reads as a decision
  rather than an oversight.

The nine-digit threshold is what separates noise from intent: a double has
15–17 significant decimal digits, so noise in a value of this magnitude always
presents as a long run, while a human- or bank-authored third decimal never
does. An earlier draft of this plan proposed accepting any input that
"re-serialises within one cent", which is wrong: `1.234` rounds to `1.23` and
differs by only 0.004, so that rule would have silently accepted sub-cent
amounts. See the ledger's ruling R12.
`formatEur` uses `Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' })`
on `cents / 100` strictly for display, with a non-breaking space normalised to
a plain space. `applyPercentBp` is `Math.round(cents * bp / 10000)` guarded to
integers. All functions throw `TypeError` on non-integer cent inputs.

- [ ] **Step 4: Run to verify the tests pass**

Run: `npx vitest run src/lib/money.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/money.ts src/lib/money.test.ts
git commit -m "feat: integer-cent money primitives"
```

---

### Task 3: Dates — timezone-independent conversion

**Files:**
- Create: `src/lib/dates.ts`
- Test: `src/lib/dates.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  `excelSerialToIso(serial: number): string`,
  `isoToExcelSerial(iso: string): number`,
  `parseSpanishDate(raw: string): string`,
  `monthKeyOf(iso: string): string`,
  `daysBetween(isoA: string, isoB: string): number`,
  `addDays(iso: string, n: number): string`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { excelSerialToIso, isoToExcelSerial, parseSpanishDate, monthKeyOf, daysBetween, addDays } from './dates'

describe.each(['UTC', 'Pacific/Kiritimati', 'Pacific/Niue'])('in timezone %s', (tz) => {
  beforeAll(() => { process.env.TZ = tz })
  it.each([[46341, '2026-11-15'], [46336, '2026-11-10'], [45658, '2025-01-01'], [25569, '1970-01-01']])(
    'serial %i is %s', (s, iso) => expect(excelSerialToIso(s)).toBe(iso))
  it('round-trips every serial in the export range', () => {
    for (let s = 46336; s <= 46341; s++) expect(isoToExcelSerial(excelSerialToIso(s))).toBe(s)
  })
  it('parses the PDF date format', () => expect(parseSpanishDate('15/11/2026')).toBe('2026-11-15'))
})

describe('validation', () => {
  it.each(['2026-11-15', '15-11-2026', '32/01/2026', '15/13/2026', ''])(
    'rejects %s', (raw) => expect(() => parseSpanishDate(raw)).toThrow())
  it.each([0, -1, 1.5, NaN])('rejects serial %s', (s) => expect(() => excelSerialToIso(s)).toThrow())
})

describe('helpers', () => {
  it('month key', () => expect(monthKeyOf('2026-11-15')).toBe('2026-11'))
  it('days between', () => expect(daysBetween('2026-11-10', '2026-11-15')).toBe(5))
  it('crosses a month boundary', () => expect(addDays('2026-11-30', 1)).toBe('2026-12-01'))
  it('crosses a year boundary', () => expect(addDays('2026-12-31', 1)).toBe('2027-01-01'))
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/dates.test.ts` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement in `src/lib/dates.ts`**

Use the identity `serial 25569 = 1970-01-01`: convert with
`Date.UTC`-based arithmetic and read back with `getUTCFullYear` and friends
only — no `getFullYear`, `getMonth`, `getDate`, `toLocaleDateString` or
`new Date(string)` anywhere in this module. Reject serials below 1 and
non-integers. `parseSpanishDate` accepts strictly `dd/mm/yyyy` and validates
the calendar day by round-tripping the constructed UTC date.

- [ ] **Step 4: Run to verify the tests pass**

Run: `npx vitest run src/lib/dates.test.ts` — Expected: PASS in all three timezones.

- [ ] **Step 5: Commit**

```bash
git add src/lib/dates.ts src/lib/dates.test.ts
git commit -m "feat: timezone-independent date primitives"
```

---

### Task 4: Database schema, versioning, and a readable failure when storage is denied

**Files:**
- Create: `src/db/schema.ts`, `src/db/db.ts`, `src/db/migrations.ts`, `src/ui/StorageError.tsx`
- Test: `src/db/db.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `db` (Dexie instance), `SCHEMA_VERSION: number`, `ENGINE_VERSION: number`,
  `openDatabase(): Promise<{ ok: true } | { ok: false; reason: 'blocked' | 'unsupported' | 'corrupt'; detail: string }>`,
  `registerMigration(version: number, upgrade: (tx: Transaction) => Promise<void>): void`,
  and the row types `AccountRow`, `TransactionRow`, `AnnotationRow`,
  `CategoryRow`, `MerchantRow`, `MoodRow`, `PurchaseReasonRow`,
  `BudgetAllocationRow`, `ImportRow`, `TransferRow`, `SavingsGoalRow`,
  `RecurringRow`, `LearningEventRow`, `RecommendationStateRow`,
  `AnalyticsCacheRow`, `SettingsRow` from `src/db/schema.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { db, SCHEMA_VERSION, openDatabase } from './db'

beforeEach(async () => { await db.delete(); await db.open() })

describe('schema v1', () => {
  it('declares every table from the design', async () => {
    expect(db.tables.map(t => t.name).sort()).toEqual([
      'accounts','analyticsCache','annotations','budgetAllocations','categories',
      'imports','learningEvents','merchants','moods','purchaseReasons',
      'recommendationState','recurring','savingsGoals','settings','transactions','transfers',
    ])
  })
  it('opens at the declared version', () => expect(db.verno).toBe(SCHEMA_VERSION))
  it('indexes transactions for the dedup key and the account-date pair', () => {
    const idx = db.table('transactions').schema.indexes.map(i => i.name)
    expect(idx).toContain('dedupKey')
    expect(idx).toContain('[accountId+valueDate]')
  })
  it('enforces uniqueness of the dedup key', async () => {
    const row = { id: 'a', accountId: 'x', valueDate: '2026-11-15', amountCents: -95,
      balanceCents: 9436, description: 'd', kind: 'spend', dedupKey: 'K', importId: 'i', fileSeq: 1, createdAt: 1 }
    await db.table('transactions').add(row)
    await expect(db.table('transactions').add({ ...row, id: 'b' })).rejects.toThrow()
  })
  it('round-trips a transaction unchanged', async () => {
    /* add one row, read it back, expect the same object */
  })
})

describe('openDatabase', () => {
  it('reports ok when storage works', async () => {
    expect(await openDatabase()).toEqual({ ok: true })
  })
  it('reports blocked rather than throwing when indexedDB is denied', async () => {
    const original = globalThis.indexedDB
    // @ts-expect-error simulating a browser that denies storage
    globalThis.indexedDB = { open: () => { throw new DOMException('denied', 'SecurityError') } }
    const result = await openDatabase()
    globalThis.indexedDB = original
    expect(result).toMatchObject({ ok: false, reason: 'blocked' })
  })
  it('reports unsupported when indexedDB is absent', async () => {
    const original = globalThis.indexedDB
    // @ts-expect-error simulating a browser without IndexedDB
    delete globalThis.indexedDB
    const result = await openDatabase()
    globalThis.indexedDB = original
    expect(result).toMatchObject({ ok: false, reason: 'unsupported' })
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/db/db.test.ts` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement the schema**

`src/db/schema.ts` holds only the row types, each field exactly as named in
design §8, with `amountCents`/`balanceCents` as `number`, dates as `string`,
`kind` as `'spend' | 'income' | 'internal' | 'roundup'`, and `deletedAt` as
`number | null`. `src/db/db.ts` declares `SCHEMA_VERSION = 1` and
`ENGINE_VERSION = 1` as separate constants, and a `version(1).stores({...})`
with: `transactions` keyed on `id` and indexed on `&dedupKey`,
`[accountId+valueDate]`, `accountId`, `valueDate`, `importId`, `kind`,
`roundupParentId`, `deletedAt`; `accounts` on `id`, `&fingerprint`;
`annotations` on `&transactionId`, `merchantId`, `moodId`;
`imports` on `id`, `&fileHash`, `accountId`, `importedAt`;
`analyticsCache` on `&key`; `recommendationState` on `&key`;
`settings` on `id`; and `id` plus the obvious foreign keys for the rest.

- [ ] **Step 4: Implement `openDatabase` and the migration registry**

`openDatabase` returns a discriminated result rather than throwing:
`unsupported` when `globalThis.indexedDB` is absent, `blocked` on
`SecurityError`, `InvalidStateError` or a Dexie `MissingAPIError`, `corrupt`
on `VersionError` or `DatabaseClosedError`. `registerMigration(version, fn)`
appends to an ordered array that `db.ts` applies as
`db.version(n).stores(...).upgrade(fn)`; the array is empty at v1 and is the
single place a future version is added.

- [ ] **Step 5: Implement `StorageError.tsx`**

A plain screen taking `reason` and `detail`, stating in the owner's terms that
no financial data can be stored, which cause applies, and the concrete remedy
(leave private browsing, allow site data, or restore from a backup file). No
database access of any kind in this component.

- [ ] **Step 6: Wire `main.tsx` to render `StorageError` instead of the app when the result is not ok**

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run src/db/db.test.ts` — Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/db src/ui/StorageError.tsx src/main.tsx
git commit -m "feat: Dexie schema v1, migration registry, storage failure reporting"
```

---

### Task 5: Seed reference data

**Files:**
- Create: `src/db/seed.ts`
- Test: `src/db/seed.test.ts`

**Interfaces:**
- Consumes: `db`, row types from Task 4.
- Produces: `seedDatabase(): Promise<void>`, `ING_CATEGORY_MAP: ReadonlyArray<{ ing: string; ingSub: string; categoryId: string; kind: CategoryKind }>`, `getSettings(): Promise<SettingsRow>`.

- [ ] **Step 1: Write the failing tests**

```ts
describe('seedDatabase', () => {
  it('is idempotent', async () => {
    await seedDatabase(); const a = await db.table('categories').count()
    await seedDatabase(); expect(await db.table('categories').count()).toBe(a)
  })
  it('maps every ING pair seen in the real export', async () => {
    await seedDatabase()
    for (const pair of [
      ['Ahorro','Redondeo'], ['Alimentación','Supermercados y alimentación'],
      ['Compras','Compras (otros)'], ['Compras','Mascotas y veterinario'],
      ['Educación y salud','Farmacia, herbolario y nutrición'],
      ['Hogar','Mantenimiento del hogar'],
      ['Movimientos excluidos','Traspaso entre cuentas'],
      ['Ocio y viajes','Cafeterías y restaurantes'],
      ['Ocio y viajes','Libros, música y videojuegos'],
      ['Otros gastos','Otros gastos (otros)'], ['Otros gastos','Transferencias'],
      ['Vehículo y transporte','Taxis y Carsharing'],
    ]) expect(ING_CATEGORY_MAP.find(m => m.ing === pair[0] && m.ingSub === pair[1])).toBeDefined()
  })
  it('classifies the round-up and transfer categories correctly', async () => {
    await seedDatabase()
    expect(ING_CATEGORY_MAP.find(m => m.ingSub === 'Redondeo')!.kind).toBe('savings')
    expect(ING_CATEGORY_MAP.find(m => m.ingSub === 'Traspaso entre cuentas')!.kind).toBe('internal')
  })
  it('seeds the twelve suggested moods with valence', async () => {
    await seedDatabase()
    const moods = await db.table('moods').toArray()
    expect(moods.map(m => m.label)).toEqual(['Happy','Excited','Relaxed','Satisfied','Neutral','Sad','Stressed','Anxious','Bored','Frustrated','Guilty','Other'])
    expect(moods.find(m => m.label === 'Happy')!.valence).toBeGreaterThan(0)
    expect(moods.find(m => m.label === 'Stressed')!.valence).toBeLessThan(0)
    expect(moods.find(m => m.label === 'Other')!.valence).toBeNull()
  })
  it('seeds the eight purchase reasons', async () => {
    await seedDatabase()
    expect((await db.table('purchaseReasons').toArray()).map(r => r.label)).toEqual(
      ['Essential','Planned','Impulse','Convenience','Social pressure','Reward','Emotional spending','Other'])
  })
  it('creates a settings singleton with a 32-byte account salt that is stable', async () => {
    await seedDatabase(); const first = await getSettings()
    expect(first.privacy.accountSalt).toMatch(/^[0-9a-f]{64}$/)
    await seedDatabase(); expect((await getSettings()).privacy.accountSalt).toBe(first.privacy.accountSalt)
  })
  it('defaults theme to system and stores no account identifiers', async () => {
    await seedDatabase(); const s = await getSettings()
    expect(s.theme).toBe('system')
    expect(JSON.stringify(s)).not.toMatch(/[0-9]{8,}/)
  })
})
```

- [ ] **Step 2: Run to verify failure** — Expected: FAIL, module not found.

- [ ] **Step 3: Implement `seedDatabase`**

Stable string ids (`cat.groceries`, `mood.happy`) so seeds are idempotent by
primary key. Category `kind` is one of `'essential' | 'discretionary' |
'savings' | 'internal' | 'income'`; seed groceries, pharmacy, household
maintenance and transport as `essential`, restaurants, books/music/games and
other shopping as `discretionary`, `Redondeo` as `savings`, `Traspaso entre
cuentas` as `internal`. The account salt is 32 bytes from
`crypto.getRandomValues` hex-encoded, written once and never regenerated.

- [ ] **Step 4: Run to verify the tests pass** — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/seed.ts src/db/seed.test.ts
git commit -m "feat: seed categories, moods, purchase reasons and settings"
```

---

### Task 6: Export and restore

**Files:**
- Create: `src/db/backup.ts`
- Test: `src/db/backup.test.ts`

**Interfaces:**
- Consumes: `db`, `SCHEMA_VERSION`, `seedDatabase`.
- Produces:
  `exportBundle(): Promise<Bundle>` where
  `Bundle = { format: 'finance-export'; schemaVersion: number; exportedAt: string; tables: Record<string, unknown[]> }`;
  `restoreBundle(bundle: unknown, mode: 'merge' | 'replace'): Promise<RestoreReport>`;
  `inspectBundle(bundle: unknown): RestoreReport` (dry run, writes nothing);
  `RestoreReport = { ok: boolean; refusedReason?: 'format' | 'newer-schema' | 'malformed'; perTable: Record<string, { incoming: number; willWrite: number; conflicts: number }> }`.

- [ ] **Step 1: Write the failing tests**

```ts
describe('export/restore', () => {
  it('round-trips every table byte-for-byte', async () => {
    await seedDatabase(); /* add 2 accounts, 5 transactions, 3 annotations */
    const bundle = await exportBundle()
    await db.delete(); await db.open()
    const report = await restoreBundle(bundle, 'replace')
    expect(report.ok).toBe(true)
    expect(await exportBundle()).toEqual({ ...bundle, exportedAt: expect.any(String) })
  })
  it('refuses a bundle from a newer schema version and writes nothing', async () => {
    await seedDatabase()
    const before = await db.table('categories').count()
    const report = await restoreBundle({ format: 'finance-export', schemaVersion: SCHEMA_VERSION + 1, exportedAt: '', tables: { categories: [] } }, 'replace')
    expect(report).toMatchObject({ ok: false, refusedReason: 'newer-schema' })
    expect(await db.table('categories').count()).toBe(before)
  })
  it.each([null, {}, { format: 'other' }, { format: 'finance-export' }])(
    'refuses malformed bundle %j', async (b) => {
      expect((await restoreBundle(b, 'replace')).ok).toBe(false)
    })
  it('inspectBundle writes nothing', async () => {
    await seedDatabase(); const before = await exportBundle()
    inspectBundle(await exportBundle())
    expect(await exportBundle()).toEqual({ ...before, exportedAt: expect.any(String) })
  })
  it('merge keeps an existing annotation and reports the conflict', async () => {
    /* annotate transaction t1 locally, restore a bundle whose t1 annotation differs,
       expect the local annotation intact and perTable.annotations.conflicts === 1 */
  })
  it('rolls back the whole restore when a write fails mid-way', async () => {
    await seedDatabase(); const before = await db.table('transactions').count()
    const bundle = await exportBundle()
    bundle.tables.transactions = [validRow(), { id: 'bad' }]   // second row violates the schema
    expect((await restoreBundle(bundle, 'replace')).ok).toBe(false)
    expect(await db.table('transactions').count()).toBe(before)
  })
  it('surfaces a storage-full failure as a refusal, not a crash', async () => {
    /* stub bulkPut to reject with a QuotaExceededError DOMException,
       expect ok false and the database unchanged */
  })
})
```

- [ ] **Step 2: Run to verify failure** — Expected: FAIL, module not found.

- [ ] **Step 3: Implement `exportBundle`, `inspectBundle`, `restoreBundle`**

All three enumerate `db.tables` so a table added in a later schema version is
covered without editing this file. `restoreBundle` validates the envelope
first, refuses when `bundle.schemaVersion > SCHEMA_VERSION`, and performs every
write inside a single `db.transaction('rw', db.tables, ...)` so any failure —
schema violation or `QuotaExceededError` — rolls the whole restore back. In
`merge` mode an existing `annotations` row always wins over the incoming one
and increments `conflicts`; all other tables are keyed upserts.

- [ ] **Step 4: Run to verify the tests pass** — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/backup.ts src/db/backup.test.ts
git commit -m "feat: database export, dry-run inspection and atomic restore"
```

---

### Task 7: Shell — routing, navigation, theme, PWA

**Files:**
- Create: `src/ui/routes.tsx`, `src/ui/Nav.tsx`, `src/ui/theme.tsx`
- Modify: `src/App.tsx`, `src/main.tsx`, `vite.config.ts`, `index.html`
- Test: `src/ui/shell.test.tsx`

**Interfaces:**
- Consumes: `getSettings`, `db`.
- Produces: `ROUTES: ReadonlyArray<{ path: string; title: string; element: ReactNode; primary: boolean }>`,
  `useTheme(): { theme: 'system'|'light'|'dark'; resolved: 'light'|'dark'; setTheme(t): void }`,
  `useRoute(): { path: string; navigate(path: string): void }`.

- [ ] **Step 1: Write the failing tests**

```tsx
describe('shell', () => {
  it('declares all thirteen screens', () => {
    expect(ROUTES.map(r => r.path)).toEqual([
      '/', '/import', '/transactions', '/budget', '/intelligence', '/mood',
      '/learning', '/coach', '/goals', '/recurring', '/reports', '/score', '/settings'])
  })
  it('renders the screen named by the hash', async () => {
    window.location.hash = '#/transactions'
    render(<App />)
    expect(await screen.findByRole('heading', { name: /transactions/i })).toBeInTheDocument()
  })
  it('falls back to the dashboard for an unknown hash', async () => {
    window.location.hash = '#/nope'
    render(<App />)
    expect(await screen.findByRole('heading', { name: /dashboard/i })).toBeInTheDocument()
  })
  it('navigating updates the hash and the screen without a reload', async () => { /* click a nav item */ })
  it('exposes exactly five primary destinations for the mobile tab bar', () => {
    expect(ROUTES.filter(r => r.primary)).toHaveLength(5)
  })
  it('persists a theme override to settings and applies it to the document', async () => {
    await seedDatabase(); render(<App />)
    /* set theme to dark; expect documentElement dataset.theme === 'dark'
       and getSettings().theme === 'dark' */
  })
  it('resolves system theme from prefers-color-scheme', () => { /* matchMedia stub */ })
})
```

- [ ] **Step 2: Run to verify failure** — Expected: FAIL, module not found.

- [ ] **Step 3: Implement the shell**

Hash routing is hand-rolled in `useRoute` over `hashchange` — no router
dependency, since the route table is flat and this keeps the bundle and the
Pages behaviour trivial. Each of the thirteen screens is a stub component
rendering its `<h1>` title and the text `Not built yet`, so later plans replace
one file each. The five `primary` routes are `/`, `/import`, `/transactions`,
`/budget`, `/intelligence`. `useTheme` reads the stored preference, falls back
to `matchMedia('(prefers-color-scheme: dark)')`, writes
`document.documentElement.dataset.theme`, and persists overrides to settings.
CSS custom properties define both palettes; contrast pairs must meet WCAG AA.

- [ ] **Step 4: Configure the PWA and the stale-cache test**

In `vite.config.ts`, `VitePWA` with `registerType: 'autoUpdate'`,
`workbox.clientsClaim: true`, `workbox.skipWaiting: true`,
`workbox.cleanupOutdatedCaches: true`, and a manifest naming the app, both
icon sizes, `display: 'standalone'`, `theme_color`, and
`start_url: '.'` with `scope: '.'` so it installs correctly under a Pages
subpath. Add to `src/build.test.ts`:

```ts
it('generates a service worker that claims clients and cleans old caches', () => {
  const sw = readFileSync('dist/sw.js', 'utf8')
  expect(sw).toMatch(/clientsClaim/)
  expect(sw).toMatch(/cleanupOutdatedCaches/)
})
it('scopes the manifest relatively so a Pages subpath installs', () => {
  const m = JSON.parse(readFileSync('dist/manifest.webmanifest', 'utf8'))
  expect(m.start_url).toBe('.')
  expect(m.scope).toBe('.')
})
```

- [ ] **Step 5: Run the full suite and build**

Run: `npm test && npm run build && npx vitest run src/build.test.ts`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: app shell with hash routing, themes and installable PWA"
```

---

### Task 8: README and verified deployment

**Files:**
- Create: `README.md`
- Test: manual verification, recorded in the README

**Interfaces:**
- Consumes: the workflow from Task 1.
- Produces: the owner-facing instructions.

- [ ] **Step 1: Write `README.md`**

Four short sections, no tutorial prose: **Put it on GitHub** (create an empty
repository, `git remote add origin`, `git push -u origin main`); **Turn on
Pages** (Settings → Pages → Source → "GitHub Actions" — the one manual step,
done once); **Open and install it** (the `https://<user>.github.io/<repo>/`
URL, then Chrome's "Add to Home screen" on Android); **Back up your data**
(Settings → export, where the file goes, how to restore, and the plain warning
that browser storage is not encrypted and clearing site data destroys the
history). Add a "What stays on your device" paragraph listing what never
leaves and the single outbound call the app can make.

- [ ] **Step 2: Verify the production build locally**

Run: `npm run build && npm run preview`
Expected: the app loads at the preview URL, navigation and refresh both work on
every route, and the theme toggle persists across a reload.

- [ ] **Step 3: Verify the deployed site**

After the owner has pushed and enabled Pages: load the live URL, confirm the
shell renders, navigate to `#/transactions`, refresh, and confirm it still
resolves. Record the verified URL in the README. **Deployment is not described
as working until this step has actually been performed.**

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: upload, install and backup instructions"
```

---

## Self-Review

**Spec coverage.** This plan covers design §6 (constraints), §7.1 (the durable/
cache split is expressed in the schema: `analyticsCache` carries
`engineVersion` and `inputsHash`), §7.3 (stack, with the amendment recorded
above), §8 (full schema and the immutable-transaction/annotation-override
split), §14.3 in part (plain export, restore with dry run and version gate —
encrypted backup is Plan 5), §15 in part (thirteen routes, themes, PWA,
accessibility baseline), §16 in part (money, dates, migrations, export/restore
round-trip), §17 (deployment) and §18 stages 1–2. Deliberately out of scope
here and owned by later plans: the import pipeline and parsers (§9, §5,
Plan 2), transactions management (§8.1 UI, Plan 2), income and budgeting
(§10, Plan 3), mood capture (§15, Plan 3), the learning engine (§11, Plan 4),
statistics (§12, Plan 4), recommendations, score, goals and recurring (§13,
Plan 4), encrypted backup, DeepSeek and CSV (§13.5, §14.3, Plan 5).

**Gaps found and fixed while reviewing.** Three Review Focus items had no
owning test when first drafted and now do: the storage-denied path (Task 4,
steps 1 and 5), quota exhaustion mid-write (Task 6), and stale service worker
caches (Task 7, step 4). The timezone item was strengthened from one test to a
`describe.each` over three zones. The newer-schema refusal was already
covered.

**Type consistency.** `kind` is `'spend' | 'income' | 'internal' | 'roundup'`
in Tasks 4, 5 and 6. Category `kind` is the distinct
`'essential' | 'discretionary' | 'savings' | 'internal' | 'income'` — these two
unions share a name across different row types deliberately and are never
assigned to each other. `amountCents`, `balanceCents`, `percentBp` and
`valueDate` are spelled identically in every task. `SCHEMA_VERSION` is used by
Tasks 4 and 6; `ENGINE_VERSION` is defined in Task 4 and first consumed in
Plan 4.

**Proportion.** The plan is shorter than the spec. Function bodies appear
nowhere; the only code blocks are tests with the spec's exact values, shell
commands, and config assertions.
