# Import and Transactions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The owner drops an ING Spain statement into the app and sees their real transactions, correctly categorised, free of duplicates, and editable — with every correction preserved against later imports.

**Architecture:** A pure pipeline from bytes to a reviewable preview — detect, read, scrub, normalise, verify, dedup, pair — with a single atomic commit at the end. Nothing touches the database until the owner approves the preview. The resolved view (`transaction ⊕ annotation`) and the annotation write path live in one module so the resolution rule, the dedup rule and the learning-event rule each exist exactly once.

**Tech Stack:** Existing only — React 18, TypeScript 5.5 strict, Dexie 4, fflate 0.8.3 for the XLSX container, the platform `DOMParser` and `crypto.subtle`. No new runtime dependency.

**Spec:** `docs/superpowers/specs/2026-11-15-personal-finance-intelligence-design.md` — read §5 (evidence), §8–§9, §14.1, §21.2, §22.3, §30, and **§32–§34**, which were written for this plan and supersede anything older they touch.

## Global Constraints

- EUR only; all money is signed integer cents via `src/lib/money.ts`. No `parseFloat` on a monetary value.
- All dates are `YYYY-MM-DD`; conversion only through `src/lib/dates.ts`.
- **The account number and the holder's name must never be persisted.** The number becomes a salted SHA-256 fingerprint; the name is tokenised, used to scrub descriptions, and discarded (§14.1). `last4` **is** stored when `privacy.storeLast4` is true (§34.5).
- **The uploaded file is never persisted.** Read into memory, parsed, dropped.
- **`transactions` is immutable after import** except `deletedAt`; every owner edit is an `annotations` override (§8.1). The Dexie `updating` hook enforces this and will throw.
- **`dedupKey = sha256(accountId | valueDate | amountCents | balanceCents)`** — **the description is not in the key** (§37, which supersedes §33.1). A running balance plus an amount places a transaction at exactly one point in the ledger; verified unique across all 100 rows of both real exports. The key therefore cannot derive from the holder's name by any route, and it does not depend on the scrub.
- **Read `db.<table>` at call time**, never captured at module scope: declaring a migration rebuilds Dexie's table objects.
- **The service worker must not reload the page during an import** (§34, Task 9).
- **Test fixtures are synthesised in code** with `fflate.zipSync` from anonymised literal rows (§34.7). `.gitignore` excludes every spreadsheet extension and CI runs on a clean checkout, so a committed binary fixture would be silently absent. The owner's real files are **not** in the project: the current account is at the repo root, the savings export is in `Downloads`. Any test touching them is environment-gated and skips when the variable is absent.
- TypeScript `strict: true`, `noUncheckedIndexedAccess: true`. No new runtime dependency. No CDN request. No analytics or telemetry. No financial record in the repository.
- Copy rules (§13.2, A1): no shaming, no assumptions about the owner's means.

## Review Focus

1. **A file that is not an ING export** — a random spreadsheet, a corrupt or truncated zip, an empty file, something enormous. Refused with a readable message, never a crash, hang or half-import. — Task 3.
2. **An ING export whose columns have moved or been renamed.** Must fail loudly naming the header expected and found, never silently mis-map a column. — Task 5.
3. **The same file imported twice.** Refused at preview by file hash, naming the date of the previous import (§34.4). — Task 9.
4. **A category pair not in the seed.** Auto-created, defaulted to `discretionary`, flagged for review (§21.2) — not a throw and not a silent drop. — Task 9.
5. **An edited transaction meeting a later overlapping import.** The correction survives and the row is still recognised as a duplicate, because the key reads bank values only. — Task 6.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/db/annotations.ts` | Resolved view, the single annotation write path, learning-event append |
| `src/import/detect.ts` | Format detection by magic bytes; size limits; `ImportError` |
| `src/import/xlsx.ts` | XLSX container → raw cell grid |
| `src/import/scrub.ts` | Identity stripping, account fingerprint, description scrub |
| `src/import/normalise.ts` | Raw grid → candidate rows: dates, cents, kind, `dedupKey`, balance chain |
| `src/import/dedup.ts` | The four-branch duplicate decision |
| `src/import/coverage.ts` | Per-account covered ranges; bidirectional gap analysis |
| `src/import/pairing.ts` | Round-up parent linking; cross-account transfer pairing |
| `src/import/pipeline.ts` | Orchestration: bytes → `ImportPreview` |
| `src/import/commit.ts` | Atomic commit of an approved preview |
| `src/import/__fixtures__/build.ts` | Synthesises XLSX bytes for tests |
| `src/ui/screens/Settings.tsx` | Backup: export, inspect, restore |
| `src/ui/screens/Import.tsx` | File intake and the preview |
| `src/ui/screens/Transactions.tsx` | List, search, sort, filter, soft delete |
| `src/ui/TransactionEditor.tsx` | The edit sheet |
| `src/pwa.ts` *(modify)* | `suspendReload()` / `resumeReload()` |

---

### Task 1: Backup UI — the §30 gate

Spec §30 gates the import behind this: `exportBundle`/`restoreBundle` are reachable only from tests, so the owner cannot save anything today.

**Files:** Create `src/ui/screens/Settings.tsx`, `src/ui/screens/Settings.test.tsx`. Modify `src/ui/routes.tsx`, `README.md`.

**Interfaces:** Consumes `exportBundle()`, `inspectBundle(bundle, mode)`, `restoreBundle(bundle, mode)`, `RestoreReport` from `src/db/backup.ts`. Produces nothing other tasks consume.

- [ ] **Step 1: Write the failing tests**

```tsx
it('downloads a bundle whose filename carries the date', async () => { /* assert the download attribute matches /finance-backup-\d{4}-\d{2}-\d{2}\.json/ */ })
it('shows the dry-run report before writing anything', async () => { /* assert per-table counts render and restoreBundle has not been called */ })
it('requires an explicit confirm before restoring', async () => {})
it('passes the same mode to inspect and to restore', async () => { /* §27.2 holds only if they agree */ })
it('renders a refusal reason and detail the owner can act on', async () => { /* newer-schema bundle; assert nothing was written */ })
it('warns that replace overwrites, and offers merge', async () => {})
it('surfaces the unchecked list rather than hiding it', async () => {})
```

- [ ] **Step 2: Run to verify failure.** `npx vitest run src/ui/screens/Settings.test.tsx`
- [ ] **Step 3: Implement.** Export via `Blob` + object URL, revoked after the click. Restore is pick → `inspectBundle` report → confirm. Render `refusedReason`, `detail`, `conflictIds` and `unchecked` verbatim.
- [ ] **Step 4: Run to verify passing.**
- [ ] **Step 5: Update `README.md`** — its backup section says backup is not usable from the app. Make it describe what exists.
- [ ] **Step 6: Commit.** `feat: backup and restore from the Settings screen`

---

### Task 2: The resolved view and the single annotation write path

§32.1: an `annotations` row holds only the latest value, so a correction written without an event is **permanently absent** from the learning record.

**Files:** Create `src/db/annotations.ts`, `src/db/annotations.test.ts`. Modify `src/db/schema.ts`.

**Interfaces:**
- Consumes: `db`, `TransactionRow`, `AnnotationRow`, `LearningEventRow`, `ING_CATEGORY_MAP`.
- Produces:
  `resolve(tx, ann, categoryIndex): ResolvedTransaction`,
  `resolveMany(txs: TransactionRow[]): Promise<ResolvedTransaction[]>`,
  `writeAnnotation(transactionId: string, patch: Partial<AnnotationRow>, source: 'owner' | 'engine'): Promise<void>`,
  `categoryIdForIngPair(ing: string, ingSub: string): Promise<string | null>`,
  `ResolvedTransaction` — every `TransactionRow` field with `valueDate`, `amountCents` and `description` replaced by their override when set, plus the annotation fields, a non-null `categoryId` resolved per §34.3, and `hasOverrides: boolean`.

- [ ] **Step 1: Add the §32 fields, all optional.** `TransferRow.linkKind?: 'internal' | 'roundup' | 'refund'`; `AnnotationRow.roundupParentIdOverride?: string | null`; `CategoryRow.needsReview?: boolean`. **Optional, not required** — required fields would break compilation of `src/db/seed.ts`, `src/db/backup.test.ts`, `src/db/db.test.ts` and `src/db/backup.additive.test.ts`, none of which this task should touch. Treat `undefined` as false/null. Confirm `SCHEMA_VERSION` is still 1 (unindexed fields need no version bump).
- [ ] **Step 2: Write the failing tests**

```ts
it('returns bank values when there is no annotation', () => {})
it('prefers each override and leaves the bank row untouched', async () => { /* assert db.transactions.get() still holds the originals */ })
it('derives the category from the ING pair when the owner has not set one', async () => { /* §34.3: Alimentación/Supermercados -> the seeded leaf */ })
it('prefers the owner category over the derived one', async () => {})
it('returns null category for an ING pair with no node', async () => {})
it('reports hasOverrides only when an override is set', () => {})
it('appends one learning event per CHANGED FIELD, in the same transaction', async () => { /* §34.6: a two-field patch emits two events; payload names field, old, new */ })
it('writes no event for a field whose value is unchanged', async () => {})
it('rolls back the events when the annotation write fails', async () => {})
it('appends no event for an engine-sourced write', async () => {})
it('never touches the transactions table', async () => { /* any transactions.update throws via the immutability hook */ })
```

- [ ] **Step 3: Run to verify failure.**
- [ ] **Step 4: Implement.** The upsert and every event append share one `db.transaction('rw', ...)`. `source: 'engine'` suppresses events — the engine's inferences are not owner corrections and would poison the training signal. Extend `LearningEventType` with the override kinds this plan writes (`category`, `merchant`, `date`, `amount`, `description`, `kind`, `note`); mood, reason and worthwhile arrive in Plan 3.
- [ ] **Step 5: Run to verify passing.**
- [ ] **Step 6: Commit.** `feat: resolved view and the single annotation write path`

---

### Task 3: Format detection and XLSX reading

**Files:** Create `src/import/detect.ts`, `src/import/xlsx.ts`, `src/import/__fixtures__/build.ts`, and tests.

**Interfaces:**
- Produces: `detectFormat(bytes: Uint8Array): 'xlsx' | 'pdf' | 'csv' | 'unknown'`; `readXlsxGrid(bytes: Uint8Array): string[][]` (row-major, cell text as written, blanks `''`); `ImportError` (class, `code: 'not-a-spreadsheet' | 'corrupt-archive' | 'empty' | 'too-large' | 'unreadable' | 'unsupported-format'`, owner-facing `message`); `buildXlsx(headerRows, dataRows): Uint8Array` in the fixtures module.

- [ ] **Step 1: Write the failing tests**

```ts
it('detects xlsx, pdf and csv by magic bytes', () => {})
it('detects XLSX even when the extension says .xls', () => { /* the owner's savings export is a zip named .xls */ })
it('reads the three header rows and the row-4 column titles', () => {})
it('preserves cell text exactly, including accents', () => {})
it('returns empty strings for blank cells rather than undefined', () => {})
```

Review Focus 1:

```ts
it.each([
  ['an empty file', 'empty'],
  ['a truncated zip', 'corrupt-archive'],
  ['a zip with no workbook', 'not-a-spreadsheet'],
  ['a file over 50 MB', 'too-large'],
])('refuses %s with code %s', () => { /* assert an ImportError whose message names the problem */ })
it('settles rather than hanging on a malformed archive', async () => {})
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.** `detectFormat` reads magic bytes only, never the filename. `readXlsxGrid` unzips with `fflate.unzipSync`, parses `xl/worksheets/sheet1.xml` and `xl/sharedStrings.xml` with `DOMParser`, resolving shared-string indices. Enforce a 50 MB ceiling **before** unzipping. Every fflate and DOMParser call is wrapped so a throw becomes an `ImportError`.
- [ ] **Step 4: Run to verify passing.**
- [ ] **Step 5: Commit.** `feat: statement format detection and XLSX reading`

---

### Task 4: Privacy scrub and the account fingerprint

**Files:** Create `src/import/scrub.ts`, `src/import/scrub.test.ts`.

**Interfaces:**
- Produces: `parseHeader(grid): { accountNumber: string; holderName: string; exportedAt: string }`; `fingerprintAccount(accountNumber: string, salt: string): Promise<string>` (64 lowercase hex); `last4Of(accountNumber: string): string`; `nameTokens(holderName: string): string[]`; `scrubDescription(text: string, tokens: string[]): string`; `ScrubReport { descriptionsScrubbed: number; tokensUsed: number }`.

- [ ] **Step 1: Write the failing tests**

```ts
it('reads account number, holder and export timestamp from the header block', () => {})
it('fingerprints to 64 lowercase hex, stable for the same number and salt', async () => {})
it('produces different fingerprints for different salts', async () => {})
it('scrubs the full holder name from a description', () => { /* 'Traspaso emitido a PRUEBA ANÓNIMA TESTER Tu ahorro crece…' */ })
it('scrubs the truncated form ING also writes', () => { /* 'Traspaso recibido de PRUEBA ANÓNIMA Movimiento ING' */ })
it('matches case- and accent-insensitively', () => {})
it('leaves merchant names untouched', () => { /* SUPERMERCADO EJEMPLO LOCALIDAD survives intact */ })
it('does not scrub a short token inside an unrelated word', () => {})
it('is deterministic: the same input scrubs identically every time', () => { /* the dedup key depends on this */ })
it('counts what it scrubbed', () => {})
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.** `fingerprintAccount` uses `crypto.subtle.digest('SHA-256', …)` over the digits plus the salt. `nameTokens` splits on whitespace, dropping tokens under three characters. `scrubDescription` replaces whole-word matches only, comparing accent-folded and upper-cased, writing `[redacted]`. **Neither the account number nor the name may leave this module in a form a caller could persist** — `parseHeader`'s result is consumed immediately and never stored.
- [ ] **Step 4: Run to verify passing.**
- [ ] **Step 5: Commit.** `feat: identity scrub and salted account fingerprint`

---

### Task 5: Normalisation, classification and the balance chain

**Files:** Create `src/import/normalise.ts`, `src/import/normalise.test.ts`.

**Interfaces:**
- Produces: `CandidateRow` (the `TransactionRow` fields except `id`, `importId`, `createdAt`, `deletedAt`; `accountId` **is** present — minted in the preview per §34.4/Task 9); `normaliseGrid(grid, tokens, accountId): Promise<{ rows: CandidateRow[]; scrub: ScrubReport }>`; `classifyKind(ingCategory, ingSubcategory, amountCents): TransactionKind`; `dedupKeyFor(row: CandidateRow): Promise<string>`; `verifyBalanceChain(rows): { ok: boolean; breaks: Array<{ index: number; expected: number; found: number }> }`.

- [ ] **Step 1: Write the failing tests**

```ts
it('maps the seven ING columns in order', () => {})
it('converts the Excel serial date', () => { /* 46341 -> '2026-11-15' */ })
it('parses amounts carrying float noise', () => { /* '-12.449999999999999' -> -1245 */ })
it.each([
  ['Ahorro', 'Redondeo', -10, 'roundup'],
  ['Movimientos excluidos', 'Traspaso entre cuentas', 8000, 'internal'],
  ['Alimentación', 'Supermercados y alimentación', -265, 'spend'],
  ['Otros gastos', 'Transferencias', 150000, 'income'],
])('classifies %s/%s as %s', () => {})
it('keys from bank values only', async () => { /* same row, different overrides -> same key */ })
it('does not include the description in the key', async () => { /* §37: two rows differing only in description share a key, and Task 6 separates them by comparing descriptions */ })
it('gives distinct keys to two same-day same-amount rows', async () => { /* the two COMERCIO EJEMPLO SL -23.20 rows differ by balance */ })
it('verifies a continuous balance chain', () => {})
it('reports the index and amounts of a break', () => {})
```

Review Focus 2 and 4:

```ts
it('refuses a grid whose headers are not the expected seven, naming both', () => {})
it('refuses a grid with fewer than seven columns', () => {})
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.** Header validation compares row 4 against the seven expected titles and throws an `ImportError` naming the mismatch. `classifyKind` applies §8.2 in order: `Ahorro/Redondeo` → `roundup`; `Movimientos excluidos` → `internal`; positive → `income`; else `spend`. `dedupKeyFor` is the Global Constraints formula — `crypto.subtle.digest` over the joined fields, hex-encoded.
- [ ] **Step 4: Run to verify passing.**
- [ ] **Step 5: Commit.** `feat: normalise, classify and verify the balance chain`

---

### Task 6: Duplicate detection

**Files:** Create `src/import/dedup.ts`, `src/import/dedup.test.ts`.

**Interfaces:**
- Produces: `DedupVerdict = { kind: 'new' } | { kind: 'duplicate'; existingId: string } | { kind: 'review'; existingId: string; reason: 'deleted' | 'same-slot-different-description' }`; `classifyRows(rows: CandidateRow[]): Promise<DedupVerdict[]>`.

- [ ] **Step 1: Write the failing tests**

```ts
it('treats an exact key match as a duplicate', async () => {})
it('treats two identical same-day amounts as separate transactions', async () => { /* the two COMERCIO EJEMPLO SL -23.20 differ by balance */ })
it('flags same date, amount and balance with a different description for review', async () => {})
it('treats an unmatched row as new', async () => {})
it('flags a match against a SOFT-DELETED row for review, never as new', async () => { /* §34.1: 'new' would throw on the unique dedupKey and roll back the whole import */ })
it('names the reason on every review verdict', async () => {})
```

Review Focus 5:

```ts
it('still matches a transaction the owner has edited', async () => { /* override date and amount; verdict is still duplicate */ })
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.** Look up by `dedupKey` (indexed, unique) first, **including** soft-deleted rows. A hit on a live row is `duplicate`; a hit on a deleted row is `review` with reason `deleted`. On a miss, query `[accountId+valueDate]` and compare amount, balance and description to choose `new` or `review`. The key never reads an annotation.
- [ ] **Step 4: Run to verify passing.**
- [ ] **Step 5: Commit.** `feat: four-branch duplicate detection`

---

### Task 7: Coverage and bidirectional gap analysis

**Files:** Create `src/import/coverage.ts`, `src/import/coverage.test.ts`.

**Interfaces:**
- Produces: `coveredRanges(accountId): Promise<Array<{ start: string; end: string }>>` (merged, ascending); `analyseGap(accountId, rows): Promise<GapReport>` where `GapReport = { kind: 'first-import' } | { kind: 'contiguous' } | { kind: 'gap'; missingFrom: string; missingTo: string; balanceDelta: number } | { kind: 'overlap' } | { kind: 'detached'; uncoveredFrom: string; uncoveredTo: string }`.

- [ ] **Step 1: Write the failing tests**

```ts
it('reports first-import when the account has no coverage at all', async () => { /* §34.8: 'detached' would show a scary uncovered range on day one */ })
it('merges adjacent and overlapping import windows into one range', async () => {})
it('reports contiguous when a file continues the chain forward', async () => {})
it('reports contiguous when a file extends the chain backward', async () => { /* the seam is checked at the file's LATEST row */ })
it('reports a gap with the missing euro delta', async () => { /* 161.40 -> 94.26 (§5.3) */ })
it('reports detached when a file neither touches nor adjoins existing coverage', async () => {})
it('reports overlap when the window is already fully covered', async () => {})
it('treats each account independently', async () => {})
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.** The seam test is identical in both directions: the balances either side of the join must reconcile with the amount between them. A detached file is accepted and its uncovered range reported.
- [ ] **Step 4: Run to verify passing.**
- [ ] **Step 5: Commit.** `feat: per-account coverage and bidirectional gap analysis`

---

### Task 8: Round-up linking and cross-account transfer pairing

**§33.2 is the governing ruling here.** Round-up parents are genuinely ambiguous by amount and date alone — the owner's own file holds two identical −23,20 € purchases with two identical −1,60 € round-ups on one day. The balance chain resolves them deterministically, and that is evidence, not a guess.

**Files:** Create `src/import/pairing.ts`, `src/import/pairing.test.ts`.

**Interfaces:**
- Produces: `parseRoundupParent(description): number | null` (parent amount in cents); `linkRoundups(rows: CandidateRow[]): RoundupLink[]` where `RoundupLink = { roundupIndex: number; parentIndex: number | null; basis: 'adjacency' | 'unique-amount' | 'ambiguous' | 'none' }` — **`'none'` means no candidate parent is in this file** (ruling P2-R34: the normal case for a savings-side inflow, and for any round-up whose purchase arrived in an earlier import; forcing it into `'ambiguous'` would prompt the owner about rows that are not ambiguous); `pairAcrossAccounts(accountId, committedIds): Promise<TransferRow[]>` — reads and returns, never writes (P2-R29), so Task 9 can call it inside its single commit transaction; `unmatchedTransfers(accountId): Promise<TransactionRow[]>` — the internal movements with no pair, for §9.2's "the other account may not be imported yet" (P2-R35).

- [ ] **Step 1: Write the failing tests**

```ts
it.each([['tu compra de 34 EUR y 78 cts', 3478], ['tu recibo de 7 EUR y 99 cts', 799], ['no amount here', null]])('parses %s', () => {})
it('links a round-up to its parent when the amount is unique that day', () => { /* basis: 'unique-amount' */ })
it('resolves two identical same-day parents by balance-chain adjacency', () => { /* §33.2: 113.79 -> 112.19 and 126.59 -> 124.99; basis: 'adjacency' */ })
it('reports ambiguous only when adjacency also ties', () => { /* synthesise it; the real file does not contain this case */ })
it('leaves parentIndex null for a round-up whose parent is not in this file', () => {})
it('pairs an internal transfer with its opposite leg in another account', async () => { /* same date, same absolute amount, opposite sign */ })
it('pairs a round-up outflow with the savings-account inflow', async () => {})
it('does not pair two legs within the same account', async () => {})
it('scores a same-day match above a windowed one', async () => {})
it('leaves an unmatched internal movement unpaired and reportable', async () => {})
it('sets linkKind to internal or roundup', async () => {})
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.** `parseRoundupParent` matches `/tu (compra|recibo) de (\d+) EUR y (\d+) cts/`. `linkRoundups` filters candidate parents by same date and exact amount; on a single candidate the basis is `unique-amount`; on several, prefer the candidate whose balance satisfies `parentBalance - roundupAmount === roundupBalance` **and** which is adjacent in file order, recording basis `adjacency`; if that still ties, `ambiguous` with `parentIndex: null`. Cross-account pairing uses §9.2's keys, with a ±3-day fallback scoring lower.
- [ ] **Step 4: Run to verify passing.**
- [ ] **Step 5: Commit.** `feat: round-up linking and cross-account transfer pairing`

---

### Task 9: The pipeline, the preview, and the atomic commit

**Files:** Create `src/import/pipeline.ts`, `src/import/commit.ts`, `src/ui/screens/Import.tsx`, and tests. Modify `src/ui/routes.tsx`, `src/pwa.ts`.

**Interfaces:**
- Produces:
  `buildPreview(bytes: Uint8Array, filename: string): Promise<ImportPreview>` — **takes bytes, not a `File`**, because `Blob.prototype.arrayBuffer` is undefined in this jsdom build and the UI should own file reading anyway;
  `ImportPreview { filename; format; fileHash; accountId; accountFingerprint; last4; isNewAccount; coverageStart; coverageEnd; rows: Array<{ row: CandidateRow; verdict: DedupVerdict }>; roundupLinks; balance; gap: GapReport; scrub: ScrubReport; unknownPairs: Array<{ ing: string; ingSub: string }> }`;
  `commitPreview(preview, edits: Map<number, Partial<AnnotationRow>>): Promise<ImportRow>`;
  `suspendReload()` / `resumeReload()` in `src/pwa.ts`.

**Two obligations inherited from Task 7 (controller rulings P2-R26, P2-R27).** Task 7's
`analyseGap` argues that an overlapping window needs no balance-seam check, because the
windows provably agree wherever they share rows. That argument holds only if a row really
is shared, and `analyseGap` cannot check it without redoing deduplication's work. This task
holds both verdict sets, so the check belongs here:

1. **An overlapping file with zero duplicate verdicts is a divergence, not continuity.** When
   the file's date window overlaps coverage this account already has (`gap.kind` is
   `'overlap'` or `'contiguous'` via the touching branch) and not one row comes back from
   dedup as `duplicate`, the preview must surface it for review rather than present the file
   as joining cleanly. Treat it as the file belonging to a different balance chain.
2. **Refuse an import that would commit zero rows.** A coverage range recorded with no
   transactions behind it is what makes Task 7's unverifiable-seam case reachable, and it has
   no legitimate cause: a file whose every row is a duplicate is a re-import, which §34.4
   already refuses by hash, and a file with no rows at all is refused by `analyseGap`.
3. **Pair after the account's own rows are written, inside the same transaction.**
   `pairAcrossAccounts` finds the opposite leg by querying `db.transactions`, so it cannot
   see legs the caller has built but not yet written. Within one commit: write this
   account's transactions, then call pairing, then write the returned `transfers` rows —
   all inside the one `db.transaction('rw', ...)`. One import is one account's file, so
   never pair a second account's pending legs in the same transaction.

- [ ] **Step 1: Write the failing tests**

```ts
it('builds a preview without writing anything', async () => { /* snapshot every table count before and after */ })
it('reads the salt without creating the settings row', async () => { /* §34: getSettings() creates it, which would make the preview a writer */ })
it('recognises a known account by fingerprint and labels it', async () => {})
it('mints an account id for a first-seen fingerprint without writing it', async () => {})
it('refuses a byte-identical re-import, naming the previous import date', async () => { /* §34.4, Review Focus 3 */ })
it('refuses a PDF or CSV with a message pointing at the Excel export', async () => { /* both are later plans */ })
it('commits new rows, skips duplicates, and records the import', async () => {})
it('writes nothing when any row fails', async () => { /* force a unique-key violation; assert full rollback */ })
it('creates an unseen ING pair as a leaf flagged for review, under its parent', async () => { /* §21.2 + §34; create the parent too if unseen */ })
it('stores last4 when storeLast4 is true and omits it when false', async () => { /* §34.5 */ })
it('writes preview edits as ANNOTATIONS, not into the bank row', async () => { /* §34.2: assert transactions holds the file's values and the override is in annotations */ })
it('never persists the file, the full account number or the holder name', async () => { /* dump every table; assert no 'ES00 1111 2222 33 4444555566', no digit-run form of it, no 'TESTER' — last4 alone is permitted (§34.5) */ })
it('suspends the service-worker reload while a preview is open and resumes after commit', async () => {})
it('flags an overlapping file that shares no row with stored history as a divergence', async () => { /* P2-R27: calendar overlap, zero duplicate verdicts -> needs review, never clean continuity */ })
it('refuses a file whose commit would write no rows', async () => { /* P2-R27: no coverage range may exist without transactions behind it */ })
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement `buildPreview`.** Pure: detect → size → read → header → fingerprint → account lookup or mint → hash the bytes → scrub → normalise → verify chain → dedup → link round-ups → gap. It must not write. Refuse early on a `fileHash` already in `imports`.
- [ ] **Step 4: Implement `commitPreview`.** One `db.transaction('rw', ...)` covering the account upsert, auto-created categories, transaction inserts, round-up parent id resolution, the `imports` row, cross-account pairing, and the preview edits written through `writeAnnotation`.
- [ ] **Step 5: Implement `suspendReload`/`resumeReload` in `src/pwa.ts`.** A reload requested while suspended is deferred and fires on resume.
- [ ] **Step 6: Implement `Import.tsx`.** Drag-and-drop and a file picker; the UI reads the `File` into a `Uint8Array`. The preview groups rows as new / duplicate / needs review / error, shows the scrub report, the balance verdict and the gap message, allows per-row correction, and commits on one explicit action.
- [ ] **Step 7: Run the full suite, build and `verify:dist`.**
- [ ] **Step 8: Commit.** `feat: import pipeline, preview and atomic commit`

---

### Task 10: The transactions screen

**Files:** Create `src/ui/screens/Transactions.tsx`, `src/ui/TransactionEditor.tsx`, and tests. Modify `src/ui/routes.tsx`.

**Interfaces:** Consumes `resolveMany`, `writeAnnotation`, `db`. Produces nothing other tasks consume.

**Restore is load-bearing for the import path, not a convenience.** Task 9's deduplication
gives a re-offered row that the owner has soft-deleted the verdict `review: 'deleted'`, and
deliberately does **not** import it — a re-import must never silently resurrect something
the owner removed. That leaves this screen as the only place a deletion can be undone, so
the restore in Step 4's test is the whole recovery path: without it, one mistaken delete is
permanent even though the row is still in the database. Restoring clears `deletedAt` and
nothing else, and the row keeps its original bank values (§8.1).

- [ ] **Step 1: Write the failing tests**

```tsx
it('lists transactions newest first with resolved values', async () => {})
it('shows an edited transaction with its override and marks it edited', async () => {})
it('shows the derived category for a transaction the owner has not touched', async () => { /* §34.3 */ })
it('searches description and merchant', async () => {})
it('filters by account, category, kind and date range', async () => {})
it('sorts by date and by amount', async () => {})
it('soft-deletes and restores without destroying the row', async () => {})
it('writes every edit through writeAnnotation', async () => { /* transactions.update is never called */ })
it('emits one learning event per changed field on a multi-field save', async () => { /* §34.6 */ })
it('formats every amount through formatEur', async () => {})
it('keeps the list usable with 3000 rows', async () => { /* assert the rendered row count is bounded */ })
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement the list.** Virtualise or page it — ~3,000 rows a year makes rendering every row unviable on a phone. Mobile-first; a row is tappable to open the editor.
- [ ] **Step 4: Implement the editor.** Date, description, merchant, amount, category, subcategory, kind, payment method and note, each through `writeAnnotation`. Large touch targets; closes on Escape and returns focus, as the More sheet does.
- [ ] **Step 5: Run the full suite, build and `verify:dist`.**
- [ ] **Step 6: Commit.** `feat: transactions list and editor`

---

## Self-Review

**Spec coverage.** Implements §9 (stages 1–13), §9.1–9.2, §9.10, §8.1–8.2, §14.1 (the parts Plan 1 deferred), §21.2, §30, §32–§34, and §4's editable-transaction requirements. Deliberately deferred: mood and purchase-reason capture and income/budgeting (Plan 3); the learning engine and statistics (Plan 4); the PDF parser, encrypted backup, DeepSeek, Web Share Target and File System Access deletion (Plan 5 and its device pass).

**Changes from the first draft, all from the builder check.** The 68-character truncation is removed and `dedupKey` is now a hash over the full scrubbed description (§33.1 — the premise was false and would have collapsed all 18 round-ups to one prefix). Round-up linking gains balance-chain adjacency, because the real file contains the ambiguous case and the original 18/18 test was unsatisfiable (§33.2). A soft-deleted match became `review` rather than `new`, which would have thrown on the unique key and rolled back the import. Preview edits became annotations. Category is derived at read time rather than written per row. `fileHash` and `accountId` were missing from the preview and both are needed to commit. The privacy test no longer forbids `last4`, which the spec requires. Fixtures are synthesised rather than committed. `buildPreview` takes bytes because `Blob.arrayBuffer` is undefined in this jsdom. One vacuous test (`never returns a verdict that deletes or merges` — unrepresentable in the union) was removed.

**Type consistency.** `CandidateRow` (Task 5) → 6, 7, 8, 9. `DedupVerdict` (6) → 9. `ScrubReport` (4) → 5, 9. `GapReport` (7) → 9. `ResolvedTransaction` (2) → 10. `ImportError` (3) thrown by 3, 5, 9. `accountId` is on `CandidateRow` from Task 5 onward, minted in Task 9's preview.

**Proportion.** Shorter than the spec sections it implements; no function bodies, only test names carrying the spec's real values.
