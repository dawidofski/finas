# Analytics Cache, Dashboard and Reports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the figures the app already computes into screens the owner reads — a dashboard and a reports screen that open instantly, backed by a cache that cannot serve a number computed by an older formula.

**Architecture:** A new `src/analytics/` directory. One cache module wraps every derived figure: each entry carries an `engineVersion` and an `inputsHash`, and a miss on either recomputes. The three durable classes — imported transactions, owner annotations, learning state — are never written by anything here (§7.1). Charts are **inline SVG**, not a charting library (ruling below). Each screen shows at most one chart plus its reading (§13.1).

**Tech Stack:** React 18.3.1, TypeScript 5.5.4 (`strict`, `noUncheckedIndexedAccess`), Vite 8.3.8, Dexie 4.0.8, Vitest 5.1.0. **No new runtime dependency.**

**Spec:** `docs/superpowers/specs/2026-11-15-personal-finance-intelligence-design.md` — §7.1 (the hybrid cache), §13.1 (what the dashboard and reports show), §19 (what is left to the builder), §31.3 (a restore clears the cache), §39.4 (bounded reads), §41 (the bank's date and amount). Build-order stage 9.

## Scope boundary, stated so it is not discovered later

This plan is **stage 9 only**: the cache, the dashboard, the reports screen, and the descriptive figures they show. The **statistical battery of §12** — the ten pre-declared tests, their minimum-sample gating, Benjamini–Hochberg correction and effect sizes — is stage 10 and becomes Plan 6. The two are separable because §12's battery is a fixed set of inferential tests over the same data, and §7.2 states it never feeds anything else.

The line between them, so no task guesses: **this plan reports what happened; Plan 6 reports whether a pattern is significant.** Counts, sums, medians, shares, month-on-month differences and a robust outlier threshold are here. Anything with a p-value, a confidence band or a correction across tests is Plan 6. `unusual spending` (§13.1) is here because a robust z-score against the owner's own history is a threshold, not a hypothesis test.

Out of scope and why: **recurring expenses and subscription cost** (§13.1) need recurring detection, which is build-order stage 13; the dashboard will omit that panel rather than fake it.

## Rulings carried into this plan

- **`R-A: charts are inline SVG; no charting library.`** §7.3 names ECharts. I am deviating, and the decisive reason is testability: ECharts renders to canvas, so none of the chart logic would be assertable in jsdom, and this project's standard is that every rule has a test that fails when the rule is removed. Inline SVG lets a test assert that a bar's height is proportional to its value and that the accessible description matches the data. Three supporting reasons: §13.1 asks for one simple chart per screen, not an interactive platform; the app has **four** runtime dependencies today and a 396 KiB precache, and ECharts would roughly triple it on a phone-first offline PWA; and every dependency added to an app holding financial records is supply-chain surface the owner did not ask for. §19 already leaves chart types to the builder. — Cost if wrong: hand-written SVG for a chart type that later needs interaction, which is a day's work to replace.
- **`R-B: the cache is keyed by a hash of counts and high-water marks, with a manual rebuild as the backstop.`** `inputsHash` is a digest over the live transaction count, the soft-deleted count, the annotation count and the maximum `annotations.updatedAt`. Any write in the app moves at least one of those. Two different edits inside the same millisecond that leave every count equal would collide — that is why §7.1's "rebuild analytics" action is a required part of this plan and not a nicety. State the collision case in the code. — Cost if wrong: a stale panel until the owner rebuilds, which the screen offers.
- **`R-C: a cache miss computes, it never serves a stale number.`** There is no "serve stale while recomputing". A figure the owner reads is either current or absent with a reason.
- **`R-D: every figure here buckets by the bank's `valueDate` and uses the bank's amount and sign (§41); only the classifications are the owner's.** `kind` follows the owner's correction, through `treatmentOf`, exactly as §43 settled. Do not re-derive that rule — read it from `src/analysis/income.ts`.

## Global Constraints

- **No schema change.** `analyticsCache` already exists as `'&key'` with `{ key, engineVersion, inputsHash, computedAt, payload }`. §29 forbids any Dexie version above 1 until two prerequisite gates are built, and this plan does not need one. If a task appears to need an index, stop and report it.
- **All money is integer cents; all ratios and percentages are basis points.** No floats. `parseFloat`, `toFixed` and `**` are banned in `src/`, as is `/` on a money value outside a named integer-rounding helper. A median, a MAD and a z-score are all computable in integers — do it.
- **All dates are ISO `YYYY-MM-DD` UTC strings.** `new Date(...)`, `Date.now` and local-timezone `Date` methods are banned in `src/` outside the named allowlists in `src/sourceRules.test.ts`. Pure modules take `today` as an argument; screens take it as a prop, as `WorthIt.tsx` does.
- **Screens must not read the whole `transactions` table** (§39.4). Every panel reads the cache, and the cache's own computation is the only place a wide read is allowed — say so in a comment where it happens.
- **A restore clears the cache** (§31.3) and `src/db/backup.ts` already does it. Do not add a second mechanism.
- **Owner-facing dates are Spanish dd/MM/yyyy** via `formatSpanishDate`; money via `formatEur`, never hand-written.
- **No causal language** in any reading (§12 prohibits it in finding templates; §13.1's readings are the same species). Describe what was counted.
- **A test for a rule must fail when the rule is removed.** Verify every test by mutation, confirm the file actually changed before trusting the result, and after writing each test ask what else could make it green. On the previous plan, eight of nine tasks each found a test of their own that pinned nothing.
- **Every function a task produces must have a caller outside its own tests** by the end of the plan. This is the check whose absence made the previous plan's headline feature unreachable.

## Review Focus

- **A month with no data at all**, between two months that have data — the trend series must show a real gap rather than interpolating or dropping it.
- **The owner's first month**, where every month-on-month comparison has no predecessor. Every panel must say what is missing rather than render a 100% change or a zero.
- **A single category holding one transaction**, where a median and a MAD are degenerate: MAD of zero makes a robust z-score divide by zero. Every outlier test must stay silent, not report infinite unusualness.
- **A cache entry written by an older engine version** — it must be recomputed, not served, and the test must prove the old payload never reaches a screen.
- **A soft-deleted transaction, and then its restore.** Both change the figures and both must change `inputsHash`, or the dashboard shows pre-deletion numbers.

---

### Task 1: The cache

**Files:** Create `src/analytics/cache.ts`, `src/analytics/cache.test.ts`

**Interfaces:**
- Consumes: `db.analyticsCache`, and `sha256Hex(bytes: Uint8Array): Promise<string>` from **`src/lib/hash.ts`** — note it takes bytes, not a string, so encode first; `src/import/normalise.ts` already does this for the duplicate key and is the pattern to copy.
- Produces:
```ts
export const ENGINE_VERSION = 1
export async function inputsHash(): Promise<string>
export async function cached<T>(key: string, compute: () => Promise<T>): Promise<T>
export async function rebuildAnalytics(): Promise<number>   // entries cleared
```

- [ ] **Step 1: Write the failing tests**

```ts
it('computes on a miss and serves the stored payload on a hit', async () => {})
it('recomputes when the engine version has moved on, and never serves the old payload', async () => {})
it('recomputes when a transaction is added, soft-deleted, or restored', async () => {})
it('recomputes when an annotation changes', async () => {})
it('keeps entries for other keys when one key recomputes', async () => {})
it('rebuildAnalytics clears every entry and reports how many it cleared', async () => {})
it('does not write to transactions, annotations or learningEvents', async () => {})
```

The second test must assert the **old payload is not returned**, not merely that `computedAt` moved — serving a stale number is the defect this module exists to prevent. The last is a source-text assertion in the style of `src/sourceRules.test.ts`.

- [ ] **Step 2: Run them and watch each fail.**
- [ ] **Step 3: Implement.** `inputsHash` per ruling R-B, with the collision case named in a comment. `cached` computes on any mismatch and stores `{ key, engineVersion, inputsHash, computedAt, payload }`.
- [ ] **Step 4: Run the tests and the global source guards.**
- [ ] **Step 5: Verify by mutation** — compare only `engineVersion` and not `inputsHash`; the add/delete/restore test must redden.
- [ ] **Step 6: Commit** — `feat: an analytics cache that cannot serve a number from an older formula`

---

### Task 2: The monthly summary

**Files:** Create `src/analytics/monthly.ts`, `src/analytics/monthly.test.ts`

**Interfaces:**
- Consumes: `monthlyBudget` (`src/budget/month.ts`), `netIncome` (`src/analysis/income.ts`), `cached` (Task 1).
- Produces:
```ts
export interface MonthSummary {
  month: string                 // YYYY-MM
  incomeCents: number
  spentCents: number
  savedCents: number
  essentialCents: number
  discretionaryCents: number
  uncategorisedCents: number
  netCents: number              // income − spent − saved
  provisional: boolean          // the income basis is not an observation of this month
  transactions: number
}
export async function monthSummary(month: string, today: string): Promise<MonthSummary>
```

- [ ] **Step 1: Write the failing tests**

```ts
it('reports income, spending, savings and the split, all from the bank amounts', async () => {})
it('marks a month provisional when its income is an estimate, and says so on a zero', async () => {})
it('counts uncategorised spending separately rather than folding it into discretionary', async () => {})
it('returns a real zero for a month with no transactions, distinguishable from no such month', async () => {})
it('sums to the total: essential + discretionary + uncategorised equals spentCents', async () => {})
it('does not change when the owner corrects an amount or a date (§41)', async () => {})
```

The fifth is the conservation property for this module and must hold by construction. The sixth is the §41 trap: write it with **both** an `amountCentsOverride` and a `dateOverride` so it cannot pass on one rule alone.

- [ ] Steps 2–6 as Task 1, committing `feat: one month's figures, cached`.

---

### Task 3: The month series — trends and month-on-month

**Files:** Create `src/analytics/series.ts`, `src/analytics/series.test.ts`

**Interfaces:**
- Produces:
```ts
export interface MonthPoint extends MonthSummary { hasData: boolean }
export async function monthSeries(from: string, to: string, today: string): Promise<MonthPoint[]>
export interface Change { cents: number; bp: number | null; basis: 'month' | 'none' }
export function changeFrom(previous: MonthSummary | null, current: MonthSummary, field: keyof MonthSummary): Change
```

`bp` is `null` when there is no previous month or the previous value is zero — a percentage against nothing is the confident-zero defect this project has fixed four times.

- [ ] **Step 1: Write the failing tests**

```ts
it('returns every month in the range, including one with no data, marked hasData false', async () => {})
it('never interpolates a missing month', async () => {})
it('reports a change in cents always, and in basis points only when there is a basis', () => {})
it('reports no basis for the first month rather than a 100% rise', () => {})
it('orders oldest first, and the order does not depend on the read order', async () => {})
```

The first two are Review Focus item 1. The fourth is item 2.

- [ ] Steps 2–6, committing `feat: a month series that shows a gap as a gap`.

---

### Task 4: Unusual spending, by the owner's own history

**Files:** Create `src/analytics/unusual.ts`, `src/analytics/unusual.test.ts`

**Interfaces:**
- Produces:
```ts
export interface Unusual {
  transactionId: string; categoryId: string | null; cents: number; month: string
  medianCents: number; madCents: number; scoreBp: number   // robust z-score in basis points
}
export function unusualIn(rows: { id: string; categoryId: string | null; cents: number; month: string }[], minSample: number): Unusual[]
```

Median and MAD in **integer cents**; the score as basis points via an integer rounding helper. §13.1 says "against the owner's own per-category history" — never an absolute threshold.

- [ ] **Step 1: Write the failing tests**

```ts
it('finds a purchase far above the owner usual spend in that category', () => {})
it('says nothing for a category with fewer rows than the minimum sample', () => {})
it('says nothing when the deviation is zero, instead of dividing by it', () => {})
it('is unaffected by one extreme value, which a mean-based score would not be', () => {})
it('compares each category only against itself', () => {})
it('uses no floating-point arithmetic', () => {})
```

The third is Review Focus item 3 and the most important test in this task: a MAD of zero must produce silence, never an infinite or NaN score. The fourth is the reason §12 chose non-parametric statistics — pin it with a dataset where a mean would flag the wrong row.

- [ ] Steps 2–6, committing `feat: unusual spending, judged against the owner own history`.

---

### Task 5: Small purchases and the days after payday

**Files:** Create `src/analytics/habits.ts`, `src/analytics/habits.test.ts`

**Interfaces:**
- Produces:
```ts
export async function smallPurchases(month: string, ceilingCents: number): Promise<{ count: number; totalCents: number; medianCents: number }>
export async function afterPayday(month: string): Promise<{ dayOffset: number; spentCents: number; transactions: number }[] | null>
```

`afterPayday` returns `null` when the month holds no income event — §13.1 wants the pattern, and with no payday there is no pattern, which is different from a flat one.

- [ ] **Step 1: Write the failing tests**

```ts
it('adds up the purchases under the ceiling and reports what they came to', async () => {})
it('reports the median as well as the total, so one large row cannot masquerade as many small ones', async () => {})
it('groups spending by days since the income arrived, using the bank dates', async () => {})
it('returns null when no income arrived that month, rather than an empty pattern', async () => {})
it('counts a day with no spending as zero rather than omitting it', async () => {})
```

- [ ] Steps 2–6, committing `feat: small purchases and the days after payday`.

---

### Task 6: Mood, reason and worthwhile — described, not tested

**Files:** Create `src/analytics/annotated.ts`, `src/analytics/annotated.test.ts`

**Interfaces:**
- Produces `moodBreakdown`, `reasonBreakdown`, `worthwhileBreakdown`, each returning rows of `{ key, label, transactions, totalCents, answeredOf }`.

**This task reports counts and sums only.** No correlation, no significance, no effect size — those are Plan 6. Every row carries its denominator (`answeredOf`), because a share without one is the defect the regret screen already rules on.

- [ ] **Step 1: Write the failing tests**

```ts
it('reports spending by mood, with how many spends carried a mood at all', async () => {})
it('reports spending by purchase reason, with its denominator', async () => {})
it('reports worth-it against not-worth-it, counting only answered purchases', async () => {})
it('labels a removed mood or reason rather than showing an id', async () => {})
it('says nothing about cause, in any label or reading', async () => {})
it('excludes income and transfers, so only choices the owner made are described', async () => {})
```

The fifth asserts against a regex covering causal wording, as `src/learning/categorise.test.ts` does.

- [ ] Steps 2–6, committing `feat: describe spending by mood, reason and hindsight`.

---

### Task 7: Chart primitives, in inline SVG

**Files:** Create `src/ui/charts/Bars.tsx`, `src/ui/charts/Line.tsx`, `src/ui/charts/charts.test.tsx`

**Interfaces:**
- Produces two components taking `{ points: { label: string; cents: number }[]; title: string; today?: string }` and rendering accessible inline SVG.

Requirements that are the point of ruling R-A, and each one is a test:
- the geometry is **proportional to the data** — a bar twice the value is twice the length;
- every chart carries a text alternative that states the figures, so the chart is not the only way to read them (and a screen reader gets the numbers);
- a zero value renders visibly as zero, not as a missing bar;
- a negative value renders on the correct side of the baseline;
- an empty series renders the empty state, not an axis with nothing on it;
- it works at 320 px wide, the narrowest phone this app targets.

- [ ] **Step 1: Write the failing tests**

```ts
it('draws a bar proportional to its value', () => {})
it('states the same figures in text, so the chart is not the only way to read them', () => {})
it('shows a zero as zero and a negative below the baseline', () => {})
it('renders an empty state for an empty series', () => {})
it('lays out without overflow at 320px', () => {})
```

- [ ] Steps 2–6, committing `feat: proportional, readable charts without a charting library`.

---

### Task 8: The Dashboard screen

**Files:** Create `src/ui/screens/Dashboard.tsx`, `src/ui/screens/Dashboard.test.tsx`; modify `src/ui/routes.tsx` (replace `screen('/', 'Dashboard', true)` with an explicit route, keeping `primary: true`), and `README.md` ("Seven of the fourteen" becomes eight).

`/` is currently a `<Stub>` and is the **first screen the owner sees**. Follow `src/ui/screens/Budget.tsx` for loading, the empty state and the not-enough-data voice.

- [ ] **Step 1: Write the failing tests**

```ts
it('says plainly that there is nothing yet on a fresh install, and how to begin', async () => {})
it('shows this month income, spending, savings and the net, with Spanish dates', async () => {})
it('shows a change against last month only when there is a last month', async () => {})
it('marks a provisional income figure as an estimate wherever it appears', async () => {})
it('reads the cache rather than the transactions table', async () => {})
it('offers no control that does nothing, and keeps focus when a control is used', async () => {})
```

The fifth spies on `db.transactions` and is the §39.4 guard for this screen. The sixth is P3-R32 and P3-R33.

- [ ] Steps 2–6, committing `feat: the dashboard, reading the cache`.

---

### Task 9: The Reports screen

**Files:** Create `src/ui/screens/Reports.tsx`, `src/ui/screens/Reports.test.tsx`; modify `src/ui/routes.tsx` and `README.md` (eight becomes nine).

One chart plus its reading per panel (§13.1). Panels: the month series, the category breakdown, essential versus discretionary, unusual spending, small purchases, the days after payday, and the mood/reason/hindsight descriptions. **Omit recurring expenses** and say in a comment that it waits on recurring detection, rather than leaving an empty panel.

- [ ] **Step 1: Write the failing tests**

```ts
it('shows each panel with its reading, and never a chart alone', async () => {})
it('states what is missing for a panel that has too little data', async () => {})
it('uses no causal wording in any reading', async () => {})
it('is navigable by keyboard through every panel', async () => {})
it('reads the cache, not the transactions table', async () => {})
```

- [ ] Steps 2–6, committing `feat: the reports screen`.

---

### Task 10: Rebuild analytics, and make the engine version visible

**Files:** Modify `src/ui/screens/Settings.tsx` and `src/ui/screens/Settings.test.tsx`

§7.1 promises an "always-safe rebuild analytics action", and ruling R-B makes it the backstop for a hash collision rather than a convenience. §19 also requires derived-figure machinery to be surfaced rather than hidden.

- [ ] **Step 1: Write the failing tests**

```ts
it('rebuilds the analytics and says how many figures were cleared', async () => {})
it('touches no transaction, annotation or learning event when it rebuilds', async () => {})
it('says what the action is for, without jargon', async () => {})
it('keeps focus on the control and does not leave it stuck busy', async () => {})
```

The second is the §7.1 guarantee and the reason this action is safe to offer at all — assert the three durable tables are byte-identical afterwards.

- [ ] Steps 2–6, committing `feat: a rebuild that cannot touch anything the owner wrote`.

---

## Self-review, run before dispatch

1. **Spec coverage.** §7.1 → Tasks 1, 10. §13.1 → Tasks 2–9, minus recurring (stated). §31.3 → already in `backup.ts`, Task 1 must not duplicate it. §39.4 → Tasks 8, 9. §41 → Task 2's sixth test. §19's "surfaced in the UI" → Task 10.
2. **Every produced function has a consumer:** Task 1 → 2, 3, 10. Task 2 → 3, 8, 9. Task 3 → 8, 9. Tasks 4, 5, 6 → 9. Task 7 → 8, 9. Task 10 → the Settings screen. **Run the grep before dispatching Task 1** — this is the check whose absence made Plan 4's headline feature unreachable.
3. **Type consistency:** `MonthSummary` is defined in Task 2 and extended in Task 3; `Change.bp` is `number | null` everywhere; `scoreBp` is basis points, never a ratio.
4. **Review Focus:** item 1 → Task 3 tests 1–2; item 2 → Task 3 test 4 and Task 8 test 3; item 3 → Task 4 test 3; item 4 → Task 1 test 2; item 5 → Task 1 test 3.
5. **Proportion:** ten tasks, each with exact signatures and named tests, no function bodies. Shorter than the code it describes.
