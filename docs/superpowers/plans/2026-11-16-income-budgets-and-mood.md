# Income, Percentage Budgets and Mood Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the imported ledger into a monthly picture the owner can act on — what came in, what each category was allocated, what it actually spent — and collect the two annotations (mood and hindsight) that every later plan's analysis depends on.

**Architecture:** Three pure computation modules over the existing Dexie tables (`income`, `allocations`, `month`), each returning plain data with no caching, plus four screens that render them. Annotations continue to go through `writeAnnotation`; nothing here writes a bank row. Figures aggregate across all accounts with paired transfers netted to zero (§21.1).

**Tech Stack:** React 18.3.1, TypeScript 5.5.4 (`strict`, `noUncheckedIndexedAccess`), Vite 8.3.8, Dexie 4.0.8, Vitest 5.1.0. No new runtime dependency.

**Spec:** `docs/superpowers/specs/2026-11-15-personal-finance-intelligence-design.md` — principally §10 (income and percentage budgeting), §11 (the learning record), §13.1/§13.4, §15 (the two queues), §21.1–§21.5, §23.2, and §39, which this plan is explicitly bound to close.

## Global Constraints

- EUR only; all money is signed integer cents via `src/lib/money.ts`. No `parseFloat` on a monetary value, no floating-point arithmetic on amounts. Percentages are **basis points** (`percentBp`), through `applyPercentBp` / `percentBpOf`.
- All dates are `YYYY-MM-DD`; conversion only through `src/lib/dates.ts`. Local-timezone `Date` methods are forbidden and a source-text test enforces it. **A month is the `YYYY-MM` prefix of `valueDate`** — the bank's own value date, never an import or annotation timestamp.
- **`transactions` is immutable after import** except `deletedAt` (§8.1). Every owner input in this plan — mood, reason, worthwhile, note, refund link — is an `annotations` row written through `writeAnnotation(id, patch, 'owner')`, which emits one learning event per changed field (§34.6).
- **Read `db.<table>` at call time**, never captured at module scope.
- **No schema version above 1 may be registered** until §29's two gates are closed. Every field this plan needs already exists in the v1 schema; if a task believes it needs a new field, that is a finding for the controller, not a migration.
- **Figures aggregate across every account** (§21.1), with both legs of a matched `transfers` row excluded. A per-account budget is meaningless when money moves between accounts.
- **No analytics cache yet.** §7.1's cache arrives with the dashboard (build stage 9). These modules compute from the tables on each call and must stay pure functions of their inputs so a cache can wrap them later without changing them.
- Mobile-first: the owner's phone is a Galaxy S26. Touch targets at least 48 px, no horizontal page scroll at 375 px, every dialog closes on Escape and returns focus to its opener.
- Copy rules (§13.2, A1): no shaming, no assumptions about the owner's means, no guessed cause stated as fact. A queue that is empty says what that means, not that the owner has done nothing.
- Every test asserts; none is skipped or given an inflated timeout. No real personal data in fixtures — invented names, invented digits, nothing that reads as a real IBAN or a real person.

## Rulings carried into this plan

Four cross-stage dependencies the spec's own build order leaves open. They are settled here so no implementer has to guess.

1. **Automatic refund matching is deferred to Plan 4; the manual link ships here.** §10 wants a positive amount matched "to an earlier spend at the same merchant within 90 days", but merchant canonicalisation is build stage 8 and the `merchants` table is still empty — there is no merchant identity to match on. Plan 3 therefore ships the half that does not need it: an unconfirmed positive is flagged, and the owner can link it to a specific earlier spend by hand, which writes `transfers.linkKind: 'refund'` and reduces that category's spending. The automatic offer is Plan 4's, once canonical merchants exist.
2. **The mood queue excludes essentials by category kind, not by recurring detection.** §15 says recurring essentials are excluded by default; recurring detection is build stage 13. Until it exists, the exclusion is `kind === 'internal' | 'roundup'` plus any transaction whose resolved category kind is `essential`. The setting's name must describe what it does today.
3. **A refund reduces category spending; it is never income.** A linked refund is excluded from `netIncome` and subtracted from its category's actual spend in the same month as the original purchase's category, on the refund's own date.
4. **Allocations may exceed 100 % of income** (§21.5). The budget screen states the overcommitment plainly and does not block it.
5. **Amortising annual bills across twelve months is deferred.** §10 offers it as an option in budget views, but nothing can yet tell an annual bill from an ordinary one — that is recurring detection, build stage 13. The fixed-EUR allocation shipped in Task 2 is the manual path meanwhile, which is what §10 names annual bills in the same breath as. Revisit when recurring rows exist.
6. **A partial month uses actual income once any has landed.** §10 can be read as "provisional until the month ends", but it also says the basis is "recomputed the moment real income lands", and the owner is better served by the real figure than by an average they have already beaten. So: actual income when the month has any, the trailing average when it has none, and the `partial` flag tells the screen to present actuals as month-to-date either way.

## Review Focus

Five input classes the spec implies but no task's tests would otherwise exercise, most likely to bite the owner first. Each has a test attached to the task that owns the code.

1. **A month with no income at all.** Every allocation is a percentage of zero. The provisional basis (trailing three months) must carry the whole month, labelled provisional everywhere, and must itself survive having no history to average. *(Task 1)*
2. **A month that is not over yet.** Today is inside the month being viewed, so actuals are partial. Month-to-date figures must be shown as such and must never be compared against a full month's allocation without saying so. *(Task 3)*
3. **An allocation edited mid-month.** `effectiveFrom` means a month's budget can change under the owner's feet. Exactly one allocation must apply to a given month per target, and the rule for which must be stated and tested. *(Task 2)*
4. **A transfer pair whose legs sit in different months.** ING can date the two legs differently (§9.2's ±3-day window exists for it). Netting to zero must hold across a month boundary, or one month shows phantom income and the next phantom spending. *(Task 1)*
5. **An annotation on a transaction the owner later deletes.** The mood and worthwhile queues must not offer deleted rows, and existing annotations on a deleted row must not be counted in any figure. *(Tasks 6 and 7)*

## File Structure

| File | Responsibility |
|---|---|
| `src/analysis/income.ts` | `netIncome` for a month, transfer-pair and refund exclusion, the trailing-average provisional basis. |
| `src/budget/allocations.ts` | Reading, writing and resolving `budgetAllocations`: the category-XOR-goal rule and which allocation applies to a month. |
| `src/budget/month.ts` | One month's budget: per-target allocated euros, actual spend, remaining, variance, unallocated remainder, overcommitment, provisional flag. |
| `src/ui/screens/Budget.tsx` | The monthly budget screen and the allocation editor. |
| `src/ui/screens/Mood.tsx` | The mood triage queue and the "Worth it?" hindsight queue. |
| `src/ui/annotations/` | The shared mood row, reason chips and worthwhile buttons, used by both the queues and the transaction editor. |
| `src/import/refunds.ts` | The manual refund link and the unconfirmed-positive flag. |

---

### Task 1: Income

**Files:** Create `src/analysis/income.ts`, `src/analysis/income.test.ts`.

**Interfaces:**
- Consumes: `db`, `TransactionRow`, `TransferRow`.
- Produces:
  `netIncome(month: string): Promise<{ cents: number; provisional: boolean; basis: 'actual' | 'trailing-average' | 'none'; monthsAveraged: number }>`;
  `incomeBasisFor(month: string): Promise<number>` — the figure allocations are computed against, actual or provisional;
  `excludedTransactionIds(month: string): Promise<Set<string>>` — the transfer legs and linked refunds netted out, exported so the budget module cannot re-derive it differently.

- [ ] **Step 1: Write the failing tests**

```ts
it('sums income rows for the month across every account', async () => {})
it('excludes both legs of a matched transfer, however large', async () => {})
it('excludes a transfer pair whose legs fall in different months', async () => { /* Review Focus 4: neither month may show the leg it holds */ })
it('excludes a positive linked as a refund', async () => { /* ruling 3 */ })
it('counts an unconfirmed positive as income', async () => { /* §10: unconfirmed positives default to income */ })
it('ignores soft-deleted rows', async () => {})
it('falls back to the trailing three-month average when the month has no income', async () => { /* Review Focus 1: provisional true, basis 'trailing-average' */ })
it('uses actual income as soon as any lands, even mid-month', async () => { /* ruling 6 */ })
it('averages only the months it has, and reports how many', async () => {})
it('reports basis none when there is no income anywhere', async () => { /* must not divide by zero */ })
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.** One pass over the month's transactions plus one read of `transfers`. `kind === 'income'` minus the excluded set. The trailing average covers the three calendar months before the requested one, counting only months that have at least one transaction (a month with transactions and no income is a real zero and must be averaged in; a month with no data at all is not).
- [ ] **Step 4: Run to verify passing.**
- [ ] **Step 5: Commit.** `feat: monthly net income with a provisional trailing basis`

---

### Task 2: Budget allocations

**Files:** Create `src/budget/allocations.ts`, `src/budget/allocations.test.ts`.

**Interfaces:**
- Produces:
  `saveAllocation(input): Promise<BudgetAllocationRow>` — validates the category-XOR-goal rule (§23.2) and percent-XOR-fixed, and refuses both violations with an owner-facing message;
  `allocationsFor(month: string): Promise<BudgetAllocationRow[]>` — the one allocation per target in force for that month;
  `deleteAllocation(id: string): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

```ts
it('refuses an allocation targeting both a category and a goal', async () => { /* §23.2 */ })
it('refuses an allocation targeting neither', async () => {})
it('refuses an allocation that is both a percentage and a fixed amount', async () => {})
it('accepts a fixed-EUR allocation for an annual bill', async () => { /* §10 */ })
it('returns the latest allocation whose effectiveFrom is on or before the month', async () => { /* Review Focus 3 */ })
it('returns nothing for a month before the first effectiveFrom', async () => {})
it('keeps one allocation per target when several are in force', async () => {})
it('rejects a negative or non-integer percentBp', async () => {})
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.** `effectiveFrom` is a `YYYY-MM-DD`; the allocation in force for a month is the one with the greatest `effectiveFrom` **on or before the last day of that month**, per target. Document that choice in a comment: it means an allocation edited mid-month applies to the whole of that month, which is the behaviour the owner expects from a budget.
- [ ] **Step 4: Run to verify passing.**
- [ ] **Step 5: Commit.** `feat: budget allocations with category-or-goal targeting`

---

### Task 3: The monthly budget

**Files:** Create `src/budget/month.ts`, `src/budget/month.test.ts`.

**Interfaces:**
- Consumes: Task 1's `incomeBasisFor` and `excludedTransactionIds`, Task 2's `allocationsFor`.
- Produces:
  `monthlyBudget(month: string, today: string): Promise<MonthlyBudget>` where
  `MonthlyBudget { month; income: { cents; provisional; basis }; partial: boolean; lines: BudgetLine[]; unallocatedCents: number; overcommittedBp: number; totals: { spentCents; essentialCents; discretionaryCents; savingsCents; savingsRateBp } }`
  and `BudgetLine { targetKind: 'category' | 'goal'; targetId; label; allocatedCents; spentCents; remainingCents; varianceBp: number | null; fixed: boolean; unbudgeted: boolean }`.

  **Notes for the screen.** A line with `unbudgeted: true` is spending with no allocation behind it — group those separately, and key on that field, never on `targetId`, which is the empty string on the uncategorised line. `varianceBp` and `overcommittedBp` are null wherever there is no basis for a percentage; render nothing there rather than a zero. A parent line covers only spending not claimed by an allocated descendant (most specific wins), so its label must say so.

  **Two shape changes ruled during implementation.** A category with spending and no allocation still gets a line (`allocatedCents: 0`, `unbudgeted: true`), because otherwise the lines sum to less than the total and the owner cannot tell whether the app lost money or they forgot an allocation — §10 asks for per-category figures, not per-allocation ones. And `varianceBp` is `null` whenever the allocation is zero: positive-when-overspent is the convention, but `0` on an unbudgeted line reads as "exactly on budget" when the truth is "there was no budget".

- [ ] **Step 1: Write the failing tests**

```ts
it('computes a percentage allocation against the month income', async () => { /* 15% of 2000 € is 300 € */ })
it('computes the same percentage against a different income', async () => { /* 15% of 2400 € is 360 € */ })
it('marks every figure provisional when the income basis is provisional', async () => {})
it('reports the month as partial when today falls inside it', async () => { /* Review Focus 2 */ })
it('sums spending per category from the resolved category, not the ING pair', async () => { /* §34.3 */ })
it('subtracts a linked refund from its category', async () => { /* ruling 3 */ })
it('counts round-ups as savings, not spending', async () => {})
it('splits essential from discretionary by subcategory kind', async () => { /* §21.2 */ })
it('reports the unallocated remainder', async () => {})
it('reports overcommitment without refusing it', async () => { /* §21.5: allocations may exceed 100% */ })
it('excludes both legs of a matched transfer from every total', async () => {})
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.** One read of the month's transactions, resolved through `resolveMany` so owner overrides win over derived categories. `partial` is `month === today.slice(0, 7)`. `savingsRateBp = percentBpOf(savingsCents, incomeCents)` guarded against a zero basis.
- [ ] **Step 4: Run to verify passing.**
- [ ] **Step 5: Commit.** `feat: the monthly budget computation`

---

### Task 4: The budget screen

**Files:** Create `src/ui/screens/Budget.tsx`, `src/ui/screens/Budget.test.tsx`. Modify `src/ui/routes.tsx`.

- [ ] **Step 1: Write the failing tests**

```tsx
it('shows each allocation with its euros and its percentage', async () => { /* §10: every figure in both EUR and percent */ })
it('says plainly when the income basis is provisional, and why', async () => {})
it('says the month is still running and shows month-to-date actuals', async () => {})
it('states overcommitment without blocking it', async () => {})
it('adds, edits and removes an allocation', async () => {})
it('refuses an allocation the data layer rejects, showing its message', async () => {})
it('shows an empty state that says what to do first', async () => { /* copy rules: no shaming */ })
it('groups spending in categories with no allocation as unbudgeted', async () => { /* the lines must account for the total */ })
it('never shows a variance percentage for an unbudgeted line', async () => { /* varianceBp is null there, not 0 */ })
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.** Replace the `/budget` `Stub` in `routes.tsx` as `/import` and `/transactions` already are. Month navigation defaults to the current month. One figure per row with its percentage beside it; the provisional label travels with the figure, not just the header.
- [ ] **Step 4: Run the full suite, build and `verify:dist`.**
- [ ] **Step 5: Commit.** `feat: the monthly budget screen`

---

### Task 5: Mood, reason and worthwhile controls

**Files:** Create `src/ui/annotations/MoodRow.tsx`, `ReasonChips.tsx`, `WorthwhileButtons.tsx`, and tests. Modify `src/ui/TransactionEditor.tsx`.

**Interfaces:**
- Produces three controlled components taking `value` and `onChange`, reading their vocabulary from `db.moods` / `db.purchaseReasons` ordered by `order`, excluding `archived` rows.

- [ ] **Step 1: Write the failing tests**

```tsx
it('renders the seeded moods as a one-tap row with their emoji', async () => { /* §15 */ })
it('hides an archived mood but still renders it on a transaction that uses it', async () => { /* §21.3: history stays valid */ })
it('renders purchase reasons as chips and worthwhile as three buttons', async () => {})
it('writes mood, reason and worthwhile through writeAnnotation in one patch', async () => { /* §34.6 */ })
it('clears a mood back to none', async () => {})
it('keeps every control reachable by keyboard', async () => {})
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.** Large touch targets; the note stays collapsed by default (§15). The editor sends one patch per save, as it already does.
- [ ] **Step 4: Run to verify passing.**
- [ ] **Step 5: Commit.** `feat: mood, reason and worthwhile controls`

---

### Task 6: The mood triage queue

**Files:** Create `src/ui/screens/Mood.tsx`, `src/ui/screens/Mood.test.tsx`, `src/analysis/queues.ts`, `src/analysis/queues.test.ts`. Modify `src/ui/routes.tsx`, `src/db/seed.ts` (settings defaults only — no schema change).

**Interfaces:**
- Produces `moodQueue(opts): Promise<ResolvedTransaction[]>` — oldest first, and `dayMood(date, moodId)` applying a day-level mood to that day's unannotated transactions.

- [ ] **Step 1: Write the failing tests**

```ts
it('queues only transactions that warrant a mood', async () => { /* ruling 2: excludes internal, roundup and essential */ })
it('excludes transactions that already have a mood', async () => {})
it('excludes soft-deleted transactions', async () => { /* Review Focus 5 */ })
it('applies a day-level mood only to the unannotated transactions of that day', async () => { /* §15 */ })
it('respects the setting that turns prompting off', async () => { /* moodPrompting.enabled already exists */ })
it('presents one transaction at a time, oldest first', async () => {})
it('says the queue is empty in a way that is not a reproach', async () => {})
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.** Replace the `/mood` `Stub`. The eligibility rule lives in `queues.ts` so both queues share one definition of "worth annotating".
- [ ] **Step 4: Run to verify passing.**
- [ ] **Step 5: Commit.** `feat: the mood triage queue`

---

### Task 7: The "Worth it?" hindsight queue

**Files:** Modify `src/analysis/queues.ts`, `src/ui/screens/Mood.tsx` and their tests.

**Interfaces:**
- Produces `worthwhileQueue(opts: { olderThanDays: number; today: string }): Promise<ResolvedTransaction[]>`.

- [ ] **Step 1: Write the failing tests**

```ts
it('queues discretionary spending at least seven days old with a mood or reason and no judgement', async () => { /* §21.4, all four conditions */ })
it('excludes spending younger than the threshold', async () => {})
it('excludes a transaction already judged', async () => {})
it('excludes soft-deleted transactions', async () => { /* Review Focus 5 */ })
it('honours a changed delay setting', async () => { /* §21.4: the delay and filters are settings */ })
it('orders oldest first', async () => {})
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.** Three taps per item: yes, no, skip. §21.4 is explicit that without this flow the regret learning, the worthwhile report and Money Score component 6 never populate — so the queue must be reachable from the navigation, not only from a dashboard card that does not exist yet.
- [ ] **Step 4: Run to verify passing.**
- [ ] **Step 5: Commit.** `feat: the worth-it hindsight queue`

---

### Task 8: Refund links

**Files:** Create `src/import/refunds.ts`, `src/import/refunds.test.ts`. Modify `src/ui/screens/Transactions.tsx`.

**Interfaces:**
- Produces `unconfirmedPositives(month): Promise<ResolvedTransaction[]>`; `linkRefund(positiveId, spendId): Promise<TransferRow>`; `unlinkRefund(transferId): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

```ts
it('links a positive to an earlier spend as linkKind refund', async () => { /* §32.2 */ })
it('refuses a link to a later transaction', async () => {})
it('refuses a link to a spend more than 90 days earlier', async () => { /* §10 */ })
it('refuses a second link for an already-linked positive', async () => {})
it('flags an unconfirmed positive that is not a known transfer leg', async () => {})
it('removes the link and restores the positive to income', async () => {})
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.** The link is a `transfers` row with `linkKind: 'refund'`, `confirmedByUser: true` and `matchScore: 100` — the owner *is* the evidence. **The original spend goes in `outTransactionId` and the refund positive in `inTransactionId`**, matching the convention `pairAcrossAccounts` already uses: money out, money in. Task 1 identifies the refund leg by its sign rather than by the field name — deliberately, so a row filled in the wrong order cannot silently exclude the wrong transaction — but the row must still be semantically correct for every later reader. Assert the convention in a test. Ruling 1 applies: no automatic offer in this plan.
- [ ] **Step 4: Run to verify passing.**
- [ ] **Step 5: Commit.** `feat: manual refund links`

---

### Task 9: Closing spec §39

**Files:** Modify `src/ui/screens/Settings.tsx`, `src/ui/screens/Transactions.tsx`, `src/ui/screens/Import.tsx`, `src/ui/app.css` and their tests.

Each item is §39's, with its subsection named so the implementer can read the reasoning.

- [ ] **Step 1: Write the failing tests**

```tsx
it('turns storeLast4 off and relabels existing accounts', async () => { /* §39.1 */ })
it('accepts an owner-chosen account label and refuses one that looks like an account number', async () => { /* §39.1, §14.1; the accounts guard already refuses it — surface its message */ })
it('collapses the transaction filters by default and remembers the choice', async () => { /* §39.3 */ })
it('shows a deleted-row count when any exist', async () => { /* §39.3 */ })
it('loads at most one page of transactions from the database', async () => { /* §39.4: the DOM bound exists; this bounds the query */ })
it('shows every owner-facing date in Spanish format', async () => { /* 16/11/2026, not 2026-11-16 — see below */ })
it('tells the owner when a round-up could not be matched to a purchase', async () => { /* §39.2 */ })
it('lets the owner choose the parent purchase, writing roundupParentIdOverride', async () => { /* §39.2 + §32.3: the field was added in Plan 1 and still has no writer; this is it */ })
```

- [ ] **Step 2: Run to verify failure.**
**Dates shown to the owner are in Spanish format.** Found by the controller in a real browser: the budget screen says "up to 2026-11-16" and the transactions list renders its date column as `2026-11-08`. `src/lib/dates.ts` has `parseSpanishDate` for input and **no formatter for output**, so every screen has been printing the storage format since Plan 2. The spec requires Spanish/European formats throughout. Add one `formatSpanishDate(iso: string): string` helper — `dd/MM/yyyy`, built by string manipulation, with no local-timezone `Date` methods — and use it everywhere a date reaches the owner: the transactions list and editor, the import preview and its coverage sentences, and the budget screen. Storage, comparison, keys and every `YYYY-MM-DD` the code reasons about stay exactly as they are; this is a presentation change only. A test asserts that no owner-facing string carries a `YYYY-MM-DD`.

- [ ] **Step 3: Implement.** §39.4 is the one with teeth: `loadAll` currently reads and resolves every transaction and re-runs after every save. Bound the query, and keep the existing 3,000-row test passing.
- [ ] **Step 4: Run the full suite, build and `verify:dist`.**
- [ ] **Step 5: Commit.** `feat: close the items Plan 2 carried into Plan 3`

---
