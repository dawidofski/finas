# Learning Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the app learn the owner's own categorisation from their corrections, so every import arrives better classified than the last, and every classification can say which tier produced it.

**Architecture:** A new `src/learning/` directory of pure, testable modules consulted in strict tier order (owner override → frequency memory → ING's category → Bayesian text classifier). The append-only `learningEvents` table is the only training record; frequency memory is *derived* from it at read time, never a second stored counter that could disagree with the log. The categoriser produces **suggestions with provenance**, which the import preview shows and the owner confirms — it never writes a category silently.

**Tech Stack:** React 18.3.1, TypeScript 5.5.4 (`strict`, `noUncheckedIndexedAccess`), Vite 8.3.8, Dexie 4.0.8 over IndexedDB, Vitest 5.1.0. No new runtime dependency: the classifier is a few dozen lines of integer arithmetic.

**Spec:** `docs/superpowers/specs/2026-11-15-personal-finance-intelligence-design.md` — §7.2 (the four tiers), §11 (the learning engine), §43 (the `typeOverride` gap this plan owns). Build-order stage 8.

**Scope boundary:** stages 9 and 10 of §18 — the analytics cache, dashboard, reports and the statistical battery of §12 — are **not** in this plan. §12's battery is explicitly a separate engine that never feeds the categoriser (§7.2), so nothing here depends on it. Two bullets of §11 are also out: **recommendation feedback** and **outcome tracking** both describe the life of a recommendation, and no recommendation exists until stage 11. They stay with that stage, not here.

**Two facts about the current codebase that the tasks below depend on, both verified before this plan was written:**
- **`src/db/seed.ts` seeds no merchants at all.** The `merchants` table is empty on a fresh install, so every path here must work from zero: there is no starter pattern to match against and no memory to read. The Intelligence screen opening on an empty table is the normal first experience, not an edge case.
- **`src/ui/screens/Intelligence.tsx` does not exist.** `/intelligence` is currently `screen('/intelligence', 'Intelligence', true)` in `src/ui/routes.tsx` — a `<Stub>` — and it is one of the five **primary** routes, so it sits in the mobile tab bar. Task 8 creates the file and replaces that entry with an explicit route, exactly as `/budget`, `/mood` and `/worth-it` already are.

## Global Constraints

- **No schema change.** `learningEvents`, `analyticsCache` and `recommendationState` already exist in version 1. §29 forbids any version above 1 until two gates are built, and this plan does not need one. If a task appears to need a new table or index, stop and report it rather than registering version 2.
- **All money is integer cents. All percentages and confidences are integers** (basis points or 0–100), never floats. `parseFloat` and `toFixed` are banned in `src/`.
- **All dates are ISO `YYYY-MM-DD` UTC strings.** Local-timezone `Date` methods, `new Date(...)` and `Date.now` are banned in `src/` outside the named allowlists in `src/sourceRules.test.ts`. Pure modules take `today` as an argument.
- **Facts come from the bank; classifications come from the owner (§41, §43).** A figure may use the owner's category. It may never read `amountCentsOverride` or `dateOverride`.
- **The engine never writes an annotation by itself.** It returns suggestions. Only the owner's confirmation writes, through the existing `writeAnnotation(id, patch, 'owner')`.
- **Owner-facing dates are Spanish** (`formatSpanishDate`, dd/MM/yyyy). Storage stays ISO.
- **A test for a rule must fail when the rule is removed.** Verify each new test by mutation and report the observed failure. Four tests in this project have passed for the wrong reason.
- **Reads stay bounded.** A screen may not read the whole `transactions` table to render. `learningEvents` may be scanned in full where a task says so, and only there.
- **Every categorisation records its tier.** "Here is the evidence" must be a fact about the data, not a sentence.

## Review Focus

- **A description that canonicalises to nothing** — every token is a stripped prefix, locality or country code. The engine must not create or match a merchant whose name is the empty string.
- **An owner correction that is later reverted.** The log is append-only, so a merchant corrected to Groceries and then back to Transport has two events. Frequency memory must reflect the owner's *latest* intent per transaction, not count both.
- **A merchant corrected twice to two different categories.** The tie must break deterministically and must not oscillate between imports.
- **The classifier with almost no training data** — one or two examples. It must stay silent below its confidence floor rather than emit a confident guess from a sample of one.
- **A canonicalisation rule changing after suggestions were cached.** A cached suggestion computed by an older engine must not be read as current.

---

### Task 1: Merchant canonicalisation

**Files:**
- Create: `src/learning/canonicalise.ts`
- Test: `src/learning/canonicalise.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `canonicaliseMerchant(description: string): string` — the canonical merchant name, or `''` when nothing survives. `merchantTokens(description: string): string[]` — the surviving tokens, exported for the classifier in Task 5.

- [ ] **Step 1: Write the failing tests**

```ts
it('strips the transaction prefix, the locality and the country code', () => {
  expect(canonicaliseMerchant('Pago en SUPERMERCADO EJEMPLO LOCALIDAD ES')).toBe('Supermercado Ejemplo')
})
it('handles every prefix ING uses', () => {
  for (const raw of ['Pago en TIENDA UNO ES', 'Pago Bizum en TIENDA UNO ES', 'Recibo de TIENDA UNO ES', 'Compra EN TIENDA UNO ES'])
    expect(canonicaliseMerchant(raw)).toBe('Tienda Uno')
})
it('normalises accents and case without destroying the letters', () => {
  expect(canonicaliseMerchant('Pago en CAFETERÍA ÁNGEL ES')).toBe('Cafetería Ángel')
})
it('returns the empty string when every token is stripped, and never a bare prefix', () => {
  expect(canonicaliseMerchant('Pago en ES')).toBe('')
  expect(canonicaliseMerchant('Recibo de')).toBe('')
  expect(canonicaliseMerchant('   ')).toBe('')
})
it('is idempotent: canonicalising a canonical name changes nothing', () => {
  expect(canonicaliseMerchant('Supermercado Ejemplo')).toBe('Supermercado Ejemplo')
})
it('keeps a digit that is part of the name, and drops a trailing card-terminal number', () => {
  expect(canonicaliseMerchant('Pago en TIENDA 24H LOCALIDAD ES')).toBe('Tienda 24H')
})
```

- [ ] **Step 2: Run them and watch every one fail** — `npx vitest run src/learning/canonicalise.test.ts`. Expected: module not found.

- [ ] **Step 3: Implement both functions**

The prefix list, the country codes and the locality rule are the only decisions here. Take the prefixes from the ING descriptions quoted in spec §5.1 and §11; strip a trailing two-letter uppercase country code and the locality token immediately before it. Title-case the survivors while preserving accented letters. **The empty result is a real answer, not a failure** — Task 2 must be able to tell "no merchant" from "a merchant called nothing".

- [ ] **Step 4: Run the tests and the global source guards** — `npx vitest run src/learning/ src/sourceRules.test.ts`. Expected: PASS.

- [ ] **Step 5: Verify by mutation** — delete the country-code strip, confirm the prefix test reddens, restore.

- [ ] **Step 6: Commit** — `feat: canonicalise an ING description to a merchant name`

---

### Task 2: Merchant patterns, and an owner edit that wins thereafter

**Files:**
- Create: `src/learning/merchants.ts`
- Test: `src/learning/merchants.test.ts`

**Interfaces:**
- Consumes: `canonicaliseMerchant` (Task 1); `MerchantRow` from `src/db/schema`, whose `matchPatterns: string[]` field exists and is **read by nothing today** — this task is what gives it its purpose.
- Produces: `matchMerchant(description: string, merchants: MerchantRow[]): MerchantRow | null` (pure); `rememberMerchantName(transactionId: string, canonicalName: string): Promise<MerchantRow>` — creates or reuses the merchant and adds the pattern derived from that transaction's description.

- [ ] **Step 1: Write the failing tests**

```ts
it('matches on a stored pattern before falling back to canonicalisation', () => {})
it('prefers the longest matching pattern, so a specific pattern beats a general one', () => {})
it('never matches a merchant whose pattern is empty, and never stores an empty pattern', () => {})
it('an owner-named merchant wins over the canonical name thereafter', async () => {})
it('reuses an existing merchant rather than creating a second with the same canonical name', async () => {})
it('is case- and accent-insensitive when matching, and keeps the owner spelling when storing', () => {})
```

Assert the exact tie-break in the second test: two patterns both matching, the longer one wins; equal lengths break by `createdAt` then `id`, so the result never depends on array order.

- [ ] **Step 2: Run them and watch them fail.**

- [ ] **Step 3: Implement.** `matchMerchant` is pure and takes the merchant list, so callers control the read. `rememberMerchantName` writes inside one Dexie `rw` transaction over `merchants` and `annotations`, as `linkRefund` does, so two quick taps cannot create two merchants.

- [ ] **Step 4: Run the tests.**

- [ ] **Step 5: Verify by mutation** — make the match prefer the shortest pattern, confirm the tie-break test reddens, restore.

- [ ] **Step 6: Commit** — `feat: merchant patterns, and an owner name that wins thereafter`

---

### Task 3: Frequency memory, derived from the event log

**Files:**
- Create: `src/learning/memory.ts`
- Test: `src/learning/memory.test.ts`

**Interfaces:**
- Consumes: `LearningEventRow` (`{ id, at, type, payload, outcome }`), and the `'category'` events that `writeAnnotation` already emits.
- Produces: `categoryMemory(): Promise<CategoryMemory>` where `CategoryMemory = ReadonlyMap<string, { categoryId: string; corrections: number; lastAt: number }>` keyed by merchant id; `rememberedCategoryFor(merchantId: string, memory: CategoryMemory): string | null`, which returns a category only at **two or more** corrections (§11: "corrected twice the same way becomes the default").

- [ ] **Step 1: Write the failing tests**

```ts
it('returns nothing after one correction and the category after two', async () => {})
it('counts the owner latest intent per transaction, not every event in the log', async () => {})
it('breaks a tie between two categories by the most recent correction', async () => {})
it('ignores events for a transaction that has since been soft-deleted', async () => {})
it('scans the log once, and is the only module that reads learningEvents', async () => {})
```

The second test is the Review Focus case: write a `'category'` event for Groceries and then one for Transport **on the same transaction**, and assert the memory holds one correction for Transport, not two corrections split one each. Append-only means the log keeps both; the memory must read the latest per transaction.

- [ ] **Step 2: Run them and watch them fail.**

- [ ] **Step 3: Implement.** A full scan of `learningEvents` is sanctioned here and nowhere else; say so in a comment. Fold events per transaction id first, then count per merchant, so a revert cannot inflate a count.

- [ ] **Step 4: Run the tests.**

- [ ] **Step 5: Verify by mutation** — count events instead of folding per transaction, confirm the revert test reddens, restore.

- [ ] **Step 6: Commit** — `feat: frequency memory derived from the append-only event log`

---

### Task 4: The four-tier categoriser

**Files:**
- Create: `src/learning/categorise.ts`
- Test: `src/learning/categorise.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3, and `categoryIdForIngPair(ing, ingSub)` from `src/db/annotations.ts` for tier 3.
- Produces:

```ts
export type Tier = 'owner' | 'memory' | 'ing' | 'classifier'
export interface Suggestion { categoryId: string; tier: Tier; confidence: number; because: string }
export function suggestCategory(tx: TransactionRow, ctx: CategoriserContext): Suggestion | null
```

`confidence` is an integer 0–100. `because` is the owner-facing evidence sentence, in the project's tone: no jargon, no causal claim.

`CategoriserContext` is defined in this task and is what keeps `suggestCategory` pure — the caller does every read and passes the result in:

```ts
export interface CategoriserContext {
  merchants: MerchantRow[]          // for matchMerchant (Task 2)
  memory: CategoryMemory            // from categoryMemory() (Task 3)
  ingCategoryFor: (ing: string, ingSub: string) => string | null   // tier 3, wrapping categoryIdForIngPair
  classify: (tokens: string[]) => { categoryId: string; confidence: number } | null  // tier 4, Task 5; null-returning when untrained
  categoryExists: (categoryId: string) => boolean   // so a deleted category is never suggested
  ownerCategoryFor: (transactionId: string) => string | null       // tier 1
}
```

Task 5 is built after this one, so until it lands `classify` is supplied as `() => null` and the tier-4 tests in this task use a stub. That is deliberate: tiers 1–3 must be provably correct without the classifier existing.

- [ ] **Step 1: Write the failing tests**

```ts
it('consults the tiers in order and stops at the first that answers', () => {})
it('an owner override wins over memory, ING and the classifier', () => {})
it('memory wins over ING', () => {})
it('falls through to ING when memory has fewer than two corrections', () => {})
it('returns null rather than guessing when every tier is silent', () => {})
it('reports the tier that produced the answer, and an evidence sentence naming it', () => {})
it('never suggests a category that does not exist', () => {})
```

The last one matters: a remembered or ING-mapped category may have been deleted since. Ruling P3-R7/R8's shape applies — tolerate it here rather than crash.

- [ ] **Step 2: Run them and watch them fail.**

- [ ] **Step 3: Implement.** Strict order, early return, one `switch`-free chain. Tier 4 is consulted through the context so Task 5 can be built after this one.

- [ ] **Step 4: Run the tests.**

- [ ] **Step 5: Verify by mutation** — swap tiers 2 and 3, confirm the "memory wins over ING" test reddens, restore.

- [ ] **Step 6: Commit** — `feat: the four-tier categoriser, with the tier it used`

---

### Task 5: The Bayesian text classifier (tier 4)

**Files:**
- Create: `src/learning/bayes.ts`
- Test: `src/learning/bayes.test.ts`

**Interfaces:**
- Consumes: `merchantTokens` (Task 1).
- Produces: `train(examples: { tokens: string[]; categoryId: string }[]): Model`; `classify(tokens: string[], model: Model): { categoryId: string; confidence: number } | null`. `Model` is defined and exported by this task — its shape is yours to choose, but it must be a plain serialisable object of integers and strings (no class, no closures), because a later plan will cache it in `analyticsCache`, whose `payload` is stored in IndexedDB. Integer arithmetic throughout: hold log-probabilities scaled to integers, or counts, and compare counts — **never a float**. A `MIN_EXAMPLES` floor and a `MIN_CONFIDENCE` floor, both named constants.

- [ ] **Step 1: Write the failing tests**

```ts
it('stays silent below the training floor, however lopsided the examples', () => {})
it('stays silent when its best guess is below the confidence floor', () => {})
it('classifies a clearly-seen merchant into the category it was trained on', () => {})
it('is unaffected by the order the examples were given in', () => {})
it('handles an unseen token without dividing by zero or returning NaN', () => {})
it('uses no floating-point arithmetic', () => {})
```

The last is a source-text assertion in the style of `src/sourceRules.test.ts`: the file must contain no `/`-division on money or probability and no `parseFloat`/`toFixed`.

- [ ] **Step 2: Run them and watch them fail.**

- [ ] **Step 3: Implement** multinomial naive Bayes with Laplace smoothing, in integers. The spec calls tier 4 "only ever a low-confidence suggestion the owner confirms", so cap its reported `confidence` below the floor used by tiers 1–3 and say why in a comment.

- [ ] **Step 4: Run the tests.**

- [ ] **Step 5: Verify by mutation** — drop `MIN_EXAMPLES` to 1, confirm the training-floor test reddens, restore.

- [ ] **Step 6: Commit** — `feat: a Bayesian suggester that stays quiet without evidence`

---

### Task 6: Suggestions in the import preview

**Files:**
- Modify: `src/import/pipeline.ts`, and the preview rendering in `src/ui/screens/Import.tsx`
- Test: `src/import/pipeline.test.ts`, `src/ui/screens/Import.test.tsx`

**Interfaces:**
- Consumes: `suggestCategory` and `Suggestion` (Task 4).
- Produces: each previewed row carries `suggestion: Suggestion | null`.

- [ ] **Step 1: Write the failing tests**

```ts
it('shows the suggested category and which tier suggested it', async () => {})
it('writes no annotation when the preview is only previewed', async () => {})
it('writes the suggestion only for the rows the owner confirms', async () => {})
it('loads the categoriser context once for the whole file, not per row', async () => {})
```

The second test is spec §37's property restated for this path: previewing a file must still touch nothing. The fourth is the bounded-read constraint — assert the merchant and memory reads happen once.

- [ ] **Step 2: Run them and watch them fail.**

- [ ] **Step 3: Implement.** Build the context once before the row loop. The preview renders the suggestion and its tier; confirmation goes through the existing owner write path so the learning event is emitted as it is for a manual correction.

- [ ] **Step 4: Run the full suite** — the import pipeline is the most heavily tested area in the project; a regression here shows up immediately.

- [ ] **Step 5: Verify by mutation** — write the suggestion at preview time, confirm the "previews touch nothing" test reddens, restore.

- [ ] **Step 6: Commit** — `feat: the import preview suggests a category and names its evidence`

---

### Task 7: Regret aggregation

**Files:**
- Create: `src/learning/regret.ts`
- Test: `src/learning/regret.test.ts`

**Interfaces:**
- Consumes: `resolveMany`, and the `worthwhile` annotation field.
- Produces: `regretClusters(month: string | null): Promise<RegretCluster[]>`, with the named type exported from this task for Task 8 to consume:

```ts
export interface RegretCluster {
  by: 'reason' | 'merchant' | 'category' | 'mood' | 'weekday'
  key: string        // the id, or the ISO weekday number as a string
  label: string      // owner-facing, Spanish for weekdays
  regretted: number  // spends marked worthwhile = No
  total: number      // spends in this cluster with worthwhile set either way — the denominator
  cents: number      // the bank amount of the regretted ones
}
```

Sorted by `regretted` descending, then `cents`, then `key`, so the order is total.

- [ ] **Step 1: Write the failing tests**

```ts
it('aggregates regretted spends by each of the five dimensions', async () => {})
it('reports the denominator, so one regret out of one is not shown as a pattern', async () => {})
it('buckets by the bank value date, so a corrected date cannot move a cluster', async () => {})
it('ignores soft-deleted transactions', async () => {})
it('names a weekday in Spanish, and derives it without a local-timezone Date method', async () => {})
it('returns an empty list rather than a cluster of one', async () => {})
```

- [ ] **Step 2: Run them and watch them fail.**

- [ ] **Step 3: Implement.** §41 applies: the bank's date and amount. The weekday comes from the ISO string through `src/lib/dates.ts`, never `getDay()`.

- [ ] **Step 4: Run the tests and the source guards.**

- [ ] **Step 5: Verify by mutation** — bucket by the resolved date, confirm the bank-date test reddens, restore.

- [ ] **Step 6: Commit** — `feat: aggregate regret into clusters that report their denominator`

---

### Task 8: The Intelligence screen

**Files:**
- Create: `src/ui/screens/Intelligence.tsx` — it does not exist yet
- Modify: `src/ui/routes.tsx`, replacing `screen('/intelligence', 'Intelligence', true)` with an explicit route that keeps `primary: true`; `README.md`, where "Six of the fourteen" becomes seven
- Test: `src/ui/screens/Intelligence.test.tsx`

**Interfaces:**
- Consumes: `categoryMemory` (Task 3), `regretClusters` (Task 7), `matchMerchant` (Task 2).

- [ ] **Step 1: Write the failing tests**

```ts
it('says what the engine has learned, per merchant, with the number of corrections behind it', async () => {})
it('says plainly that it has learned nothing yet, rather than showing an empty table', async () => {})
it('shows a regret cluster with its denominator and its period, and no causal wording', async () => {})
it('shows dates in Spanish format', async () => {})
it('is keyboard operable, and a control that does nothing is not rendered', async () => {})
```

The third test asserts the absence of causal language (`/because you|caused|makes you/i`) — spec §12 prohibits it in finding templates, and this is the first screen that renders findings. The fifth is ruling P3-R33's rule applied here.

- [ ] **Step 2: Run them and watch them fail.**

- [ ] **Step 3: Implement.** Follow the Budget screen's shape for loading, the empty state and the "not enough data yet" voice: say what is missing and how much more is needed (A2), never speculate.

- [ ] **Step 4: Run the suite.**

- [ ] **Step 5: Verify by mutation** — render the table when the memory is empty, confirm the empty-state test reddens, restore.

- [ ] **Step 6: Commit** — `feat: the Intelligence screen shows what was learned and what is still missing`

---

### Task 9: Close the §43 gap — `typeOverride` either counts or goes

**Files:**
- Modify: `src/analysis/income.ts`, `src/budget/month.ts`, `src/ui/annotations/TransactionEditor.tsx`
- Test: `src/analysis/income.test.ts`, `src/budget/month.test.ts`, `src/import/refunds.test.ts`

**The ruling this task implements.** Spec §43 left two honest options and gave the decision to this plan: either every figure honours `typeOverride`, or the control is removed because the app ignores it. **Honour it.** `kind` is a classification, the same species as `categoryId`, which is deliberately the owner's. §41 exists to stop a correction moving money between *months*, and a kind correction moves no row between months — it moves a row between *figures*, which is exactly what the owner means when they mark a mis-filed transfer as internal. The risk §41 guards against is money counted twice or counted nowhere, so the condition is that **both readers honour it identically**, through the one shared `treatmentOf`.

- [ ] **Step 1: Write the failing tests**

```ts
it('a spend re-kinded to internal leaves spending without appearing as income', async () => {})
it('a positive re-kinded to internal leaves income without appearing as spending', async () => {})
it('a re-kinded row stays in the month the bank dated it', async () => {})
it('every euro is still counted exactly once across the eleven arrangements', async () => {})
```

The fourth extends the existing money-conservation coverage rather than replacing it: add the re-kinded cases to the table the Plan 3 review built, and keep every existing expected figure.

- [ ] **Step 2: Run them and watch them fail.**

- [ ] **Step 3: Implement.** `treatmentOf` takes the **resolved** kind instead of the bank kind, at its one definition, and both callers pass the resolved value. Amount, sign and date stay the bank's — only `kind` moves to the resolved view. Update the §41/§43 comments at both call sites and the editor sentence that currently tells the owner Kind changes no figure.

- [ ] **Step 4: Run the full suite** — 928 tests must still pass, with the four new ones added.

- [ ] **Step 5: Verify by mutation** — revert `treatmentOf` to the bank kind, confirm two of the new tests redden, restore.

- [ ] **Step 6: Update the spec.** Rewrite §43 to record the decision and strike the gap; add a §45 noting that the editor sentence changed with it.

- [ ] **Step 7: Commit** — `feat: figures honour a kind correction, closing the spec 43 gap`
