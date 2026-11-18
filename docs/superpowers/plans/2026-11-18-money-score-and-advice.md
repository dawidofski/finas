# Money Score and Advice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build §13.3's Money Score and §13.2's recommendations and education, filling the `/score` and `/learning` stubs.

**Architecture:** Six independent component functions each return a 0–100 score **or** a reason they cannot be measured; an assembler weights only the measured ones and shows the arithmetic. Recommendations are generated from signals that already exist — the battery's corrected findings, unusual spending, small-purchase totals, budget variance and savings consistency — each carrying its evidence, and each suppressible by the owner through the existing `recommendationState` table.

**Tech Stack:** React 18.3.1, TypeScript 5.5.4 (`strict`, `noUncheckedIndexedAccess`), Vite 8.3.8, Dexie 4.0.8, Vitest 5.1.0. **No new dependency.**

**Spec:** `docs/superpowers/specs/2026-11-15-personal-finance-intelligence-design.md` — §13.2, §13.3, §15, and anti-goals A1, A2, A7.

**No schema change.** `recommendationState: '&key'` already exists in Dexie v1, as do `savingsGoals` and `recurring`. Nothing in this plan may add a table, an index, or a version.

## Global Constraints

- **No floating point anywhere in `src/`**: no `parseFloat`, `toFixed`, `**`, no decimal literals. A tree-wide guard in `src/sourceRules.test.ts` scans every file. Integers and BigInt only.
- Money is **integer cents**; every share, rate and percentage is **basis points** (10000 bp = 1.0). A component score is an integer **0–100**.
- Dates are `'YYYY-MM-DD'` UTC strings through `src/lib/dates.ts`. Local-timezone `Date` methods are banned tree-wide.
- **Never read the clock.** `today` and `computedAt` arrive as arguments; `src/ui/routes.tsx` is the only place that reads `Date.now()`.
- **Never read the whole `transactions` table** (§39.4). Use the existing bounded readers.
- Derived figures go through `cached(key, compute, computedAt)` in `src/analytics/cache.ts`.
- Every figure takes amount, sign, date and account from the **bank** row; only classifications are the owner's (§41/§43).
- **A1 — no judging or shaming tone, and no assumption about what the owner can afford.** **A2 — no pattern asserted from insufficient data, and no correlation presented as causation.** **A7 — no statistics for their own sake.**
- No causal language and no statistical jargon in owner-facing copy. The banned-word lists live in `src/test/bannedWords.ts`; read them from there. **Do not create a fourth list.**
- Reuse `formatBp` and `divRound` from `src/lib/money.ts`. Do not write a second copy of either.

## Review Focus

1. **A fresh install scores nothing.** Every component is unmeasurable on day one; the screen must say the score cannot be given yet and must never render `0`, `NaN`, or an empty ring. → Task 3 test 4, Task 7 test 1.
2. **One month of data has no trailing baseline.** "Improvement" compares against the owner's own earlier months; with fewer it is *not measured*, which is not the same as *no improvement*. → Task 1 test 5.
3. **A month with no records is not a month of zeros.** `MonthPoint.hasData` marks it, and a gap month admitted as zero spending or zero savings invents a month the owner never lived — it drags savings consistency down and the discretionary trend around. This is the trap Plan 5 found and Plan 6 found again in a second form. → Task 1 test 6, Task 2 test 5.
4. **Excluding a component must not let another dominate.** Weights renormalise over the measured components only; with four of six excluded, the remaining two must still be weighted against each other, not against the original total. → Task 3 tests 2 and 3.
5. **A suppressed recommendation must stay suppressed.** Its key has to be stable across cycles — a key rebuilt from a changing figure resurfaces the same advice forever and the dismissal never takes. Changed evidence must not reopen it either; that is what separates `suppressed` from `accepted`. → Task 4 tests 3 and 4.
6. **Evidence can go stale.** A recommendation's transactions may be soft-deleted between generation and display; the evidence list must drop them rather than render a blank row. → Task 5 test 6.

---

### Task 1: Score components 1–3, the money components

**Files:** Create `src/score/components.ts`, `src/score/components.test.ts`

**Interfaces:**
```ts
/** A component is measured, or it is not; it is never a zero standing in for "unknown" (§13.3). */
export type Component =
  | { kind: 'measured'; score: number; inputs: string }   // score 0-100; `inputs` is the owner-facing arithmetic
  | { kind: 'not-measured'; why: string }                 // `why` names what is missing, in the owner's terms

export function budgetAwareness(budgets: readonly MonthlyBudget[]): Component
export function savingsConsistency(points: readonly MonthPoint[]): Component
export function improvement(points: readonly MonthPoint[]): Component
```

- Consumes: `MonthlyBudget` and `BudgetLine` from `src/budget/month.ts`; `MonthPoint` from `src/analytics/series.ts` (`MonthSummary` plus `hasData`).
- Produces: the three functions above and the `Component` type, for Tasks 2, 3 and 7.

**The arithmetic, which the spec fixes and the implementer must not reinvent:**

- **Budget awareness** — "share of allocations respected, weighted by allocation size". A line is *respected* when `spentCents <= allocatedCents`. Score is the respected lines' `allocatedCents` as a share of all lines' `allocatedCents`, in whole points. Lines with `allocatedCents === 0` are excluded entirely (there is no ratio without a budget — `varianceBp` is `null` for exactly this reason). **Not measured** when no line in any month has an allocation.
- **Savings consistency** — "proportion of observed months with positive net savings". A month counts when `hasData` and `savedCents > 0`, over months where `hasData`. **Not measured below 3 months with data**, because two months is a coin toss and A2 forbids a pattern from insufficient data.
- **Improvement** — "trend in discretionary share against the owner's own trailing baseline". Discretionary share is `discretionaryCents` over `spentCents` in bp. Compare the mean share of the **most recent 3 months with data** against the mean of the **3 months with data before those**. A *falling* share is improvement. Map to a score: 50 is no change, and each 100 bp of improvement adds 5 points, clamped to 0–100. **Not measured below 6 months with data.**

- [ ] **Step 1: Write the failing tests**

```ts
it('weights a respected allocation by its size, not by its count', () => {})
it('ignores a line with no allocation rather than scoring it as overspent', () => {})
it('counts a month as consistent when savings are positive, over months with data', () => {})
it('withholds savings consistency below three months of data, naming what is short', () => {})
it('withholds improvement below six months, because there is no baseline to compare against', () => {})
it('leaves a month with no records out of every component rather than counting it as zero', () => {})
```

The first test is the whole point of "weighted by allocation size": a 2000-cent line respected and a 200 000-cent line overspent is a *low* score, and a count-based implementation would call it 50.

The last two are Review Focus 2 and 3. For the gap month: a `MonthPoint` with `hasData: false` has blanked figures, so admitting it as a zero-savings month drags consistency down and as a zero-spend month distorts the discretionary trend. Write the test so the gap month's inclusion **changes the score**, not the third decimal — otherwise it passes with the bug present.

Note that none of these three components reads income: budget awareness compares allocated against spent, savings consistency reads `savedCents`, and improvement is a ratio of `discretionaryCents` to `spentCents`. `incomeBasis` is therefore not this task's concern, and a component here must not start consulting it.

- [ ] **Step 2: Run the tests and watch each fail for the right reason**

Run: `npx vitest run src/score/components.test.ts`
Expected: FAIL, "does not provide an export named".

- [ ] **Step 3: Implement the three functions in `src/score/components.ts`**

Integer arithmetic only; use `divRound` from `src/lib/money.ts` for any rounding. Each `inputs` string states the figures the score came from, in the owner's terms and within A1 — it is read on the screen, not logged.

- [ ] **Step 4: Run the tests and confirm they pass**

- [ ] **Step 5: Mutate each rule and confirm a test that names it reddens**

Break each rule in turn (weighting by count instead of size; admitting a zero-allocation line; the 3- and 6-month floors; the improvement direction). **Verify every mutation reached the file by comparing before and after** — a mutation that silently fails to apply logs a false pass. Report the table.

- [ ] **Step 6: Commit**

```bash
git commit -- src/score/components.ts src/score/components.test.ts -m "feat: the three money components of the score"
```

---

### Task 2: Score components 4–6, the behaviour components

**Files:** Modify `src/score/components.ts`, `src/score/components.test.ts`

**Interfaces:**
```ts
export async function spendingAwareness(from: string, to: string): Promise<Component>
export function goalProgress(goals: readonly SavingsGoalRow[]): Component
export function learning(early: readonly RegretCluster[], late: readonly RegretCluster[]): Component
```

- Consumes: `Component` from Task 1; `annotatedTransactions` and `RegretCluster` from `src/learning/regret.ts`; `SavingsGoalRow` from `src/db/schema.ts`.

**The arithmetic:**

- **Spending awareness** — "share of transactions reviewed and annotated", over live bank transactions in the window. Read through `annotatedTransactions`, never the whole table. **Not measured** when the window holds no transactions.
- **Goal progress** — "weighted progress against each goal's own plan", weighted by each goal's target. **With no goals it is `not-measured`, and its `why` says the owner has not set one yet — not that they have made no progress.** Nothing in the app creates a savings goal until Plan 8, so this is its normal state; implement the arithmetic anyway so Plan 8 needs no change here, and test it against goal rows constructed in the test.
- **Learning** — "reduction in repeated regret within previously flagged clusters". For each cluster present in both windows, compare its regret rate (`regretted / total`, bp) late against early. Score is the share of such clusters whose rate fell, in whole points. **Not measured** when fewer than 2 clusters appear in both windows.

- [ ] **Step 1: Write the failing tests**

```ts
it('counts a transaction as reviewed only when the owner actually reviewed it', () => {})
it('says the owner has set no goal yet, rather than scoring no progress', () => {})
it('scores progress against each goal target, weighted by the size of the target', () => {})
it('compares a cluster regret rate late against early, and ignores a cluster seen once', () => {})
it('does not score a window whose transactions are all unannotated', () => {})
```

The second is the distinction A1 turns on: "you have not set a goal" and "you are making no progress" are different sentences, and only one of them is true.

- [ ] **Steps 2–6 as Task 1**, committing `feat: the three behaviour components of the score`.

---

### Task 3: The score, its weights, and what it excludes

**Files:** Create `src/score/score.ts`, `src/score/score.test.ts`

**Interfaces:**
```ts
export interface ScoredComponent { id: ComponentId; label: string; weight: number; component: Component }
export type ComponentId =
  | 'budget-awareness' | 'savings-consistency' | 'improvement'
  | 'spending-awareness' | 'goal-progress' | 'learning'
export interface MoneyScore {
  /** Null when no component could be measured: the score is withheld, never shown as 0 (§13.3). */
  score: number | null
  components: ScoredComponent[]
  /** The denominator actually used — the measured components' weights — so the screen can show the arithmetic. */
  weightUsed: number
}
export const WEIGHTS: Readonly<Record<ComponentId, number>> = {
  'budget-awareness': 3, 'savings-consistency': 3, 'improvement': 2,
  'spending-awareness': 2, 'goal-progress': 2, 'learning': 2,
}
/** Takes all six by id; this module owns the labels and the weights, so no caller assembles them. */
export function moneyScore(components: Readonly<Record<ComponentId, Component>>): MoneyScore
```

**Why `moneyScore` takes a record of all six rather than a prepared list:** somebody has to pair each component with its id, its owner-facing label and its weight, and the only other candidate is the screen. Leaving that to the screen would put the labels and the no-dominance property in a `.tsx` file, where a second screen — or a later export — would have to repeat them. This module owns all three, and the screen passes six `Component` values.

**Two decisions the spec left to this plan, with their reasons:**

**The weights are plain integers summing to 14, not basis points.** The measured set changes from month to month, so the denominator is the sum of the *measured* weights — renormalising integers is exact, while renormalising six bp values that must still sum to 10000 forces a rounding decision every time the set changes.

**No component may exceed a quarter of the total**, which is the spec's only stated constraint on them ("to be chosen so no component can dominate"). The largest here is 3 of 14, which is 21.4%. The two components that are directly about money — respecting a budget and saving consistently — carry 3; the four that are about behaviour, usage or progress carry 2. **A test asserts the no-dominance property against `WEIGHTS` itself**, so a later re-weighting cannot quietly break it.

- [ ] **Step 1: Write the failing tests**

```ts
it('weights only the measured components, and says which weight it used', () => {})
it('renormalises when a component is excluded, so the rest keep their relative weight', () => {})
it('lets no single component exceed a quarter of the total weight', () => {})
it('withholds the score entirely when nothing can be measured yet', () => {})
it('keeps every component in the list, measured or not, so the screen can show all six', () => {})
```

Test 2 is Review Focus 4: with only budget awareness (3) and learning (2) measured, the score is `(3·a + 2·b) / 5` — **not** `/14`, which would silently halve a perfect score. Pin it with the arithmetic in a comment.

Test 4 is Review Focus 1: `score` is `null`, and `weightUsed` is 0.

- [ ] **Steps 2–6 as Task 1**, committing `feat: the score weights only what it could measure`.

---

### Task 4: Recommendation state and suppression

**Files:** Create `src/advice/state.ts`, `src/advice/state.test.ts`

**Interfaces:**
```ts
export const SUPPRESS_AFTER_REJECTIONS = 2
export const SNOOZE_DAYS = 30
export async function recordShown(key: string, fingerprint: string, at: number): Promise<void>
export async function recordAccepted(key: string, at: number): Promise<void>
export async function recordRejected(key: string, at: number): Promise<void>
export async function recordSnoozed(key: string, at: number): Promise<void>
/** Keys that must not be offered now, given the clock and each row's own fingerprint. */
export async function withheldKeys(fingerprints: ReadonlyMap<string, string>, now: number): Promise<ReadonlySet<string>>
```

- Consumes: the **existing** `RecommendationStateRow` in `src/db/schema.ts` — `{ key, status, shownCount, rejectedCount, lastShownAt, suppressedUntil, evidenceFingerprint }` with `RecommendationStatus = 'active' | 'accepted' | 'rejected' | 'snoozed' | 'suppressed'`, and the existing `recommendationState: '&key'` store. **Use this row as it stands. Add no table, no field, no index, no version.**
- Produces: the gate for Task 5.

**Suppression is "after repeated rejection" (§19's test list), so it takes two.** One dismissal is "not now"; two is "not this". The constant is exported so the screen can word it.

**What `evidenceFingerprint` decides, which is the one real design choice here.** The row carries a fingerprint of the evidence as it stood when the owner last acted. It governs whether advice may return:

- **`suppressed`** (rejected twice) — **never returns, whatever the fingerprint.** The owner said no twice; new transactions behind the same advice do not reopen it. A dismissal that a changed figure can overturn is not a dismissal.
- **`accepted`** — returns **only when the fingerprint differs**, i.e. this is a fresh occurrence rather than the one they already acted on. Re-offering advice the owner has just taken reads as not noticing.
- **`snoozed`** — returns once `suppressedUntil` has passed; `SNOOZE_DAYS` is 30. The fingerprint is irrelevant to a snooze, which is a statement about timing, not about evidence.
- **`active`** / no row — offered.

`withheldKeys` takes the current fingerprints so this is decided in one bounded read rather than a query per recommendation.

- [ ] **Step 1: Write the failing tests**

```ts
it('suppresses a recommendation only after it has been rejected twice', () => {})
it('keeps a rejection across a reload, because it is stored and not held in memory', () => {})
it('suppresses by a key that does not change when the underlying figure does', () => {})
it('keeps a twice-rejected recommendation away even when its evidence has changed', () => {})
it('offers accepted advice again only when the evidence is a different occurrence', () => {})
it('returns a snoozed recommendation once its date has passed, and not before', () => {})
```

Test 3 is Review Focus 5 and the one that matters: build a key for the same advice from two different months' figures and assert it is **the same string**. A key containing the amount resurfaces dismissed advice forever, and the owner's dismissal silently never takes.

- [ ] **Steps 2–6 as Task 1**, committing `feat: advice the owner rejected twice stops coming back`.

---

### Task 5: Recommendations, with their evidence

**Files:** Create `src/advice/recommendations.ts`, `src/advice/recommendations.test.ts`

**Interfaces:**
```ts
export type RecommendationId =
  | 'overspent-category' | 'small-purchases-add-up' | 'savings-inconsistent'
  | 'unusual-spend' | 'discretionary-rising' | 'regret-cluster'
export interface Evidence { transactionIds: string[]; summary: string }
export interface Recommendation {
  id: RecommendationId
  key: string              // stable across cycles; the suppression key of Task 4
  noticed: string          // what was noticed
  evidence: Evidence       // the transactions behind it, inspectable
  why: string              // why it matters
  todo: string             // what to do differently
  impactCents: number | null   // estimated financial impact; null when it cannot honestly be estimated
  confidence: 'high' | 'medium' | 'low'
  /** Digest of `evidence.transactionIds`. Task 4 decides with it whether accepted advice is a fresh occurrence. */
  evidenceFingerprint: string
}
export async function recommendationsFor(month: string, today: string, computedAt: number): Promise<Recommendation[]>
```

- Consumes: Task 4's `suppressedKeys`; `monthlyBudget`, `smallPurchases`, `monthSeries`, `unusualIn`, `regretClusters`; the battery's corrected findings from `src/battery/correction.ts` and `src/battery/finding.ts`.

**The six fields are §13.2's, verbatim, and all six are required on every recommendation.** `impactCents` is `null` rather than 0 when no honest estimate exists — a confident "0 €" is a claim, and A7 forbids a number for its own sake.

**The invariant this task exists to protect:** a battery finding that did **not** survive Benjamini–Hochberg correction must never become a recommendation. The whole point of Plan 6's correction is that an uncorrected finding is not something to act on, and advice is action.

- [ ] **Step 1: Write the failing tests**

```ts
it('fills all six fields the spec requires, on every recommendation it produces', () => {})
it('never raises advice from a finding that did not survive correction', () => {})
it('withholds an estimated impact it cannot honestly compute, rather than printing zero', () => {})
it('leaves out a recommendation the owner has rejected twice', () => {})
it('uses no causal or shaming wording in any field, for any recommendation', () => {})
it('drops evidence whose transaction has since been deleted, rather than showing a blank row', () => {})
```

Test 5 reads the banned-word lists out of `src/test/bannedWords.ts` and must also assert the extraction is not vacuous, as `finding.test.ts` does. Test 6 is Review Focus 6.

- [ ] **Steps 2–6 as Task 1**, committing `feat: advice that carries its evidence and its confidence`.

---

### Task 6: Educational notes and challenges

**Files:** Create `src/advice/education.ts`, `src/advice/education.test.ts`

**Interfaces:**
```ts
export type Topic =
  | 'opportunity-cost' | 'impulse-spending' | 'lifestyle-inflation'
  | 'small-purchase-accumulation' | 'savings-consistency' | 'value-of-money'
export interface Note { topic: Topic; title: string; body: string }
export type ChallengeId =
  | 'reduce-category' | 'no-spend-days' | 'twenty-four-hour-rule'
  | 'subscription-review' | 'savings-step-up'
export interface Challenge { id: ChallengeId; title: string; body: string; available: boolean; why?: string }
export function noteFor(id: RecommendationId): Note | null
export function challengesFor(id: RecommendationId, hasRecurringData: boolean): Challenge[]
```

**All six topics and all five challenges are named in §13.2 and all must exist.** A note is attached to the recommendation that triggered it, "so teaching is contextual rather than a lecture" — a note with no triggering recommendation is never shown, which is what `null` is for.

**`subscription-review` needs recurring-payment detection, which is Plan 8.** It is returned with `available: false` and a `why` that says the app cannot list subscriptions yet — not omitted silently, because a challenge that vanishes without explanation reads as a bug.

- [ ] **Step 1: Write the failing tests**

```ts
it('offers every one of the six topics from at least one recommendation', () => {})
it('attaches a note only to the recommendation that triggered it', () => {})
it('offers the five challenges, and says which cannot run yet and why', () => {})
it('uses no causal or shaming wording in any note or challenge', () => {})
it('assumes nothing about what the owner can afford', () => {})
```

Test 5 is anti-goal A1 made testable: scan every string for wording that presumes means — "just", "simply", "only", "cut back on luxuries", "you should be able to". **Add this list to `src/test/bannedWords.ts` beside the three already there, as a new named list, and read it back the way the others are read.** It is a distinct rule, not a copy of an existing one, so it is an addition rather than the fourth duplicate the constraints forbid — and putting it anywhere else would start the drift that module exists to stop. Assert it catches a sentence that violates it, so it cannot pass vacuously.

- [ ] **Steps 2–6 as Task 1**, committing `feat: the six lessons and five challenges, attached to what prompted them`.

---

### Task 7: The Money Score screen

**Files:** Create `src/ui/screens/Score.tsx`, `src/ui/screens/Score.test.tsx`. Modify `src/ui/routes.tsx`, `src/ui/shell.test.tsx`.

**`src/ui/shell.test.tsx` holds a `REAL` list and a `STUBS` list, and asserts the two together equal `ROUTES`.** Move `/score` from `STUBS` to `REAL` in the same commit, or this task's own commit fails that test — it is not Task 8's to do for you.

**Interfaces:**
- Consumes: `moneyScore`, `WEIGHTS`, the six component functions, and `cached`.

**There is no `Score.tsx` today.** `/score` renders the generic `Stub` component declared in `src/ui/routes.tsx`, through the `screen('/score', 'Money Score')` helper. Replace that entry with a real element, the way the nine built screens are wired, and follow whichever of them takes `today` and `computedAt` as props — `routes.tsx` is the only place that reads the clock.

§13.3: "The score shows every component, its weight, its inputs and the arithmetic, on the screen." All four, for all six components, including the ones that are not measured.

- [ ] **Step 1: Write the failing tests**

```ts
it('says the score cannot be given yet on a fresh install, and shows no number', () => {})
it('shows all six components, their weights, their inputs and the arithmetic', () => {})
it('marks a component not yet measured and says what it is waiting for', () => {})
it('shows the weight it actually divided by, not the total of all six', () => {})
it('reads the cache rather than the transactions table', () => {})
it('uses no causal, shaming or statistical wording anywhere on the page', () => {})
it('keeps focus and renders no control that does nothing', () => {})
```

- [ ] **Steps 2–6 as Task 1**, committing `feat: the money score, with its arithmetic on the page`.

---

### Task 8: The Learning and recommendations screen

**Files:** Create `src/ui/screens/Learning.tsx`, `src/ui/screens/Learning.test.tsx`. Modify `src/ui/routes.tsx`, `src/ui/shell.test.tsx`.

**Interfaces:**
- Consumes: `recommendationsFor`, `noteFor`, `challengesFor`, `recordShown`, `recordAccepted`, `recordRejected`, `recordSnoozed`, and `cached`.

**There is no `Learning.tsx` today** — `/learning` renders the generic `Stub`, exactly as `/score` does. Create it and replace the routes entry.

§15 names this screen "Learning and recommendations": it carries the advice, the note attached to each, and the challenges. **Move `/learning` from `STUBS` to `REAL` in `src/ui/shell.test.tsx`** — that table is asserted against `ROUTES`, so the two lists must agree. `/score` was moved by Task 7; leave it alone.

- [ ] **Step 1: Write the failing tests**

```ts
it('shows nothing to act on yet, without reading as a failure, on a fresh install', () => {})
it('shows all six fields of a recommendation, with its evidence inspectable', () => {})
it('lets the owner reject a recommendation, and stops showing it after the second time', () => {})
it('offers accept, snooze and reject, and each writes the state it claims to', () => {})
it('shows the note attached to a recommendation beside it, never on its own', () => {})
it('says which challenge cannot run yet and why, rather than hiding it', () => {})
it('uses no causal, shaming or statistical wording anywhere on the page', () => {})
it('keeps focus after a rejection, and renders no control that does nothing', () => {})
```

Test 3 is the one that proves Task 4 reached the screen: reject twice, reload, and assert it is gone.

- [ ] **Steps 2–6 as Task 1**, committing `feat: the learning screen carries the advice and what prompted it`.

---

## Self-review, run before dispatch

1. **Spec coverage.** §13.2's six fields → Task 5; its six educational topics and five challenges → Task 6; its tone rules → Tasks 5, 6, 7, 8. §13.3's six components → Tasks 1–2; its weighting, "not yet measured" exclusion and on-screen arithmetic → Tasks 3 and 7. §15's two screens → Tasks 7–8. §19's "recommendation suppression after repeated rejection" → Task 4. §13.4 (goals, recurring) and §13.5 (coach) are **out of scope** and belong to later plans; the two places this plan touches them — goal progress and the subscription challenge — both return a stated "not yet", never a zero or a silent omission.
2. **No schema change anywhere, and no new row shape either.** `recommendationState`, `savingsGoals` and `recurring` all exist in Dexie v1, and `RecommendationStateRow` already carries `status`, `shownCount`, `rejectedCount`, `lastShownAt`, `suppressedUntil` and `evidenceFingerprint` — every field Task 4 needs. **I drafted a narrower interface for Task 4 before reading the schema, and it would have conflicted with what is there**; the task now uses the stored row as it stands, which is also where the accept / snooze / suppress distinction comes from. Any task that believes it needs a migration or a new field has misread this plan and must stop and say so.
3. **Type consistency.** `Component` is defined once in Task 1 and used by 2, 3 and 7. `RecommendationId` is defined in Task 5 and consumed by Task 6. Every score is an integer 0–100, every share is bp, every amount is integer cents, and every "cannot say" is `not-measured` or `null` — never a zero.
4. **Review Focus.** Six items, each with its owning task named above.
5. **Proportion.** Eight tasks, exact signatures, named tests, no function bodies. The arithmetic that the spec fixes is stated once per component rather than re-argued per test.
