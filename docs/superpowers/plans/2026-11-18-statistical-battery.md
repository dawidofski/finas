# Statistical Battery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the spec's fixed, pre-declared battery of behavioural tests over the owner's own data, and report each result with its effect size, its sample, and an honest statement of how certain it is — or say what is missing and how much more is needed.

**Architecture:** A new `src/battery/` directory. Integer statistics primitives, a declared table of the ten relationships with their minimum samples, significance expressed as a **bracket** read from critical-value tables rather than a computed p-value, Benjamini–Hochberg correction over those brackets, and the findings rendered on the existing Intelligence screen beside what it already shows.

**Tech Stack:** TypeScript 5.5.4 (`strict`, `noUncheckedIndexedAccess`), React 18.3.1, Dexie 4.0.8, Vitest 5.1.0. **No new runtime dependency** — no statistics library.

**Spec:** `docs/superpowers/specs/2026-11-15-personal-finance-intelligence-design.md` — §12 is the battery and is binding, including its minimum-data column; §7.2 (the battery never feeds the categoriser); §13.1; §39.4; §41; A2 (say what is missing, never speculate); and §12's prohibition on causal language in finding templates.

---

## The ruling that shapes this plan

**`R-S: significance is a bracket read from a critical-value table, never a computed p-value.`**

The statistics §12 asks for are all exactly computable in integers:

- **ranks** are integers; work in **doubled ranks** so an average rank at a tie stays an integer;
- **Spearman's ρ** is `1 − 6·Σd² / (n(n²−1))` — a ratio of integers, so ρ in basis points is exact;
- **Mann–Whitney U** is a count of pairwise comparisons, and rank-biserial `r = 1 − 2U/(n₁n₂)` is exact in basis points;
- **chi-square** is `Σ(O−E)²/E` where `E = row·col/total` — rational throughout, so a scaled integer χ² is exact;
- **Cramér's V** needs one square root, and an integer square root gives it to the basis point.

**p-values are the exception.** They need continuous distribution functions, and this codebase forbids floating point. The three ways out, and why one wins:

| Approach | Why not / why yes |
|---|---|
| Compute p with floats in a bounded module | Fastest to write, but it puts float arithmetic in the one place whose whole output is a confidence claim, and a subtly wrong approximation yields a plausible number nobody can check. This project's recurring defect is exactly that. |
| Integer-scaled normal / χ² approximations | Keeps the rule, but is real numerical work: a rational approximation of a CDF, tuned and verified, for three distributions. High effort, and a quiet error is undetectable without an oracle. |
| Critical-value tables per sample size | Keeps the rule, but a wrong number in a table of Spearman or Mann–Whitney criticals silently corrupts every finding built on it, and nobody reviewing this can check a table of rank criticals by eye. Rejected for that reason. |
| **Squared normal comparison, chosen** | Both rank tests have a normal approximation, and the significance test reduces to an **integer inequality once both sides are squared**, which removes the square root. The only constants needed are the two-tailed normal criticals **1.96** and **2.576**, which anyone can check from memory, plus the chi-square criticals for small degrees of freedom (**3.841** and **6.635** at df 1), which are equally well known. No per-n table, no float, and every comparison is exact integer arithmetic. |

**The comparisons, written out, because they are the heart of the plan:**

- **Spearman.** `z = ρ·√(n−1)`. Significant at α when `|ρ|·√(n−1) ≥ z_α`. Square both sides: `ρ_bp² · (n−1) ≥ z_α_bp²`. Both sides are integers; no root is taken.
- **Mann–Whitney.** `z = (U − n₁n₂/2) / √(n₁n₂(n₁+n₂+1)/12)`. Significant when `(2U − n₁n₂)² · 3 ≥ z_α_bp² · n₁n₂(n₁+n₂+1) / 10000²`, arranged so every term is an integer — derive it yourself from the line above rather than trusting this rearrangement, and show the derivation in a comment.
- **Chi-square.** Compare the scaled statistic against the scaled critical constant for its degrees of freedom. A short table, df 1 to 6, each value checkable.

`isqrt` is still needed for Cramér's V, which is an effect size rather than a test, and where a floor is honest.

So a result reports `p < 0.01`, `p < 0.05`, or `not significant` — a bracket, not a number. **That is more honest for this app, not less:** the spec never promises a precise p, and "p < 0.05" cannot be mistaken for the precision that "p = 0.0412" implies. The cost, stated plainly: the owner cannot see how far below a threshold a result sat, and a result just under α looks identical to one far under it. The effect size, which is exact, is what carries that information instead — and §12 asks for the effect size in every finding anyway.

**Benjamini–Hochberg over brackets** uses each bracket's **upper bound** as its p. That is conservative by construction: it can only fail to report a finding, never over-report one. For a tool whose purpose is to avoid telling the owner something untrue about themselves, erring toward silence is the correct direction, and it must be said on screen.

## Global Constraints

- **No new runtime dependency.** No statistics library; the primitives are a few dozen lines each.
- **No floating point anywhere.** `parseFloat`, `toFixed`, `**`, decimal literals and `Math.round`-style float rounding are banned in `src/`, now enforced tree-wide by `src/sourceRules.test.ts`. Effect sizes are **basis points**; χ² is a **scaled integer** whose scale is a named constant. Division goes through `divRound` from `src/lib/money.ts`.
- **No schema change, no new index, no Dexie version bump.** §29 forbids any version above 1 until two prerequisite gates are built. `analyticsCache` already exists and every battery result is cached through `cached()` from `src/analytics/cache.ts`, which takes `(key, compute, computedAt)`.
- **§41:** every figure takes amount, sign, date and account from the **bank** row; only the classifications — category, merchant, mood, reason, worthwhile, and `kind` via `treatmentOf` — are the owner's.
- **§39.4:** no screen reads the whole `transactions` table. Battery computes run inside `cached()`, which is the sanctioned place, and prefer the annotation-driven read (`annotatedTransactions` in `src/learning/regret.ts`) since every relationship needs annotated rows.
- **The battery feeds nothing else** (§7.2). It is read by the Intelligence screen and by nothing in the categoriser.
- **No causal language** in any template (§12), and no jargon reaching the owner: never "p-value", "chi-square", "Spearman", "null hypothesis", "Benjamini–Hochberg", "significant" in the statistical sense. Say what was counted and how sure the app is in plain words.
- **A test for a rule must fail when the rule is removed.** Verify by mutation, confirm the file changed first, and after writing each test ask what else could make it green. Sixteen tests across the last three plans were found to pin nothing.
- **Every function a task produces must have a caller outside its own tests** by the end of the plan — checked before dispatch, per the reachability pre-flight.

## Review Focus

- **A relationship exactly at its minimum sample**, and one row below it. §12's gates are inclusive (`≥30`), so 29 must say what is missing and 30 must run.
- **Ties everywhere.** Mood valences repeat, weekday groups repeat, amounts repeat. Ranks with ties are where a hand-rolled Spearman goes wrong, and doubled ranks are the defence.
- **A degenerate group**: every value identical, so there is no variance to correlate; or a contingency table with an empty row or column, where `E = 0` and χ² divides by zero.
- **All ten relationships below their gates at once** — the app's normal first state. The screen must read as "here is what I will be able to tell you, and what it needs", not as ten failures.
- **One relationship significant and nine not**, after correction. The corrected threshold must be shown, and a result that survived uncorrected but not corrected must not be presented as a finding.

---

### Task 1: Integer statistics primitives

**Files:** Create `src/battery/stats.ts`, `src/battery/stats.test.ts`

**Interfaces:**
- Consumes: `divRound` from `src/lib/money.ts`; `medianOf` from `src/lib/stats.ts` if useful.
- Produces:
```ts
export function isqrt(n: number): number                      // floor(sqrt(n)) for n >= 0, exact
export function doubledRanks(values: readonly number[]): number[]   // rank*2, ties share their average
export function spearmanRhoBp(xs: readonly number[], ys: readonly number[]): number | null
export function mannWhitneyU(a: readonly number[], b: readonly number[]): { u: number; rBp: number } | null
export function chiSquareScaled(table: readonly number[][]): { chiScaled: number; df: number } | null
export function cramersVBp(chiScaled: number, total: number, rows: number, cols: number): number | null
export const CHI_SCALE = 10000
```

Every one returns `null` where the statistic is undefined — too few values, no variance, an empty row or column — rather than a number that looks like an answer.

- [ ] **Step 1: Write the failing tests**

```ts
it('takes an exact integer square root, including of a perfect square and of zero', () => {})
it('gives tied values their average rank, doubled so it stays an integer', () => {})
it('matches a worked Spearman example by hand, with no ties', () => {})
it('matches a worked Spearman example with ties', () => {})
it('returns null for Spearman when one series has no variance', () => {})
it('counts Mann-Whitney U as pairwise wins, and agrees with the rank-sum identity', () => {})
it('gives rank-biserial r of zero when the two groups interleave evenly', () => {})
it('matches a worked chi-square by hand on a 2x2 table', () => {})
it('returns null for chi-square when a row or column is empty', () => {})
it('matches a worked Cramers V, and is zero for an independent table', () => {})
it('uses no floating-point arithmetic', () => {})
```

Two of these carry the weight. **The worked examples must be computed by hand in the test's comment**, with the arithmetic shown, so the test is an oracle and not a copy of whatever the implementation returned. And the Mann–Whitney test must check U two ways — by counting pairwise wins and via `U = R₁ − n₁(n₁+1)/2` — because two derivations agreeing is evidence; one derivation agreeing with itself is not.

The float test is a source-text assertion in the style of `src/learning/bayes.test.ts`, which is the strictest in the repo. Read it first.

- [ ] **Step 2: Run them and watch each fail.**
- [ ] **Step 3: Implement.** `isqrt` by Newton's method on integers, with its termination argued in a comment.
- [ ] **Step 4: Run the tests and the tree-wide guards.**
- [ ] **Step 5: Verify by mutation** — break the tie correction in `doubledRanks`; the ties tests for both ρ and U must redden.
- [ ] **Step 6: Commit** — `feat: exact integer statistics for the battery`

---

### Task 2: Significance as a squared integer comparison

**Files:** Create `src/battery/critical.ts`, `src/battery/critical.test.ts`

**Interfaces:**
- Consumes: `CHI_SCALE` (Task 1).
- Produces:
```ts
export type Bracket = 'p<0.01' | 'p<0.05' | 'none'
export const ALPHA_BP = { 'p<0.01': 100, 'p<0.05': 500 } as const   // each bracket's upper bound, for correction
export const Z_BP = { 'p<0.05': 19600, 'p<0.01': 25758 } as const   // two-tailed normal criticals, in basis points
export function spearmanBracket(rhoBp: number, n: number): Bracket
export function mannWhitneyBracket(u: number, n1: number, n2: number): Bracket
export function chiSquareBracket(chiScaled: number, df: number): Bracket
```

- [ ] **Step 1: Write the failing tests**

```ts
it('brackets Spearman by the squared comparison, either side of the 0.05 line', () => {})
it('brackets Spearman at the stricter line only when the statistic clears it', () => {})
it('brackets Mann-Whitney two-tailed, symmetrically above and below the midpoint', () => {})
it('brackets chi-square against the constants for one and two degrees of freedom', () => {})
it('returns none for a statistic below the weakest line', () => {})
it('is monotonic: a stronger statistic never brackets weaker than a lesser one', () => {})
it('agrees with a worked example computed the long way, with a square root', () => {})
it('uses no floating-point arithmetic', () => {})
```

The seventh is what makes the squaring trustworthy: take one case, compute `z` the ordinary way with a real square root **inside the test**, compare it to the critical value, and assert the integer comparison reaches the same verdict. The squaring is an algebraic rearrangement, so it must agree with the thing it replaces — and a test that only exercises the rearranged form cannot tell you the rearrangement is right.

The sixth guards the case where a rearrangement loses a sign or an inequality direction, which is the likeliest way to get this wrong.

**Where a statistic is too small for the approximation to mean anything, return `none`** rather than a bracket. §12's gates keep most of these samples reasonable, but say in a comment which n the approximation is honest for and what the module does below it — a bracket from a normal approximation at n = 4 is a made-up finding.

- [ ] Steps 2–6 as Task 1, committing `feat: significance as a bracket from a declared table`.

---

### Task 3: Benjamini–Hochberg over brackets

**Files:** Create `src/battery/correction.ts`, `src/battery/correction.test.ts`

**Interfaces:**
```ts
export interface Corrected<T> { item: T; bracket: Bracket; survives: boolean }
export function benjaminiHochberg<T>(items: readonly { item: T; bracket: Bracket }[]): {
  results: Corrected<T>[]
  thresholdBp: number | null      // the corrected threshold actually applied, for the screen to show
  tested: number
}
```

Each bracket's **upper bound** stands in for its p (`ALPHA_BP`), which makes the procedure conservative: it can only withhold a finding, never invent one.

- [ ] **Step 1: Write the failing tests**

```ts
it('withholds a result that would pass uncorrected but not after correction', () => {})
it('keeps the strongest result when several are tested', () => {})
it('reports the corrected threshold it applied, so the screen can show it', () => {})
it('is conservative: using each brackets upper bound can only withhold, never admit', () => {})
it('handles every result unbracketed, and every result significant', () => {})
it('orders ties deterministically, so the outcome never depends on input order', () => {})
```

The first is the whole point of the task — a result that looks significant alone and is not once ten things were tested. Pin it with the arithmetic in a comment.

- [ ] Steps 2–6, committing `feat: Benjamini-Hochberg over brackets, erring toward silence`.

---

### Task 4: The declared battery and its gates

**Files:** Create `src/battery/battery.ts`, `src/battery/battery.test.ts`

**Interfaces:**
```ts
export type RelationshipId =
  | 'mood-amount' | 'mood-frequency' | 'stress-discretionary' | 'boredom-impulse'
  | 'reason-worthwhile' | 'weekend' | 'payday' | 'small-purchases'
  | 'salary-lifestyle' | 'category-savings'
export interface Gate { have: number; need: number; what: string }   // `what` is owner-facing
/**
 * Every count §12's minimum-data column asks about, gathered ONCE so each gate stays pure and the data is read once
 * per load rather than once per relationship. Defined by this task; Task 9 computes it and hands it in.
 */
export interface BatteryData {
  discretionarySpendsWithMood: number
  moodGroupsOfTen: number           // mood groups holding at least ten spends
  weeksOfMoodCoverage: number
  stressedSpends: number
  unstressedSpends: number
  impulseTaggedSpends: number
  spendsWithReasonAndWorthwhile: number
  weekendsObserved: number
  incomeEvents: number
  fullMonths: number
  incomeLevelsWithTwoMonths: number
  monthsObserved: number
}
export interface Relationship {
  id: RelationshipId
  question: string          // owner-facing, no jargon, no causal wording
  gates: (data: BatteryData) => Gate[]
}
export const BATTERY: readonly Relationship[]    // all ten, in §12's order
```

**The ten relationships and their minimum samples are copied verbatim from §12's table** — it is the binding list, and this plan adds nothing to it and drops nothing from it. `small-purchases` is declared with "no test" and reads its figure from `src/analytics/habits.ts`, which Plan 5 built.

- [ ] **Step 1: Write the failing tests**

```ts
it('declares exactly the ten relationships of the spec, in its order', () => {})
it('states for each unmet gate what is missing and how much more is needed', () => {})
it('runs a relationship at exactly its minimum sample and withholds one below it', () => {})
it('says nothing about cause in any question or gate wording', () => {})
it('needs no test for small-purchase accumulation, and says so', () => {})
```

The third is Review Focus item 1: §12's gates are inclusive, so 30 runs and 29 explains.

- [ ] Steps 2–6, committing `feat: the ten declared relationships and their gates`.

---

### Task 5: The three rank relationships

**Files:** Create `src/battery/rank.ts`, `src/battery/rank.test.ts`

Mood → spend amount (Spearman ρ on mood valence against bank amount), stress → discretionary share (Mann–Whitney U), and weekend effect (Mann–Whitney U).

**Interfaces:**
- Consumes: `spearmanRhoBp` and `mannWhitneyU` (Task 1) for the statistics; `spearmanBracket` and `mannWhitneyBracket` (Task 2) for the certainty; `BATTERY`'s gates for `mood-amount`, `stress-discretionary` and `weekend` (Task 4); `annotatedTransactions` from `src/learning/regret.ts` for the bounded read; `cached` from `src/analytics/cache.ts`.
- Produces: one function per relationship, each returning `{ effectBp, bracket, n, period } | Gate[]` — the result, or what is missing.

- [ ] **Step 1: Write the failing tests**

```ts
it('correlates mood valence against the bank amount, not an amount the owner corrected', () => {})
it('uses the bank date to decide a weekend, whatever date the owner typed', () => {})
it('compares stressed against non-stressed spends and reports the effect size', () => {})
it('withholds each relationship below its own minimum, naming what is short', () => {})
it('reports the period it covered, from the bank dates', () => {})
it('treats a mood with no valence as unusable rather than as zero', () => {})
```

`MoodRow.valence` is `number | null` — null for "Other" and for a custom mood until assigned (§21.3). The last test is that distinction: a null valence is not a neutral one.

- [ ] Steps 2–6, committing `feat: mood, stress and weekend, by rank`.

---

### Task 6: The two contingency relationships

**Files:** Create `src/battery/contingency.ts`, `src/battery/contingency.test.ts`

Boredom → impulse share (chi-square) and reason → worthwhile (chi-square plus Cramér's V).

**Interfaces:**
- Consumes: `chiSquareScaled` and `cramersVBp` (Task 1), `chiSquareBracket` (Task 2), `CHI_SCALE` (Task 1) so the scale is never re-declared, `BATTERY`'s gates for `boredom-impulse` and `reason-worthwhile` (Task 4), `annotatedTransactions`, and `cached`.
- Produces: one function per relationship, returning the result with **both** `vBp` and `bracket`, or `Gate[]`.

- [ ] **Step 1: Write the failing tests**

```ts
it('builds the table from the owners reasons and hindsight answers, counting only answered spends', () => {})
it('reports Cramers V beside the bracket, so strength and certainty are separate', () => {})
it('withholds the result when a row or column of the table is empty', () => {})
it('counts a removed reason under its own label rather than dropping its spends', () => {})
it('withholds below thirty spends with both fields, naming how many more are needed', () => {})
```

The second is §12's own distinction: a result can be certain and tiny. The screen must be able to say so, which means the two numbers stay separate all the way out.

- [ ] Steps 2–6, committing `feat: boredom and hindsight, by contingency table`.

---

### Task 7: The four remaining relationships

**Files:** Create `src/battery/trend.ts`, `src/battery/trend.test.ts`

Mood → purchase frequency (Poisson rate comparison by mood day), days-after-payday (Spearman ρ on days-since-income against daily spend), salary change → lifestyle change (paired comparison of discretionary share across income tiers), category → savings performance (Spearman ρ).

**Interfaces:**
- Consumes: `spearmanRhoBp` (Task 1) and `spearmanBracket` (Task 2) for payday and category-savings; `mannWhitneyU` and `mannWhitneyBracket` for the paired salary comparison; `BATTERY`'s gates for `mood-frequency`, `payday`, `salary-lifestyle` and `category-savings` (Task 4); `afterPayday`, `monthSeries`, `annotatedTransactions`, `cached`.
- Produces: one function per relationship, returning the result or `Gate[]`.

**Reuse, do not re-derive:** `afterPayday` in `src/analytics/habits.ts` already groups spending by days since the largest income of a month, bank-dated and bounded; `monthSeries` in `src/analytics/series.ts` already gives per-month income, spending and savings with a `hasData` flag. A month with `hasData: false` has **blanked income** and must not enter a correlation as a zero.

- [ ] **Step 1: Write the failing tests**

```ts
it('correlates days since payday against that days spending, over the bank dates', () => {})
it('leaves a month with no records out of every correlation rather than treating it as zero', () => {})
it('compares discretionary share across two income levels with at least two months each', () => {})
it('compares purchase frequency between mood days as a rate over the weeks observed', () => {})
it('correlates category spending against savings across at least four months', () => {})
it('withholds each one below its own minimum, naming what is short', () => {})
```

The second is Review Focus and the trap Plan 5 found the hard way: a gap month carries an invented income estimate unless `hasData` is honoured.

- [ ] Steps 2–6, committing `feat: payday, salary, frequency and savings trends`.

---

### Task 8: The finding template

**Files:** Create `src/battery/finding.ts`, `src/battery/finding.test.ts`

§12 requires every finding to report: the pattern, the number of transactions analysed, the period covered, the effect size, a confidence band, a plain-language limitation, a possible meaning, and a suggested action. That is eight fields, and this task is the one place their wording lives.

**Interfaces:**
```ts
export interface Finding {
  id: RelationshipId
  pattern: string; transactions: number; period: string
  effect: { label: string; bp: number }
  confidence: string            // the bracket in plain words
  limitation: string; meaning: string; action: string
}
export function findingFor(id: RelationshipId, result: ..., corrected: Corrected<...>): Finding
```

- [ ] **Step 1: Write the failing tests**

```ts
it('fills all eight fields the spec requires, for every one of the ten relationships', () => {})
it('uses no causal language in any field of any template', () => {})
it('uses no statistical jargon in any field of any template', () => {})
it('states a limitation that names the actual limit, not a disclaimer', () => {})
it('says a result is uncertain in words, never as a number pretending to be exact', () => {})
it('suggests an action the app can actually offer', () => {})
```

The first iterates **all ten** relationships, so a template added later without its fields fails. The second and third scan every string of every template against the regexes `src/learning/categorise.test.ts` and `src/ui/screens/Reports.test.tsx` already use — read those, do not invent a third list.

- [ ] Steps 2–6, committing `feat: the eight fields a finding must carry`.

---

### Task 9: The battery on the Intelligence screen

**Files:** Modify `src/ui/screens/Intelligence.tsx`, `src/ui/screens/Intelligence.test.tsx`

**Interfaces:**
- Consumes: `BATTERY` (Task 4), the four relationship modules (Tasks 5–7), `benjaminiHochberg` (Task 3), `findingFor` (Task 8), and `cached` from `src/analytics/cache.ts`.

The screen already shows what the engine learned about merchants and the regret clusters. The battery's findings join it as a third region. It must:
- show the **corrected threshold actually applied**, and say in plain words that testing ten things at once makes each one harder to believe;
- for every relationship below its gate, say what is missing and how much more is needed — **this is the normal first state and the one to get right**;
- never present a result that did not survive correction as a finding;
- keep the effect size and the certainty visibly separate, since a result can be sure and tiny.

- [ ] **Step 1: Write the failing tests**

```ts
it('says what each relationship still needs, on a fresh install, without reading as ten failures', () => {})
it('shows a finding with all eight of its fields once the data supports one', () => {})
it('shows the corrected threshold it applied, and what testing ten things means', () => {})
it('does not present a result that failed correction as a finding', () => {})
it('reads the cache rather than the transactions table', () => {})
it('uses no causal or statistical wording anywhere on the page', () => {})
it('keeps focus and renders no control that does nothing', () => {})
```

- [ ] Steps 2–6, committing `feat: the battery on the Intelligence screen`.

---

## Self-review, run before dispatch

1. **Spec coverage.** §12's ten relationships → Tasks 4–7, one declared list. Its eight required finding fields → Task 8. Its correction and shown threshold → Tasks 3, 9. Its minimum-data column → Task 4's gates, verbatim. Its causal-language ban → Tasks 4, 8, 9. §7.2's "feeds nothing else" → nothing in `src/learning/` may import from `src/battery/`; assert it.
2. **Every produced function has a consumer:** Task 1 → 2, 5, 6, 7. Task 2 → 3, 5, 6, 7. Task 3 → 9. Task 4 → 9. Tasks 5–7 → 9. Task 8 → 9. **Run the grep before dispatching Task 1.**
3. **Type consistency:** `Bracket` is defined once in Task 2 and used by 3, 8, 9; every effect size is `bp`; every "cannot say" is `null` or a `Gate[]`, never a zero.
4. **Review Focus:** item 1 → Task 4 test 3; item 2 → Task 1 tests 2, 4 and Task 5 test 6; item 3 → Task 1 tests 5, 9 and Task 6 test 3; item 4 → Task 9 test 1; item 5 → Task 3 test 1 and Task 9 tests 3, 4.
5. **Proportion:** nine tasks, exact signatures, named tests, no function bodies. The hard part is stated once as ruling R-S rather than re-argued per task.
