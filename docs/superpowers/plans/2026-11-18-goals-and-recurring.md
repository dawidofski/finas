# Savings Goals and Recurring Payments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build §13.4 — savings goals with contributed, remaining and a ranged completion estimate, and detection of recurring payments — filling the `/goals` and `/recurring` stubs.

**Architecture:** A goal's contribution is derived, not stored: each month's *actual* savings are attributed to the goals in proportion to the owner's own goal allocations (§21.5 — a goal's contribution **is** a budget allocation). Recurring payments are detected by a pure function over bank rows grouped by merchant; only the owner's corrections (confirmed, cancelled) are stored, in the existing `recurring` table.

**Tech Stack:** React 18.3.1, TypeScript 5.5.4 (`strict`, `noUncheckedIndexedAccess`), Vite 8.3.8, Dexie 4.0.8, Vitest 5.1.0. **No new dependency.**

**Spec:** `docs/superpowers/specs/2026-11-15-personal-finance-intelligence-design.md` — §13.4, §21.5, §21.6, §15, anti-goals A1, A2, A7.

**No schema change.** `savingsGoals: 'id'`, `recurring: 'id, merchantId'` and `budgetAllocations: 'id, categoryId, savingsGoalId'` exist in Dexie v1, with `SavingsGoalRow` and `RecurringRow` in `src/db/schema.ts`. No table, index, version or row field is added.

## Global Constraints

- **No floating point anywhere in `src/`** (tree-wide guard in `src/sourceRules.test.ts`): integer cents, basis points, whole days. `matchScore` is stored 0–10000 bp, never 0–1 as a decimal.
- Dates are `'YYYY-MM-DD'` UTC strings via `src/lib/dates.ts`; no local-timezone `Date` methods. **Only `src/ui/routes.tsx` reads the clock**; `today` and `computedAt` are arguments.
- **Never read the whole `transactions` table** (§39.4): use `liveTransactionsBetween` and the existing bounded readers.
- Every figure takes amount, sign and date from the **bank** row; only classifications are the owner's (§41/§43).
- Derived figures go through `cached()`; **any table a cached figure reads and a screen can now edit must enter the cache digest** (`src/analytics/cache.ts` says so for `savingsGoals`).
- A1 no judging or shaming and no assumption about means; A2 no pattern from insufficient data; A7 no number for its own sake. Wording is checked with `violations()` over `appSpoken()` from `src/test/` — both list sets. Do not add a list or copy one.
- A part-period is not a small whole period: the running month never counts as a completed month.
- Commit by pathspec (`git commit -m … -- <paths>`); keep mutation scripts in a private scratchpad directory.

## Review Focus

1. **A goal with no savings behind it must not show progress.** Contributions come from savings that actually happened, never from the allocation alone. → Task 1 test 2.
2. **Attribution must conserve money.** The goals' contributions for a month sum to no more than that month's savings, to the cent, whatever the rounding. → Task 1 test 3.
3. **An estimate from two months is a guess.** The completion estimate is withheld below three completed months with a contribution, and is always a range. → Task 2 tests 2–3.
4. **A goal edit must not serve a stale figure.** Editing a target or allocation changes every cached figure that read it. → Task 3 test 4.
5. **Two payments are not a subscription.** Detection needs at least three occurrences, and a merchant paid at irregular gaps is `irregular`, not forced into monthly. → Task 5 tests 2 and 4.
6. **The owner's "this is not recurring" must survive re-detection.** → Task 6 test 2.
7. **A price change is the same subscription.** A small amount change stays in one cluster and is reported, not split into two. → Task 5 test 5.

---

### Task 1: Goal contributions, derived from savings that happened

**Files:** Create `src/goals/contributions.ts`, `src/goals/contributions.test.ts`

**Interfaces:**
```ts
export interface GoalMonth { month: string; goalId: string; contributedCents: number; allocatedCents: number }
/** Completed months only, oldest first; the running month is never included. */
export async function goalContributions(firstMonth: string, lastMonth: string, today: string): Promise<GoalMonth[]>
export function attribute(savedCents: number, allocations: readonly { goalId: string; allocatedCents: number }[]): Map<string, number>
```

- Consumes: `monthlyBudget(month, today)` from `src/budget/month.ts` (its `lines` with `targetKind: 'goal'` carry each goal's `allocatedCents`; `totals.savingsCents` is what was actually saved); `MonthPoint.hasData` via `monthSeries`.

**The rule, which is this plan's one modelling decision.** The schema ties no transaction to a goal, and no field may be added. So a month's contribution to a goal is: the month's actual `savingsCents`, shared between the goals **in proportion to their allocations for that month**, each goal capped at its own allocation. Savings above the sum of the goal allocations are unattributed and belong to no goal. `attribute` must conserve cents exactly — distribute by largest remainder with a fixed tie order (goal id), never by independent rounding.

- [ ] **Step 1: failing tests**
```ts
it('shares a month of savings between goals in proportion to their allocations', () => {})
it('contributes nothing in a month with an allocation but no savings', () => {})
it('never attributes more than was saved, to the cent, whatever the rounding', () => {})
it('caps a goal at its own allocation and leaves the rest unattributed', () => {})
it('leaves out the running month and any month with no records', () => {})
```
Test 3 is Review Focus 2: use three goals and a savings figure that does not divide evenly; assert the parts sum exactly and that the tie order is deterministic.

- [ ] **Steps 2–5:** run red; implement; mutate each rule (proportion, cap, conservation, running-month exclusion) and confirm a named test reddens; commit `feat: goal contributions from savings that actually happened`.

---

### Task 2: Progress and the ranged completion estimate

**Files:** Create `src/goals/progress.ts`, `src/goals/progress.test.ts`

**Interfaces:**
```ts
export interface GoalProgress {
  goalId: string; targetCents: number
  contributedCents: number; remainingCents: number      // remaining never below 0
  /** Null when it cannot honestly be estimated; otherwise a range of months, never a single date. */
  estimate: { earliestMonth: string; latestMonth: string } | null
  estimateWhy: string | null                             // owner-facing reason when estimate is null
  reached: boolean
}
export const MIN_ESTIMATE_MONTHS = 3
export function progressOf(goal: SavingsGoalRow, months: readonly GoalMonth[], lastCompletedMonth: string): GoalProgress
```

**The estimate (§13.4: "derived from the owner's observed contribution history with an explicit range").** Take the goal's monthly contributions over the completed months since it was created. Below `MIN_ESTIMATE_MONTHS` months with a contribution above zero: no estimate. Otherwise the range comes from the owner's own spread: the **faster** bound uses the upper-quartile monthly contribution, the **slower** bound the lower-quartile (integer quartiles via the existing `medianOf` in `src/lib/stats.ts` on the two halves). If the lower quartile is zero the slower bound is unbounded — say so in `estimateWhy` and give only "no sooner than". A goal already at or past its target is `reached` and has no estimate.

- [ ] **Step 1: failing tests**
```ts
it('reports contributed and remaining, and never a negative remaining', () => {})
it('withholds the estimate below three months with a contribution, saying what is short', () => {})
it('gives a range from the owner own faster and slower months, never one date', () => {})
it('says only "no sooner than" when some months had no contribution', () => {})
it('marks a goal reached once contributions meet the target', () => {})
```
- [ ] **Steps 2–5** as Task 1; commit `feat: goal progress with a ranged estimate`.

---

### Task 3: Goal operations and the cache digest

**Files:** Create `src/goals/store.ts`, `src/goals/store.test.ts`. Modify `src/analytics/cache.ts`, `src/analytics/cache.test.ts`.

**Interfaces:**
```ts
export async function createGoal(input: { name: string; targetCents: number; deadline: string | null; contributionPercentBp: number }, at: number): Promise<SavingsGoalRow>
export async function updateGoal(id: string, patch: Partial<Pick<SavingsGoalRow, 'name' | 'targetCents' | 'deadline' | 'contributionPercentBp'>>): Promise<void>
export async function archiveGoal(id: string): Promise<void>
export async function completeGoal(id: string, at: number): Promise<void>
```

Creating or changing a goal's `contributionPercentBp` writes the matching `budgetAllocations` row through the existing `saveAllocation` (§21.5: one allocation model) in the same transaction — a goal with no allocation would contribute nothing forever.

**The digest.** `inputsHash` in `src/analytics/cache.ts` documents that the first screen able to edit a savings goal must add `savingsGoals` to the digest **by content** (an edit is an in-place put, exactly like allocations). Add it the way `allocationText` does: fields named one by one in a fixed order. Update that file's long comment so it stays true — it currently says nothing in the app edits a goal.

- [ ] **Step 1: failing tests**
```ts
it('creates a goal together with its allocation, or neither', () => {})
it('refuses a target that is not a positive whole number of cents', () => {})
it('archives without deleting, and keeps past contributions readable', () => {})
it('changes the cache digest when a goal target or percentage is edited', () => {})
it('does not change the digest when nothing about any goal changed', () => {})
```
- [ ] **Steps 2–5** as Task 1; commit `feat: savings goals can be created and edited, and the cache notices`.

---

### Task 4: Goals reach the budget and the score

**Files:** Modify `src/budget/month.ts`, `src/budget/month.test.ts`, `src/score/components.ts`, `src/score/components.test.ts`, `src/ui/screens/Score.tsx`, `src/ui/screens/Score.test.tsx`.

Plan 7 left three things waiting for this:
- `src/budget/month.ts` sets a goal line's `spentCents` to a structural 0 ("No transaction is tied to a goal yet"). It becomes the month's attributed contribution from Task 1's `attribute`, applied to that month's own savings and goal allocations. **Do not call `goalContributions` from inside `monthlyBudget`** (it calls `monthlyBudget`); use the pure `attribute`.
- `budgetAwareness` excludes goal lines for that reason (ruling P7-R15). Restore them with the right direction: a **goal** line is respected when `spentCents >= allocatedCents`, a category line when `spentCents <= allocatedCents`.
- `goalProgress` is completion-only and takes goal rows. It becomes "weighted progress against each goal's own plan" (§13.3): contributed over target, weighted by target, capped at 100 per goal, from Task 2's `GoalProgress`. Not measured when there is no active goal; its `why` says no goal is set, never "no progress".

- [ ] **Step 1: failing tests**
```ts
it('shows a goal line as funded by the savings attributed to it that month', () => {})
it('respects a goal line by meeting it and a category line by staying under it', () => {})
it('scores goal progress as contributed over target, weighted by target', () => {})
it('still says no goal is set, rather than no progress, when there is none', () => {})
it('feeds the score screen the same progress the goals screen shows', () => {})
```
- [ ] **Steps 2–5** as Task 1; commit `feat: goal contributions reach the budget and the score`.

---

### Task 5: Recurring-payment detection

**Files:** Create `src/recurring/detect.ts`, `src/recurring/detect.test.ts`

**Interfaces:**
```ts
export type Frequency = RecurringRow['frequency']   // 'weekly' | 'monthly' | 'quarterly' | 'annual' | 'irregular'
export interface Detected {
  merchantId: string; amountCents: number; toleranceCents: number
  frequency: Frequency; occurrences: number
  lastSeenDate: string; expectedNextDate: string | null   // null for 'irregular'
  matchScoreBp: number                                     // 0–10000
  amountChanged: { fromCents: number; toCents: number } | null
}
export const MIN_OCCURRENCES = 3
export function detectRecurring(rows: readonly { merchantId: string; valueDate: string; amountCents: number }[]): Detected[]
```

Pure, over bank rows already resolved to a merchant. **Cluster** by merchant and near-equal amount: an amount joins a cluster when within `max(100 cents, 5% of the cluster median)` of it (integer arithmetic). **Frequency** from the median gap in days between consecutive payments: 5–9 weekly, 26–35 monthly, 80–100 quarterly, 350–380 annual, anything else `irregular`. **`matchScoreBp`** falls with the spread of the gaps around the median and rises with the count; state the formula in the doc comment and keep it monotone in both. **Expected next** is last seen plus the median gap. Fewer than `MIN_OCCURRENCES` is not reported at all (A2).

- [ ] **Step 1: failing tests**
```ts
it('finds a monthly payment from its gaps and says when the next is expected', () => {})
it('does not report a merchant paid only twice', () => {})
it('keeps two different amounts at one merchant as two payments', () => {})
it('calls irregular gaps irregular and gives no expected date', () => {})
it('treats a small price change as the same payment and reports the change', () => {})
it('scores a steadier payment above an uneven one with the same count', () => {})
```
- [ ] **Steps 2–5** as Task 1; commit `feat: recurring payments found from their gaps`.

---

### Task 6: Recurring store and the owner's corrections

**Files:** Create `src/recurring/store.ts`, `src/recurring/store.test.ts`. Modify `src/analytics/cache.ts`, `src/analytics/cache.test.ts` if a cached figure reads `recurring`.

**Interfaces:**
```ts
export interface RecurringView extends Detected { id: string; confirmedByUser: boolean; cancelled: boolean; monthlyCostCents: number }
export async function recurringPayments(today: string, computedAt: number): Promise<RecurringView[]>
export async function confirmRecurring(id: string): Promise<void>
export async function dismissRecurring(id: string): Promise<void>     // "this is not recurring"
export async function markCancelled(id: string): Promise<void>
```

Detection is recomputed over the last 14 completed months of spends (bounded read, bank dates); the `recurring` table holds one row per detected payment keyed by a **stable id** built from merchant and cluster (never from an amount that can change). A dismissed payment stays dismissed across re-detection; a confirmed one is shown even if its score later falls. `monthlyCostCents` normalises each frequency to a month with integer arithmetic (weekly × 52 ÷ 12, quarterly ÷ 3, annual ÷ 12; none for irregular). Each correction writes a learning event of an existing type if one fits; if none does, say so in the report rather than add a type.

- [ ] **Step 1: failing tests**
```ts
it('keeps a stable id for a payment when its amount changes', () => {})
it('keeps a payment the owner dismissed dismissed after re-detection', () => {})
it('shows a confirmed payment even when its score has fallen', () => {})
it('normalises every frequency to a monthly cost without a float', () => {})
it('reads a bounded window by the bank dates, never the whole ledger', () => {})
```
- [ ] **Steps 2–5** as Task 1; commit `feat: recurring payments the owner can confirm, dismiss or mark cancelled`.

---

### Task 7: The Goals screen

**Files:** Create `src/ui/screens/Goals.tsx`, `src/ui/screens/Goals.test.tsx`. Modify `src/ui/routes.tsx`, `src/ui/shell.test.tsx` (move `/goals` to REAL).

Follows `Score.tsx` and `Learning.tsx` for props (`today`, `computedAt`), loading and empty state. Shows, per goal: contributed, remaining, the estimate as a range **in words** (or the reason there is none), and how the contribution is worked out (savings shared by the owner's percentages) so the figure is not a mystery. Create, edit, archive and complete through Task 3.

- [ ] **Step 1: failing tests**
```ts
it('says no goal is set yet and how to set one, without reading as a failure', () => {})
it('shows contributed, remaining and the estimate as a range', () => {})
it('says why there is no estimate yet, in the owner terms', () => {})
it('creates a goal and shows it without a reload', () => {})
it('explains how savings are shared between goals', () => {})
it('uses no causal, shaming, means-assuming or statistical wording anywhere on the page', () => {})
it('keeps focus after an edit and renders no control that does nothing', () => {})
```
- [ ] **Steps 2–5** as Task 1; commit `feat: the savings goals screen`.

---

### Task 8: The Recurring screen, and what it unlocks

**Files:** Create `src/ui/screens/Recurring.tsx`, `src/ui/screens/Recurring.test.tsx`. Modify `src/ui/routes.tsx`, `src/ui/shell.test.tsx` (move `/recurring` to REAL), `src/ui/screens/Learning.tsx` and its test.

Shows merchant, amount, frequency, last payment, expected next payment and a confidence **in words** (from `matchScoreBp`; never the raw score, never "match score"), plus the total monthly cost of confirmed and undismissed payments. Confirm / not recurring / cancelled per row. A price change is stated. The Learning screen's `subscription-review` challenge becomes available when at least one recurring payment exists: pass `hasRecurringData` from `recurringPayments` and link the challenge to `/recurring`.

- [ ] **Step 1: failing tests**
```ts
it('says nothing recurring has been found yet and what it needs, without reading as a failure', () => {})
it('shows merchant, amount, frequency, last and expected next payment for each', () => {})
it('says how sure it is in words, never as a score', () => {})
it('removes a payment the owner says is not recurring and keeps it removed after a reload', () => {})
it('states a price change rather than showing two payments', () => {})
it('makes the subscription review challenge available once a payment exists', () => {})
it('uses no causal, shaming, means-assuming or statistical wording anywhere on the page', () => {})
```
- [ ] **Steps 2–5** as Task 1; commit `feat: the recurring payments screen`.

---

## Self-review

1. **Spec coverage.** §13.4 goals (funded by a percentage of actual income; contributed, remaining, ranged estimate from observed history) → Tasks 1–3, 7. §13.4 recurring (cluster by merchant and near-equal amount; frequency from gaps; merchant, amount, frequency, last, next, confidence; correctable, corrections kept) → Tasks 5, 6, 8. §21.5 one allocation model → Task 3. §21.6 `matchScore` named distinctly → Tasks 5, 8. Plan 7's three deferred hooks (goal lines, budget-awareness direction, goal progress) → Task 4; `subscription-review` → Task 8.
2. **Not in this plan:** linking a savings *account* to a goal (§21.5's round-up attribution) needs a row field and waits for the schema gates; the Mood queue's exclusion of recurring essentials (§15); the dashboard's subscription-cost tile (§13.1).
3. **No schema change:** every table and row shape used exists in v1. `matchScore` is stored in bp in the existing numeric field.
4. **Type consistency:** `GoalMonth` (Task 1) feeds `progressOf` (Task 2) and Task 4; `Detected` (Task 5) is extended by `RecurringView` (Task 6) and rendered by Task 8; all money is integer cents, all shares bp.
5. **Review Focus:** seven items, each with an owning task and test.
