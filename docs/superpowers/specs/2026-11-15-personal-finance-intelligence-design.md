# Personal Finance Intelligence — Design

**Date:** 2026-11-15
**Status:** awaiting approval
**Owner:** Dawid

---

## 1. Intent and why

A private, offline-first personal finance application that imports ING Spain
statements, keeps every financial record on the owner's own device, and —
this is the part that distinguishes it from an expense tracker — learns from
the owner's recorded behaviour (mood, purchase reason, hindsight judgement,
corrections) in order to help them make better spending decisions over months
and years.

The owner wants to understand *why* they spend the way they do, not merely
what they spent. The application therefore has two halves of equal weight:

1. **A trustworthy ledger.** Imports must be exact, duplicate-free, and never
   silently overwrite a human correction. If the numbers cannot be trusted,
   nothing built on them is worth reading.
2. **An honest intelligence layer.** Patterns, recommendations and scores must
   state their evidence, their sample size and their limits. A fabricated
   insight is worse than no insight, because it teaches the wrong lesson.

Operationally the owner wants near-zero infrastructure: push to GitHub, let
GitHub Pages serve it, open the site, use it. No server, no database, no
deployment ritual.

---

## 2. Goals

- **G1.** Import ING Spain account statements (XLSX primary, ~~PDF fallback,
  CSV lower priority~~) entirely in the browser, with a preview and correction
  step before anything is saved.

  > **Withdrawn by the owner on 2026-11-18: the PDF fallback and CSV import are
  > not wanted and will not be built.** XLSX is the only import format. This
  > strikes item 14 of the build order, the `pdf.js` dependency in §16, and the
  > PDF branch of the format detection in §9; the importer's existing refusal of
  > PDF and CSV with an explanation is now the final behaviour rather than a
  > placeholder. Recorded here rather than left as a silent gap, because a goal
  > that no plan will ever implement otherwise reads as work outstanding, and
  > three of this project's worst defects came from a document that no longer
  > described the program.
- **G2.** Never create a duplicate transaction when statements overlap, and
  never silently merge or delete when a match is uncertain — ask instead.
- **G3.** Hold the full financial history locally, with schema versioning,
  migrations, complete export, restore, and encrypted backup.
- **G4.** Make every imported transaction fully editable, with manual
  corrections structurally immune to being overwritten by later imports.
- **G5.** Record mood, purchase reason, hindsight judgement and notes per
  transaction, fast enough to be sustainable on a phone.
- **G6.** Budget by percentage of *actual* net income received in each month,
  handling variable salary, zero-income months and multiple income sources.
- **G7.** Learn locally — merchant and category preferences, accepted and
  rejected recommendations, behavioural patterns — with no AI service required.
- **G8.** Produce behavioural findings using declared statistical methods, with
  sample sizes, effect sizes, confidence and stated limitations.
- **G9.** Give recommendations that each state: what was noticed, the evidence,
  why it matters, what to do, the likely financial impact, and the confidence.
- **G10.** Provide a transparent, income-neutral Money Score.
- **G11.** Track savings goals funded by percentage of actual income, and detect
  recurring payments and subscriptions, all user-correctable.
- **G12.** Offer optional DeepSeek coaching that is strictly opt-in, summary-only
  by default, and shows exactly what will be sent before sending it.
- **G13.** Strip the account number and account holder name at import time and
  never persist them.
- **G14.** Deploy as a static site to GitHub Pages via GitHub Actions, working
  on Android Chrome (Galaxy S26) and desktop, installable as a PWA.

## 3. Non-goals

- Multi-currency. EUR only.
- Bank API connections, screen scraping or account aggregation. Manual export
  and upload only.
- OCR. See §5.2 — ING's export always carries a text layer, so OCR would add a
  large dependency for a case that does not occur.
- Credit cards. Confirmed out of scope by the owner; no purchase-versus-
  settlement reconciliation is needed.
- Multi-user, sharing, cloud sync, or any server-side component.
- Investment, pension or tax reporting.
- Budget forecasting beyond simple projection of observed recurring items.

## 4. Anti-goals

Things that would make this a failure even if it technically worked:

- **A1.** A judging or shaming tone, or any assumption about the owner's
  financial circumstances or what they *should* be able to afford.
- **A2.** Patterns asserted from insufficient data, or correlation presented as
  causation.
- **A3.** A manual correction lost or overwritten by a later import.
- **A4.** A duplicate silently merged or a transaction silently deleted.
- **A5.** Any network request the owner did not explicitly trigger.
- **A6.** The IBAN, account number or account holder name persisted anywhere.
- **A7.** Statistics shown for their own sake — volume of numbers over insight.
- **A8.** Claiming a capability that was not implemented and tested.

---

## 5. Evidence base — what the real files actually contain

Both supplied files were parsed directly before this design was written. These
findings are load-bearing; the design depends on them.

**Every amount, balance, merchant name and description quoted in this section
and anywhere else in this document is synthetic.** The findings — the column
layout, the counts, the ratios, the pairing results, the arithmetic properties —
are the real ones, measured against the owner's own exports. The figures
illustrating them are not, and must never be replaced with real ones to make an
example "accurate". Balances, named transactions and merchant strings are
financial records, and §14 keeps those out of this repository. An earlier
revision of this document did quote real ones; that was a defect, not a
precedent (§44).

### 5.1 `movements-15112026.xlsx`

Seven columns: `F. VALOR`, `CATEGORÍA`, `SUBCATEGORÍA`, `DESCRIPCIÓN`,
`COMENTARIO`, `IMPORTE (€)`, `SALDO (€)`. Header block above the table holds
`Número de cuenta`, `Titular`, `Fecha exportación`.

- 50 transactions covering 2026-11-10 to 2026-11-15, newest row first.
- Dates arrive as Excel serial numbers (46341 = 2026-11-15).
- Amounts carry IEEE-754 noise (`-12.449999999999999` for −12,45 €).
- **The balance column is arithmetically continuous.** Across all 49 adjacent
  row pairs, `saldo[i] == saldo[i+1] + importe[i]` to the cent, with zero
  breaks. This is the backbone of both duplicate detection and gap detection.
- **ING supplies its own category and subcategory** — 12 distinct pairs in six
  days.
- **Half the rows are not spending.** 18 of 50 are `Ahorro / Redondeo`
  (round-up savings transfers) and 7 are `Movimientos excluidos / Traspaso
  entre cuentas` (transfers between the owner's own accounts). Only 25 are
  real spending or external income.
- **Round-up descriptions embed their parent purchase amount**: `"Tu ahorro
  crece otra vez con tu compra de 34 EUR y 78 cts"` pairs with a −34,78 €
  purchase. Also appears as `"...con tu recibo de 7 EUR y 99 cts"`.
- **The account holder's full name appears inside transaction descriptions**,
  not only in the header: `"Traspaso emitido a PRUEBA ANÓNIMA TESTER ..."`,
  `"Traspaso recibido de PRUEBA ANÓNIMA ..."`. Scrubbing the header alone is
  insufficient. The name written here and used in every fixture and test,
  `PRUEBA ANÓNIMA TESTER`, is an **invented stand-in**, not a quotation: what
  was observed is the shape (the full name, and a form truncated after the
  second word), never the owner's own name, which this repository must not
  contain.
- **Descriptions are NOT truncated at 68 characters. This document previously
  claimed they were, and that claim was false** — see §33.1. They run to 97
  characters in the current account; 19 of 50 exceed 68 and none is exactly 68.
  The row that prompted the claim is 69 characters and merely *looks* clipped,
  because ING repeats the merchant name inside the same description — so a
  reader sees the name begin a second time and assumes the field was cut.
  Nothing may truncate a description before comparing it. (The row itself is not
  quoted here: it is a real receipt line from the owner's statement, and §14.0
  keeps those out of this repository. The measurements above are the finding; the
  string was only ever an illustration of it.)
- **Every round-up is exactly `(ceil_to_euro(parent) − parent) × 2`** in all 18
  observed cases. This is a second, independent way to corroborate a parent
  link. The multiplier is an ING setting the owner could change, so the
  embedded description text stays the primary link and the arithmetic only
  corroborates.
- **The sample contains no external income at all.** All seven inflows
  (1 100 € over six days) are `Movimientos excluidos / Traspaso entre cuentas`
  top-ups from the owner's own other account, which §10 defines as not income.
  Which account receives salary is therefore an open question (§22).
- Volume: ~8 transactions/day ≈ 3 000/year ≈ 9 000 over three years.

### 5.2 `movements-15112026_261115_131854.pdf`

Same seven columns and the same data, produced by PDFium.

- 3 pages, `/Rotate 90`, two embedded subset fonts with **complete and correct
  `ToUnicode` CMaps** — text extraction is viable, no OCR required.
- Text is emitted as positioned fragments. A single transaction's description
  wraps across two or three separate text rows at different Y offsets
  (e.g. 477.2 / 472.6 / 468.0), so reconstructing one logical row requires
  clustering by vertical position with tolerance, then stitching fragments.
- Column headers repeat on every page.
- Amounts and dates are rendered strings that must be re-parsed.

### 5.3 The savings account export — `movements-15112026.xls`

Supplied after the first review, and decisive for §9.2. Verified directly.

- **The file is a ZIP (`PK\x03\x04`) despite its `.xls` extension** — an XLSX
  misnamed by ING's export. Format detection must therefore be by magic bytes,
  never by extension.
- **Identical seven-column layout and identical three-row header block.** One
  parser serves both accounts; no second parser is needed.
- Different account number (`…8899` against the current account's `…5566`), so
  fingerprinting distinguishes them automatically.
- 50 rows covering serials 46329–46341 (2026-11-03 to 2026-11-15) — a
  **13-day window against the current account's 6-day window**. Per-account
  coverage tracking (§9.1) is therefore not a nicety; the two exports already
  disagree about which days they cover.
- Balance chain continuous: **0 breaks across 49 pairs**, as in the current
  account.
- **Cross-account pairing confirmed exactly:**
  - all **7** `Movimientos excluidos` rows in the current account pair with a
    savings row on (same date, same absolute amount, opposite sign) — 7/7;
  - all **18** `Ahorro / Redondeo` outflows pair with a savings inflow on
    (same date, same absolute amount, same embedded parent-purchase phrase) —
    18/18;
  - all **31** savings-side round-ups satisfy
    `(ceil_to_euro(parent) − parent) × 2` — 31/31;
  - all **18** round-up parents resolve to a same-day purchase in the current
    account — 18/18.
- **ING labels the round-up `Ahorro / Redondeo` on both sides**, so the savings
  inflow classifies as `roundup`, not `income` — §8.2 needs no change. But
  summing `roundup` rows across both accounts would double the owner's savings,
  which is exactly what §9.2's pairing prevents.
- **The savings balance fell across the window**, by far more than the round-ups
  added to it over the same 13 days. Savings-rate reporting must therefore be computed from the net
  change across all accounts, not from round-up volume, or the app would report
  a saving where the balance fell. This is stated as an arithmetic requirement,
  not a judgement about the owner's choices (A1).

**Conclusion: XLSX is the primary format.** It is one row per transaction with
exact numeric values and no positional inference. The PDF parser is built as a
fallback for occasions when only a PDF is available, and the import screen
steers the owner toward the Excel export. A PDF lacking a text layer is
rejected with a clear instruction to export Excel instead — this replaces OCR.

---

## 6. Constraints

- **C1.** Static hosting only. No server, no serverless function, no remote
  database, no mandatory third-party service, no Docker, no paid hosting.
- **C2.** Must work under a GitHub Pages project path (`/<repo>/`) and survive
  refreshes and deep links.
- **C3.** All financial data stays in browser storage on the owner's device.
  Browser storage is not encrypted at rest and can be cleared by the browser,
  by the owner, or lost with the device. This must be stated plainly in the
  application, not buried.
- **C4.** No financial records in the Git repository, ever.
- **C5.** No API key in source code.
- **C6.** Primary device is a Samsung Galaxy S26 on Android Chrome; desktop is
  secondary but fully supported.
- **C7.** Monetary arithmetic must be exact — integer cents throughout, no
  floating point in any stored or displayed figure.
- **C8.** The owner does not want to choose between libraries or frameworks, or
  to configure tooling.

---

## 7. Approaches considered

### 7.1 Where derived numbers come from

| Approach | Trade-off |
|---|---|
| **Compute everything on read.** Every screen recalculates from the transaction table. | Single source of truth, never stale, improving a formula instantly improves all history. But correlation passes over ~9 000 transactions on every screen open are slow on a phone, and the owner explicitly asked for stored summaries and learning history. |
| **Persist everything.** Summaries, patterns and recommendations written on import. | Instant screens. But figures produced by an older formula coexist with newer ones, so the owner's own history contradicts itself; every change to the maths needs a data migration. |
| **Hybrid — chosen.** | See below. |

**Chosen: hybrid.** Three classes of data are durable truth and are never
recomputed or overwritten by any engine:

1. imported transactions (immutable once committed),
2. owner annotations (category, mood, reason, worthwhile, notes, overrides),
3. learning state (corrections, accepted/rejected recommendations, outcomes).

Everything else — monthly summaries, scores, pattern findings, recommendation
candidates — is a **cache** stamped with an `engineVersion` and an
`inputsHash`, rebuilt automatically when transactions change or when the
engine version increases. This yields instant screens, an always-safe "rebuild
analytics" action, and a structural guarantee that no formula change can touch
an owner correction.

### 7.2 How the learning engine decides

| Approach | Trade-off |
|---|---|
| **Pure rules and counters.** | Fully explainable, instant, trivial to store. Helpless with an unseen merchant. |
| **In-browser ML classifier.** | Better on unseen merchants, but cannot explain itself — which directly violates G9 (every recommendation states its evidence). |
| **Layered — chosen.** | See below. |

**Chosen: layered, consulted in strict order.**

1. **Owner override** for this merchant — always wins, never overwritten.
2. **Frequency memory** from the owner's own corrected history.
3. **ING's own category** from the imported file.
4. **Bayesian text classifier** over tokenised descriptions — used only when
   tiers 1–3 are silent, and only ever as a low-confidence *suggestion* the
   owner confirms.

Every categorisation records which tier produced it, so "here is the evidence"
is a fact about the data rather than a decorative sentence.

Behavioural analysis (§12) is deliberately a separate engine from
categorisation. It uses fixed statistical tests with declared minimum sample
sizes and never feeds the categoriser.

### 7.3 Technology (owner delegated these; stated, not asked)

- **React + TypeScript + Vite** — static output, mature, long-lived.
- **Dexie.js over IndexedDB** — explicit schema versioning and migrations,
  which G3 requires; raw IndexedDB makes migrations error-prone.
- **SheetJS (`xlsx`)** for XLSX parsing; **pdf.js** for the PDF fallback.
- **ECharts** for charts — good mobile touch behaviour, reasonable bundle.
- **`dinero.js`-style integer-cent value object** (own small module, no runtime
  dependency) for money; parsing reads raw cell text and converts via integer
  arithmetic, never via `parseFloat` on a rounded value.
- **`vite-plugin-pwa`** for the offline service worker and manifest.
- **Vitest** for unit tests, **Playwright** for one production-build smoke test.
- **Hash routing** (`#/transactions`) and **`base: './'`** in Vite — together
  these make the build work under any GitHub Pages path, on a custom domain, or
  opened from disk, with no configuration for the owner to edit, and refreshes
  and deep links always resolve without a `404.html` workaround.

---

## 8. Data model

Dexie database `finance`, schema version 1. `engineVersion` is a separate
constant in code, independent of schema version.

```
accounts          id, fingerprint*, label, last4, currency, createdAt, archived
transactions      id, accountId, valueDate, amountCents, balanceCents,
                  description, comment, ingCategory, ingSubcategory,
                  kind, dedupKey*, importId, fileSeq, roundupParentId,
                  createdAt, deletedAt
annotations       transactionId*, categoryId, subcategoryId, merchantId,
                  typeOverride, paymentMethod, note, moodId, purchaseReasonId,
                  worthwhile, reviewed, dateOverride, amountCentsOverride,
                  descriptionOverride, updatedAt
categories        id, name, parentId, kind, isUserCreated, ingMappings
merchants         id, canonicalName, kind, matchPatterns, defaultCategoryId,
                  isSubscription, createdAt
moods             id, label, emoji, valence, isCustom, order
purchaseReasons   id, label, isCustom, order
budgetAllocations id, categoryId, savingsGoalId, percentBp, fixedCents,
                  effectiveFrom, note
imports           id, filename, format, fileHash*, accountId, importedAt,
                  coverageStart, coverageEnd, rowsDetected, rowsNew,
                  rowsDuplicate, rowsErrored, rowsNeedsReview,
                  balanceChainOk, scrubReport, notes
transfers         id, outTransactionId, inTransactionId, amountCents,
                  matchScore, confirmedByUser, matchedAt
savingsGoals      id, name, targetCents, deadline, contributionPercentBp,
                  createdAt, completedAt, archived
recurring         id, merchantId, amountCents, toleranceCents, frequency,
                  lastSeenDate, expectedNextDate, matchScore,
                  confirmedByUser, cancelled
learningEvents    id, at, type, payload, outcome        (append-only)
recommendationState key*, status, shownCount, rejectedCount, lastShownAt,
                  suppressedUntil, evidenceFingerprint
analyticsCache    key*, engineVersion, inputsHash, computedAt, payload
settings          id (singleton), theme, locale, privacy, mood prompting,
                  deepseek, backup
```

### 8.1 The key structural decision

`transactions` is **immutable after import**. Every owner edit — including
edits to date, amount and description — is written to `annotations` as an
override, leaving the bank's original value intact and visible. The resolved
view used by the whole application is `transaction ⊕ annotation`.

This makes G4 and A3 structural rather than a promise: an import writes only to
`transactions`, so it is incapable of touching an owner correction. It also
gives a free audit trail ("bank said −12,45 €, you corrected the merchant") and
makes the learning engine's training signal unambiguous.

### 8.2 Transaction `kind`

Assigned at import, overridable by the owner:

- `internal` — `ingCategory == "Movimientos excluidos"`. Movement between the
  owner's own accounts. Excluded from both income and spending.
- `roundup` — `ingCategory == "Ahorro"` and `ingSubcategory == "Redondeo"`.
  Counted as **savings**, never as spending.
- `income` — positive amount, not `internal`, not `roundup`.
- `spend` — everything else.

---

## 9. Import pipeline

Stages, in order. Nothing is written to the database before stage 12.

1. **Accept file** — drag-and-drop, file picker, or (to be verified during
   build) the PWA Web Share Target so a freshly downloaded file can be shared
   straight into the installed app on Android. Fallback is the file picker.
2. **Detect format** by magic bytes: `PK` → XLSX, `%PDF` → PDF, else CSV.
3. **Parse header block** → account number, titular, export timestamp.
4. **Privacy scrub, immediately and irreversibly** (§14.1). The account number
   is hashed to a fingerprint and discarded; the holder name is tokenised for
   description scrubbing and discarded. Neither is ever written to the database.
5. **Scrub descriptions** of the holder's name tokens and variants, recording
   only counts in `imports.scrubReport`.
6. **Normalise rows** — Excel serial → ISO date; amount and balance → integer
   cents via string-safe integer parsing; preserve original file order as
   `fileSeq` for intra-day ordering.
7. **Classify `kind`** per §8.2.
8. **Link round-ups** — parse `"tu (compra|recibo) de N EUR y M cts"` from the
   description, match to a transaction in the same account on the same or
   previous day whose amount equals that value, store `roundupParentId`. This
   enables "your round-ups saved you X €, triggered by Y purchases".
9. **Verify the balance chain** — assert `saldo[i] == saldo[i+1] + importe[i]`
   across the file. Breaks are reported to the owner rather than hidden; a
   broken chain downgrades confidence in the gap analysis but does not block
   the import.
> **Superseded by §37.** The description is no longer part of the duplicate key. The reasoning here is kept because it records why, but do not implement it.

10. **Duplicate detection.** Key = `accountId + valueDate + amountCents +
    balanceCents + normalisedDescription`, computed **exclusively from the
    bank's original immutable values** on the `transactions` row. Owner
    overrides in `annotations` — including `dateOverride` and
    `amountCentsOverride` — must never participate in the key. Otherwise
    correcting a date would change the key, a later overlapping statement
    would stop matching, and the override mechanism that exists to satisfy
    G4/A3 would create the duplicate that G2/A4 forbids. `normalisedDescription`
    also truncates to 68 characters before hashing, because ING itself
    hard-truncates long descriptions at that length (§5.1).
    - exact key match on a non-deleted transaction → **duplicate**, skipped;
    - same date, amount and description but different balance → **not** a
      duplicate (a genuine repeat payment — two identical 23,20 € charges on
      one day necessarily have different running balances);
    - same date, amount and balance but different description → **flag for
      review**;
    - anything else ambiguous → **ask the owner**. Never merge or delete
      silently (A4).
11. **Coverage and gap analysis.** Record the file's `coverageStart` and
    `coverageEnd`. Compare the earliest new row's implied preceding balance
    against the latest stored balance for that account. A mismatch means
    transactions are missing between the two imports, reported concretely:
    *"last import ended at 248,15 € on 10 Nov, this file starts from 181,01 € —
    re-export from 10 Nov."* This is how irregular upload rhythms are handled
    (§9.1).
12. **Preview and commit.** The preview groups rows as new / duplicate / needs
    review / error, shows the scrub report and the balance verification result,
    and allows per-row correction before saving. Commit is a single atomic
    Dexie transaction — an interrupted import cannot half-write.
13. **Post-commit** — offer deletion of the original file (§14.2), invalidate
    the analytics cache, update import history.

### 9.1 Irregular upload rhythms

The owner uploads daily, weekly, or at random. Rather than inferring a cadence
and depending on it, the application tracks **coverage**: the exact date range
each import covered per account, plus the balance chain. From that it can
state, at any moment and without guessing, which days are covered, where a gap
exists, and what export range would close it. A cadence estimate (median days
between imports) is shown as a convenience for the backup reminder and the
"you usually import around now" nudge, never as a correctness assumption.

### 9.2 Transfer pairing (multi-account)

All of the owner's ING accounts are in scope. An `internal` outflow in one
account has a matching inflow in another. Once both accounts are imported, the
pairing engine matches equal-and-opposite amounts across different accounts
and records a `transfers` row. The match keys are the ones verified in §5.3:

- **internal transfers** — same `valueDate`, same absolute amount, opposite
  sign, different account. Verified 7/7 on real data. A ±3-day window is
  retained as a fallback for the case where ING assigns different value dates
  to the two legs; a same-day match scores higher than a windowed one.
- **round-ups** — same `valueDate`, same absolute amount, and the same parent
  phrase parsed from the description (`tu (compra|recibo) de N EUR y M cts`),
  different account. Verified 18/18. The
  `(ceil_to_euro(parent) − parent) × 2` identity (verified 31/31) corroborates
  a match but is never the primary key, because the multiplier is an ING
  setting the owner can change.
- **round-up parent** — the parent purchase lives in the *spending* account.
  The spending account's round-up outflow links directly to it (18/18
  verified); the savings account's round-up inflow reaches it through its
  pair, never by searching its own account.
- Where two same-amount purchases share a day, the parent is ambiguous: flag
  it for the owner rather than guessing. Paired transfers net to
zero in all income, spending and savings figures. Unmatched `internal`
movements are still excluded from income and spending, but are surfaced as
"unmatched transfer — the other account may not be imported yet", which doubles
as a prompt to import the missing account. Round-up outflows pair with the
savings account's inflows the same way, preventing savings being counted twice.

---

## 10. Income and percentage budgeting

**Income is money crossing into the owner's accounts from an outside payer.**
Any movement between the owner's own accounts is zero, regardless of size. A
600 € top-up from the owner's main account is not income; salary, refunds and
reimbursements are.

- `netIncome(month) = Σ amountCents where kind == 'income' and not part of a
  matched transfer pair`.
- A budget allocation is a percentage in basis points of that month's net
  income. 15 % of 2 000 € is 300 €; of 2 400 € it is 360 €. Fixed-EUR
  allocations are also supported for annual bills.
- **Zero-income month:** allocations fall back to the trailing three-month
  average of external income, labelled *provisional* everywhere it appears,
  and recomputed the moment real income lands. **Partial month:** the same
  provisional basis is used until the month ends, with month-to-date actuals
  shown alongside.
- **Refunds and reimbursements:** a positive amount matched to an earlier
  spend at the same merchant within 90 days is offered as a refund link, which
  reduces that category's spending rather than counting as income. Owner
  confirms; unconfirmed positives default to `income` and are flagged.
- **Annual and irregular bills:** optionally amortised across twelve months in
  budget views, with the actual cash movement shown on its real date.

Reported each month: actual income, total spending, essential spending,
discretionary spending, savings (including round-ups), per-category euros and
percentages, remaining allocation, savings rate, and budget variance — every
figure in both EUR and percent.

---

## 11. Learning engine

Append-only `learningEvents` is the training record. Nothing in it is ever
rewritten; the engine reads it forward.

- **Merchant and category memory.** Each owner correction increments a
  frequency counter for (merchant pattern → category). Tier 1 of §7.2 is an
  exact owner override; tier 2 is this frequency memory. A merchant corrected
  twice the same way becomes the default for that merchant.
- **Merchant canonicalisation.** Raw descriptions (`Pago en SUPERMERCADO EJEMPLO
  LOCALIDAD ES`) are reduced to a canonical merchant (`Supermercado Ejemplo`) by a token
  pipeline: strip transaction prefixes (`Pago en`, `Pago Bizum en`, `Recibo`),
  strip trailing locality and country codes, normalise accents and case.
  Owner edits to a merchant name create a pattern that wins thereafter.
- **Recommendation feedback.** Accepting, rejecting or snoozing a
  recommendation is an event. A recommendation rejected twice is suppressed
  until its `evidenceFingerprint` materially changes — meaning it will not
  reappear unless genuinely new evidence exists.
- **Outcome tracking.** When a recommendation is accepted, the relevant metric
  is snapshotted and re-measured after one full month, and the outcome recorded
  as improved / unchanged / worsened. Outcomes feed the Money Score's learning
  component and the confidence of similar future recommendations.
- **Regret learning.** Transactions marked `worthwhile = No` are aggregated by
  purchase reason, merchant, category, mood and weekday. Repeated regret in a
  cluster raises that cluster's weight in recommendations.

---

## 12. Behavioural and correlation analysis

A fixed, pre-declared battery of tests — never an open search for whatever
looks significant.

| Relationship | Test | Minimum data |
|---|---|---|
| Mood → spend amount | Spearman ρ on mood valence vs amount | ≥30 annotated discretionary spends, ≥2 mood groups with ≥10 each |
| Mood → purchase frequency | Mann–Whitney U on per-week purchase counts | ≥8 weeks of mood coverage |
| Stress → discretionary share | Mann–Whitney U | ≥10 stressed and ≥10 non-stressed spends |
| Boredom → impulse share | Chi-square | ≥20 impulse-tagged spends |
| Reason → worthwhile | Chi-square + Cramér's V | ≥30 spends with both fields |
| Weekend effect | Mann–Whitney U | ≥8 weekends observed |
| Days-after-payday effect | Spearman ρ on days-since-income vs daily spend | ≥3 income events |
| Small-purchase accumulation | Descriptive aggregation, no test | ≥1 full month |
| Salary change → lifestyle change | Mann–Whitney U on discretionary share across income tiers | ≥2 distinct income levels, ≥2 months each |
| Category → savings performance | Spearman ρ | ≥4 months |

Non-parametric tests are chosen deliberately: transaction amounts are heavily
right-skewed, so means and Pearson correlation would mislead.

Two rows above were corrected during Plan 6, because **this table named two
tests the implementation does not run, and the declarations copied from it
inherited the error.**

- *Mood → purchase frequency* said **Poisson rate comparison**. No Poisson
  primitive exists and an exact Poisson test would need a fourth table of
  hand-entered critical values. Mann–Whitney on per-week counts is also better
  on the merits: it assumes no distribution, and the Poisson shape is plainly
  violated because purchases cluster — one shopping trip is several
  transactions.
- *Salary change → lifestyle change* said **paired comparison**. The code
  compares two **disjoint** groups of months, which is the
  independent-samples test; nothing about it is paired. This one was the more
  dangerous of the two precisely because it reads plausible, so no one thought
  to check it. It survived a whole-branch review and was caught only by an
  implementer re-reading its own declaration against its own code.

The lesson is for this document rather than for the code: a test named here is
a **claim about what the program does**, and it is the only such claim in this
spec that no test could contradict, because §12 also requires that the test's
name never reach the screen. A field nothing displays and nothing checks will
drift. `battery.test.ts` now ties each declared test to the statistic the
module actually calls.

Every finding reports: the pattern, number of transactions analysed, the period
covered, the effect size (ρ, rank-biserial r or Cramér's V), a confidence band,
a plain-language limitation, a possible meaning, and a suggested action.
Benjamini–Hochberg correction is applied across the battery each cycle and the
corrected threshold is shown. Below the minimum data threshold the application
states what is missing and how much more is needed — it does not speculate
(A2). Causal language is prohibited in the finding templates.

---

## 13. Features built on the above

### 13.1 Dashboard and reports
Spending overview; income versus expenses; category breakdown; trends;
month-on-month comparison; mood analysis; purchase-reason analysis; worthwhile
versus regretted; small-purchase accumulation; unusual spending (robust
z-score against the owner's own per-category history); recurring expenses and
subscription cost; post-payday spending; savings performance; essential versus
discretionary. Charts are chosen for legibility on a phone; a screen shows at
most one chart plus its reading.

### 13.2 Recommendations and education
Each recommendation renders six fields: what was noticed, the evidence (with
the transactions behind it, inspectable), why it matters, what to do
differently, estimated financial impact, and confidence. Educational notes on
opportunity cost, impulse spending, lifestyle inflation, small-purchase
accumulation, savings consistency and the value of money are attached to the
recommendation that triggered them, so teaching is contextual rather than a
lecture. Optional challenges: reduce a category by N points, no-spend days, the
24-hour rule, a subscription review, a savings step-up. Tone rules are
enforced in the copy templates (A1): no shaming, no assumptions about means.

### 13.3 Money Score
Six components, each scored 0–100 against the **owner's own history**, never
against an absolute income or wealth level:

1. Budget awareness — share of allocations respected, weighted by allocation
   size.
2. Savings consistency — proportion of observed months with positive net
   savings.
3. Improvement — trend in discretionary share against the owner's own trailing
   baseline.
4. Spending awareness — share of transactions reviewed and annotated.
5. Goal progress — weighted progress against each goal's own plan.
6. Learning — reduction in repeated regret within previously flagged clusters.

The score shows every component, its weight, its inputs and the arithmetic, on
the screen. Components without enough data are shown as "not yet measured" and
excluded from the weighting rather than scored as zero.

### 13.4 Savings goals and recurring payments
Goals funded by a percentage of actual monthly income, showing contributed
amount, remaining amount, and a completion estimate derived from the owner's
observed contribution history with an explicit range. Recurring detection
clusters by canonical merchant and near-equal amount, infers frequency from
inter-arrival gaps, and reports merchant, amount, frequency, last payment and
expected next payment with a confidence level. Every classification is
correctable, and corrections are learned.

### 13.5 Optional DeepSeek coach
Off by default and fully optional; the application is complete without it.

- The key is entered by the owner, stored only in local settings, never in
  source (C5). The screen states plainly that a key held in browser storage is
  readable by anything with access to the device or the browser profile, and
  recommends a dedicated key with a spending cap.
- **Context sent is aggregate-only by default**: monthly totals, category
  percentages, pattern findings, score components. Raw transaction
  descriptions and full history are never sent unless the owner explicitly
  enables it for a single question.
- Before every send, the exact JSON payload is displayed for approval.
- **CORS honesty.** DeepSeek's API is OpenAI-compatible, but whether it permits
  direct browser-origin calls cannot be assumed. If the request is blocked,
  the application explains the limitation precisely and offers the no-backend
  alternative: copy the prepared context to the clipboard and paste it into
  DeepSeek's own web chat. **No backend proxy will be introduced**, openly or
  otherwise.

---

## 14. Privacy and security

### 14.0 The repository itself holds no financial records
The owner's rule — "never store my financial records in the GitHub repository"
— binds this document and every other committed file, not only the database.
A balance, a dated transaction with its amount, a real merchant string, or a
named counterparty is a financial record wherever it is written, including in
prose that quotes it as evidence. A merchant string can also carry a locality,
which identifies where the owner shops and lives.

So: no real amounts, balances, merchant names, counterparties or description
text from the owner's statements in any committed file. Illustrate with
synthetic figures, and keep the real finding — the count, the ratio, the
arithmetic property — which is what the design actually rests on. The guard
against this is a reading of the whole repository against the owner's own data,
not a denylist of strings, because a denylist only catches what someone already
thought of (§44).

### 14.1 Identity stripping
- The account number is reduced to a SHA-256 fingerprint over its digits plus a
  random salt generated once per installation and stored in local settings. The
  raw number is never written to the database. The fingerprint lets the app
  recognise which account a later export belongs to without holding the IBAN.
- `last4` is retained **only** to label accounts legibly, and a privacy setting
  replaces it with an owner-chosen label and clears it.
- The account holder name is tokenised at import, used to scrub descriptions,
  and discarded. Scrubbing covers the header **and** description text (§5.1).
- The import preview shows exactly what was removed before anything is saved.

### 14.2 Removing the original file — stated limits
The application never stores the uploaded file; it is read into memory, parsed,
and discarded. Deleting the original from the device is a different matter:

- **Desktop Chrome / Edge:** if the file was opened via the File System Access
  API picker, the app can delete the original after a verified successful
  import, with explicit confirmation.
- **Android Chrome:** that API is unavailable. The app confirms that nothing was
  retained and reminds the owner to delete the file from Downloads. It cannot
  do it for them, and will not pretend otherwise.

### 14.3 Storage honesty and backup
A permanent, non-dismissible note in Settings states that browser storage is
not encrypted at rest, that clearing site data or browser cleanup will destroy
the history, and that losing the device loses the data. Mitigations:

- **Encrypted backup** — full database to a single file, AES-GCM 256 via
  WebCrypto with a key derived from an owner passphrase (PBKDF2, high iteration
  count, random salt and IV). The passphrase cannot be recovered; this is said
  before the first backup.
- **Plain JSON export** — complete and human-readable, for portability.
- **Restore** — with a schema-version check, a dry-run summary of what will be
  written, and a choice of merge or replace. In `merge` mode, two differing
  annotations for the same transaction are **never** resolved automatically —
  not by `updatedAt`, not by either side winning — because silently discarding
  a correction is precisely A3. The local annotation is kept, the incoming one
  is listed in a conflict report, and the owner chooses per conflict.
- The per-installation account fingerprint salt **must** be included in every
  backup. Without it, a restore on a reinstalled browser recomputes different
  fingerprints and orphans every account from its transactions.
- **Backup reminders** driven by the observed import cadence and the time since
  the last backup.
- Data deletion controls: delete a transaction (soft, restorable), purge
  deleted items, wipe an account, wipe everything — each with a count and a
  typed confirmation.

### 14.4 Network posture
No analytics, no advertising, no fonts or scripts from a CDN at runtime — all
assets are bundled and served from the Pages origin. The only outbound request
the application can ever make is a DeepSeek call the owner explicitly triggered
and approved. A `Content-Security-Policy` meta tag restricts connections to
`'self'` plus the DeepSeek endpoint, and the Settings screen lists what stays
local and what can leave.

---

## 15. Interface

Thirteen screens, matching the owner's list: Home dashboard, Statement import,
Transactions, Monthly budget, Spending intelligence, Mood analysis, Learning
and recommendations, AI coach, Savings goals, Recurring payments, Reports,
Money Score, Settings and privacy. Bottom tab bar on mobile with the five most
used; the rest behind a menu. Sidebar on desktop.

- **Dark and light themes**, following the system preference with a manual
  override.
- **Mobile-first transaction editing**: a single sheet with large touch targets;
  mood as a one-tap emoji row; purchase reason as chips; worthwhile as three
  buttons; note collapsed by default.
- **Mood triage queue** (addressing the real risk that annotating ~8
  transactions a day is abandoned within a week): only transactions that
  warrant it are queued — `roundup`, `internal` and, by default, recurring
  essentials are excluded — and they are presented as a swipeable one-at-a-time
  queue. An optional day-level mood applies to that day's unannotated
  transactions as a fallback. Every default here is a setting, and nothing is
  mandatory: notes and moods are always optional.
- **Import on mobile** is the shortest path in the app: open, pick file,
  preview, commit, with the gap warning prominent.
- **PWA**: installable, offline-capable, app icons, standalone display.
- Accessibility: WCAG AA contrast in both themes, keyboard navigable on
  desktop, real focus states, no colour-only encoding in charts.

---

## 16. Testing

- **Unit (Vitest):** money arithmetic in integer cents including the observed
  float-noise inputs; Excel serial date conversion; XLSX parsing; PDF text
  reconstruction including wrapped descriptions; `kind` classification;
  round-up parent linking for both `compra` and `recibo` phrasings; balance
  chain verification; duplicate detection across all four branches of §9.10,
  explicitly including two identical same-day amounts that must **not** collapse;
  coverage and gap detection; transfer pairing; refund matching; income
  calculation with zero-income and partial months; percentage allocation
  arithmetic; each statistical test against known-answer vectors; minimum-sample
  gating; Money Score component arithmetic; recommendation suppression after
  repeated rejection; override precedence in the four-tier categoriser;
  annotation survival across a re-import of an overlapping statement; export
  and restore round-trip; encrypted backup round-trip and wrong-passphrase
  failure; every schema migration forward from v1.
- **Integration:** import file A, then an overlapping file B, and assert the
  final transaction count, that no correction was lost, and that the balance
  chain is intact.
- **E2E (Playwright), against the production build served by `vite preview`:**
  import → preview → commit → dashboard renders → annotate → reload → data
  persists; plus the same run at Galaxy S26 viewport.
- **Fixtures and the no-fake-data rule (A8).** Repository fixtures are
  anonymised and amount-shifted derivatives of the real export's *structure*,
  held under `src/**/__fixtures__/`, imported only by tests, never reachable
  from application code, and never displayed as data in the UI. The real
  statements stay out of the repository (C4). A golden test reads the owner's
  real file from a path given by an environment variable and asserts 50
  transactions with a continuous balance chain; it skips when the variable is
  absent, so it runs locally for the owner and never in CI.
- **Manual verification before release:** mobile usability on the actual device,
  and the deployed GitHub Pages build.

---

## 17. Deployment

- `vite build` with `base: './'` → relative asset URLs, so the build works
  under `https://<user>.github.io/<repo>/`, on a custom domain, or from a
  subdirectory, with nothing for the owner to configure.
- Hash routing → refreshes and deep links resolve without server rewrites or a
  `404.html` trick.
- `.nojekyll` in the output so hashed asset filenames are served.
- `.github/workflows/deploy.yml`: on push to the default branch — checkout,
  Node 24, `npm ci`, `npm test`, `npm run build`, `npm run verify:dist`,
  `upload-pages-artifact`, `deploy-pages`; permissions `pages: write`,
  `id-token: write`; concurrency group so pushes queue rather than collide.
  Tests gate the build and the dist assertions gate the upload: `npm test`
  covers the unit suite and cannot run the dist assertions, because on a clean
  checkout `dist/` does not exist yet.
- `.gitignore` covers `*.xlsx`, `*.pdf`, `*.csv`, and backup/export files so a
  statement cannot be committed by accident (C4).
- **The one step that cannot be automated from here:** in the repository's
  Settings → Pages, the source must be set to "GitHub Actions". This is a
  single dropdown, done once. The README states it as step 2 of 3.
- Deployment will not be described as complete until the live URL has been
  loaded and an import verified on it.

---

## 18. Build order

Each stage leaves the project buildable and tested.

1. Project scaffold, CI, GitHub Pages deployment, PWA shell — **verified live
   before any feature work**.
2. Dexie schema v1, migration framework, export and restore.
3. XLSX import: privacy scrub, parse, classify, balance verification,
   duplicate detection, coverage and gap analysis, preview, atomic commit.
4. Transactions screen: resolved view, editing via annotations, search, sort,
   filter, soft delete and restore.
5. Accounts, transfer pairing, round-up linking, refund matching.
6. Income calculation and percentage budgeting.
7. Mood, purchase reason, worthwhile, notes, and the triage queue.
8. Learning engine: merchant canonicalisation, four-tier categoriser,
   correction memory.
9. Analytics cache, dashboard, reports.
10. Statistical battery with sample gating.
11. Recommendations, education, challenges, outcome tracking.
12. Money Score.
13. Savings goals, recurring detection.
14. PDF fallback parser.
15. Encrypted backup, restore dry-run, deletion controls.
16. DeepSeek coach with consent flow and CORS fallback.
17. CSV import with column mapping.
18. Polish, accessibility pass, device verification, README.

---

## 19. Left to the builder

Component decomposition and file layout; state management within React;
styling approach and design tokens; exact chart types per metric beyond the
legibility rule; copy wording within the stated tone rules; test granularity
beyond the named cases; animation and transition detail; icon set; the precise
weights of the six Money Score components (to be chosen so no component can
dominate, and surfaced in the UI); tokenisation details of the merchant
canonicaliser.

---

## 20. Open decisions recorded as the author's calls

These were not specified by the owner and are decided here rather than
deferred:

- Income excludes all inter-account movement, however large (§10).
- Zero-income months use a trailing three-month average, labelled provisional.
- Round-ups count as savings, not spending.
- Essential versus discretionary is a property of the category, seeded from
  ING's taxonomy and fully editable.
- Mood prompts default to discretionary spending only, excluding round-ups,
  internal transfers and recurring essentials.
- Non-parametric statistics throughout, with Benjamini–Hochberg correction.
- OCR is replaced by rejecting text-less PDFs with an instruction to export
  Excel (§5.2).
- `last4` is stored for account labelling, with a privacy setting to remove it.

---

## 21. Decisions added after the builder review

A fresh engineer reviewed §1–20 and raised ten points. Three were defects and
are fixed in place (§9.10 duplicate key, §14.3 merge conflicts and backup
salt). Seven are settled here as the author's calls.

**21.1 Figures aggregate across accounts.** All income, spending, savings,
budget and score figures are computed over the owner's whole set of accounts —
the household perimeter — with paired internal transfers netted to zero.
Per-account views exist for the ledger and balances, but never for budgeting or
scoring, because a single account's net income is meaningless when money moves
between accounts (§5.1).

**21.2 Essential versus discretionary is assigned at subcategory level.** The
sample proves category level is wrong: `Compras / Mascotas y veterinario` is a
65 € vet bill sitting under a category that is otherwise discretionary. The
app's own taxonomy is seeded as one node per observed ING pair; an unseen pair
encountered at import auto-creates a node, defaults to `discretionary`, and is
flagged for review rather than silently classified. Every assignment is
editable, and an edit is a learning event.

**21.3 The mood and reason vocabulary is the owner's own list, fixed at
seed.** The twelve moods and eight purchase reasons the owner specified are the
seed vocabulary, so every construct §12's battery tests is present as data:
`Stressed` and `Bored` are mood labels, `Impulse` is a purchase reason. Valence
is an integer −2…+2 for ordinal tests, `null` for `Other` and for custom moods
until the owner assigns one; `null`-valence moods are excluded from ordinal
tests but counted in frequency tests. A seeded mood is never deleted, only
archived — its id stays referenced by past annotations, so history remains
valid and findings remain reproducible.

**21.4 Hindsight is collected in its own pass.** `worthwhile` cannot be
captured at purchase time. A **Worth it?** queue surfaces spending that is at
least seven days old, is discretionary, has a mood or reason recorded, and has
no judgement yet — oldest first, three taps. Without this flow the regret
learning, the worthwhile report, Money Score component 6 and the
reason→worthwhile test never populate. The seven-day delay and the queue's
filters are settings.

**21.5 One allocation model, not two.** A savings goal's contribution *is* a
budget allocation whose category is that goal, so budget and goals draw on one
income and one set of percentages that cannot disagree. Allocations may sum
beyond 100 % — the owner may be deliberately modelling a deficit — and the
budget screen states the overcommitment plainly without blocking it. The
unallocated remainder is shown as `Unallocated`. Money Score component 1
measures *spending against allocation*, per category, weighted by allocation
size; it does not measure allocation against income. Round-ups count toward
total savings, and toward a specific goal only if the owner links the savings
account to that goal.

**21.6 "Confidence" is three distinct things and gets three distinct names.**
`statisticalConfidence` on a finding (a corrected significance level and effect
size interval, §12); `matchScore` on an inferred `transfers` or `recurring`
row (how well the evidence pins the pairing, 0–1); `recommendationConfidence`
(derived from the strength of the underlying finding, the number of supporting
transactions, and the owner's outcome history for that recommendation family).
No screen may use the bare word "confidence" without one of these meanings
behind it.

**21.7 Third-party names stay local but never leave the device.** Peer payments
(Bizum and transfers to named individuals) will accumulate over years. Scrubbing
them locally would make the ledger unusable — "Bizum to [redacted]" tells the
owner nothing — so counterparty names are retained on the device, where all
financial data already lives. They are, however, classified as a `person`
counterparty rather than a merchant, which keeps them out of merchant-frequency
learning and subscription detection, and **person names are unconditionally
stripped from every DeepSeek payload**, including when the owner has enabled
raw descriptions for a single question. A6 is about the owner's identity; this
extends the same courtesy to everyone else, at the only boundary that matters —
the one where data leaves.

**21.8 The recommendation catalogue is specified, not improvised.** §13.2 fixes
the six fields; the rule set itself is enumerated in the Plan 4 document before
any of it is built, as an explicit table of trigger, evidence query, impact
arithmetic and education topic. Estimated financial impact is only ever
computed as a projection of the owner's **own observed** figures over a stated
window (for example: "the last three months of this category's spending,
reduced by the percentage you would be adopting"), never a modelled or assumed
return, and the window and inputs are shown with the figure. A recommendation
whose impact cannot be derived that way shows no euro figure at all rather than
an invented one (A2, A8).

---

## 22. Answers to the builder review's open questions

All three are now resolved by the owner.

**22.1 Income arrives in the current account** (`…5566`) — the six-day window
simply contained no payday. No manual income-entry screen is needed; §10 works
from the statements as designed. Budget screens must nonetheless render
correctly for a month in which income has not yet arrived, using the
provisional basis of §10 and labelling it as such.

**22.2 The savings account export was supplied and verified** — see §5.3. The
format is identical, so one parser serves both, and every pairing rule in §9.2
is confirmed against real data rather than assumed.

**22.3 Backfill is in scope.** The owner will load older statements. Therefore:

- `imports` records a coverage window per account, and the set of windows per
  account is kept as an explicit ordered list of covered ranges, not a single
  earliest/latest pair.
- Gap analysis is **bidirectional**: a file may extend coverage forward,
  backward, or fill a hole between two existing windows. In each case the test
  is the same — the balance chain must join at both seams. A file that extends
  coverage backwards is validated by checking that its *latest* row's balance
  plus the following stored transaction's amount equals that stored
  transaction's balance.
- A file that neither touches nor adjoins existing coverage is accepted, and
  the resulting hole is reported as an uncovered range the owner can close.
- Because the two supplied exports already have different windows (6 days
  against 13), this path is exercised by the owner's real data from the first
  import onward.

### Consequent amendment to §9.1 and §9.11

Replace the one-directional comparison described in §9.11 with the
bidirectional seam check above. §9.1's coverage model becomes a list of ranges
per account; the cadence estimate is unchanged and remains advisory only.

---

## 23. Schema deltas required by §21–§22

§8's table list predates the decisions in §21 and the owner's answers in §22.
Four field-level changes follow from them and are applied in §8 above. They
are recorded here so the reasoning travels with the schema, and they are made
now rather than later because changing a Dexie schema after data exists
requires a migration.

**23.1 `merchants.kind: 'merchant' | 'person'`** — required by §21.7. Peer
payments (Bizum and transfers to named individuals) must be classified as a
`person` counterparty so they stay out of merchant-frequency learning and
subscription detection, and so person names can be stripped unconditionally
from every DeepSeek payload. Without the field, the categoriser cannot tell a
shop from a friend.

**23.2 `budgetAllocations.savingsGoalId` (nullable, exclusive with
`categoryId`)** — required by §21.5. A savings goal's contribution *is* a
budget allocation, so one allocation model covers both; an allocation
therefore targets either a category or a goal. Exactly one of the two must be
set.

**23.3 `transfers.confidence` → `transfers.matchScore` and
`recurring.confidence` → `recurring.matchScore`** — required by §21.6, which
splits one overloaded word into three: `statisticalConfidence` on a finding,
`matchScore` on an inferred pairing, and `recommendationConfidence` on a
recommendation. The remaining uses of "confidence" in this document are the
statistical and recommendation senses and are correct as written.

**23.4 No schema change for coverage ranges.** §22.3 requires the set of
covered date ranges per account to be an ordered list rather than a single
earliest/latest pair, which reads like a new table. It is not: each `imports`
row already carries `coverageStart` and `coverageEnd`, and the covered set is
their union per account. By §7.1 that makes it derived data, not durable
truth, so it is computed from the `imports` rows — a union over tens of rows,
not millions — and cached like any other derived value if it ever needs to be.
Storing it would create a second source of truth that could disagree with the
import history. The union function belongs to the import pipeline (Plan 2),
not to the schema.

---

## 24. Correction: `openDatabase` needs a fourth failure reason

§14.3 and the Plan 1 task text gave `openDatabase` three failure reasons:
`blocked`, `unsupported` and `corrupt`. Three is not enough, and the gap was
found by reading the implementation rather than the spec.

With only three, every unrecognised failure has to be reported as `corrupt`.
But `QuotaExceededError` on open (storage full), Firefox's `UnknownError`, and
transient platform failures all reach that branch — so the application would
tell the owner their financial history is corrupt when the actual cause is a
full disk and their data is intact. Asserting data loss that has not been
established is precisely what A8 forbids, and it is the single most alarming
false statement this application could make.

The union therefore becomes `'blocked' | 'unsupported' | 'corrupt' | 'unknown'`:

- `blocked` — `SecurityError`, `InvalidStateError`, Dexie's `MissingAPIError`.
  Storage exists but this context may not use it (private window, blocked site
  data). Dexie wraps the browser's error, so classification must unwrap the
  `inner` chain and also check the message prefix.
- `unsupported` — `globalThis.indexedDB` is absent.
- `corrupt` — `VersionError` or `DatabaseClosedError` only. The store exists and
  is unusable as found.
- `unknown` — everything else. The copy states that the database could not be
  opened, that the cause is not one the application recognises, shows the
  `detail` string for diagnosis, and says the data is most likely intact. It
  must not imply data loss.

---

## 25. The seeded taxonomy is two levels, not flat

§21.2 says the app's taxonomy is "one node per observed ING pair", which Task 5
implemented literally: twelve flat nodes, every `parentId` null. That reading is
defensible from the wording and wrong for the product.

A flat taxonomy makes §13.1's category breakdown a twelve-item list with no
grouping, and it only grows — ING's full taxonomy is far larger than the twelve
pairs one six-day export happened to contain. The owner asked not to be
overwhelmed with statistics (§9); an ungrouped list of every subcategory they
have ever spent in is exactly that. `categories.parentId` exists in §8 precisely
to carry this.

So the seed creates both levels:

- **A parent node per ING top-level category** — `Ahorro`, `Alimentación`,
  `Compras`, `Educación y salud`, `Hogar`, `Movimientos excluidos`,
  `Ocio y viajes`, `Otros gastos`, `Vehículo y transporte` — each with
  `parentId: null`.
- **A child node per observed ING pair**, with `parentId` set to its top-level
  node, carrying the `kind` from the table in §21.2.

**Classification stays on the leaf.** `CategoryRow.kind` becomes
`CategoryKind | null`: `null` on a parent, required on a leaf. Parents exist to
group, never to classify — which is the whole point of §21.2's rule that
essential-versus-discretionary is assigned at subcategory level, since the
owner's own `Compras / Mascotas y veterinario` vet bill proves a parent cannot
carry a meaningful kind.

This is done now rather than later because adding the parents after the owner
has edited their categories would mean re-parenting their data. Adding category
rows needs no Dexie migration — they are data, not schema — and `kind`
admitting `null` is a TypeScript change only, since the field is not indexed.

**A second, smaller correction:** `moods.order` and `purchaseReasons.order` are
indexed. Dexie's `toArray()` returns primary-key order, so with ids like
`mood.happy` the display order the owner specified is alphabetical nonsense
unless every consumer remembers to sort. An index makes `orderBy('order')` the
natural call and removes a convention nobody can see. `order` is a number, so it
is a valid IndexedDB key — unlike the booleans of §24's note.

---

## 26. The purchase-reason list, and verification of the seeded strings

**26.1 The eight purchase reasons, enumerated.** §21.3 refers to "the eight
purchase reasons the owner specified" without listing them, which left a
reviewer unable to verify the seed. They are, in the owner's own order:

`Essential`, `Planned`, `Impulse`, `Convenience`, `Social pressure`,
`Reward`, `Emotional spending`, `Other`.

The seeded values match. `Impulse` and `Social pressure` in particular are
load-bearing: §12's boredom-to-impulse chi-square and the
reason-to-worthwhile contingency both test constructs that must exist as data,
not as prose.

**26.2 The twelve ING category pairs are verified against the owner's real
files, not against a transcribed table.** A reviewer correctly observed that
the byte-exactness of the accented Spanish strings rested on a table the
controller typed, and that a test written in the same session as the seed
cannot establish it independently. The check was therefore run directly
against both real exports — `movements-15112026.xlsx` (current account) and
`movements-15112026.xls` (savings account):

- 12 distinct `(CATEGORÍA, SUBCATEGORÍA)` pairs exist across the two files.
- 12 pairs are seeded.
- **No pair appears in the real files without being seeded**, which is the
  failure that matters: an unseeded pair matches nothing at import and those
  transactions fall silently into an unrecognised bucket.
- No seeded pair is absent from the real files.
- All 12 are **byte-identical**, not merely Unicode-equivalent — both sides are
  NFC-normalised, so there are no decomposed accents that would compare equal
  in one normalisation and unequal in another.

This verification cannot live in the repository as a test, because it reads the
owner's real statements and C4 keeps those out of version control. The import
task (Plan 2) carries the environment-variable-gated golden test described in
§16, which is where this check belongs permanently.

---

## 27. Restore: three corrections from implementation

**27.1 A fourth refusal reason, `write-failed`, with `detail`.** §14.3 named
`format`, `newer-schema` and `malformed`. A storage failure during the write
fits none of them, and reporting a full disk as "malformed" would tell the
owner their backup file is corrupt when it is fine — the same false claim §24
corrected for `openDatabase`. `RestoreReport` also gains optional `detail` and
`conflictIds`.

**27.2 `inspectBundle` is asynchronous and takes the mode.** The dry run was
specified as synchronous, which cannot work: reporting merge conflicts requires
reading the local rows to compare against. It shares its planning code with
`restoreBundle`, and a test asserts the dry run and the real run produce the
same report — so the preview the owner approves is the plan that executes,
rather than a second implementation that can drift from it.

**27.3 Merging two datasets with different account salts is refused.** This
corrects a rule of mine that was quietly dangerous. §14.3 said annotations get
conflict handling and "all other tables are keyed upserts" — which makes
`settings` an upsert, so an incoming `privacy.accountSalt` would overwrite the
local one. §14.1's fingerprints are salted hashes, so every local account would
instantly stop matching its own transactions: data all present, silently
unusable. It is the exact failure §14.3 added the salt-in-backup rule to
prevent, reintroduced through the merge path.

The rule is therefore:

- **Replace mode** takes the bundle's salt. This is the restore-to-a-new-browser
  case and the incoming salt is the correct one.
- **Merge into a database with no salt yet** takes the bundle's salt.
- **Merge where both salts exist and differ** is **refused whole**, with reason
  `'salt-mismatch'`. The two datasets' account fingerprints are computed under
  different salts and are mutually unintelligible; merging them would produce
  duplicate accounts the application cannot reconcile and the owner cannot
  untangle. Refusing is the only honest outcome, and the message must say that
  the backup came from a different installation and that replace mode is the
  way to use it.
- Merge where both salts exist and match proceeds normally.

**27.4 The dry run must predict what it can.** `inspectBundle` cannot foresee
every write-time rejection, but two are predictable from the local rows and
must be reported rather than discovered mid-restore: a `dedupKey` collision
under a different transaction id, and an incoming transaction that would change
an immutable bank field of an existing row (§8.1). Whatever remains genuinely
unpredictable is named in the report, so "no conflicts" never over-promises.

---

## 28. Restore: closing the salt and completeness holes

§27.3 specified four salt branches and a review found a fifth case it never
covered. Both defects below are in **my** rules, not in the implementation of
them, and both share one shape: a restore that destroys data and reports
success.

**28.1 An incoming settings row without a usable salt must be refused.**
§27.3 says a merge is refused when "both salts exist and differ". If the
incoming `settings` row has `privacy` or `accountSalt` missing, empty or
non-string, neither side of that comparison holds, so the guard falls through
and `settings` is written as an ordinary keyed upsert — overwriting the local
salt with nothing. Every local account fingerprint then stops matching its
transactions, which is exactly the failure §27.3 was added to prevent. It
reaches replace mode by the same route.

Therefore: validation requires any `settings` row in a bundle to carry
`privacy.accountSalt` as a non-empty string, failing as `malformed` otherwise.
In merge mode, a local salt is additionally never overwritten by an incoming
value that is not a valid salt. The valid-salt branches of §27.3 are unchanged.

**28.2 Replace mode must refuse an incomplete bundle.** Replace clears every
live table and writes whatever the bundle holds for it, so a bundle whose
`tables` map omits a table silently empties it — and
`{format, schemaVersion, exportedAt, tables: {}}` currently passes validation,
clears the entire database including the salt, and reports `ok: true`. A
restore cannot be allowed to report success while deleting everything.

`exportBundle` always emits every table, so only a hand-edited or truncated
file reaches this path — precisely the case where refusing is right. Therefore
replace mode requires every live table to be present in the bundle, with one
deliberate exception: when `bundle.schemaVersion < SCHEMA_VERSION`, tables that
did not exist at the bundle's version may legitimately be absent and are left
empty rather than refused. `settings`, with a valid salt, is required in every
case.

**28.3 Merge must not overwrite the owner's settings.** §14.3's "all other
tables are keyed upserts" lets an older backup silently replace current
preferences — theme, privacy choices, the DeepSeek configuration. Those are
owner decisions, and A3's prohibition on silently discarding them applies as
much as it does to a category correction. In merge mode the local `settings`
row therefore wins, as annotations do, and a differing incoming row is counted
as a conflict rather than applied.

**28.4 A known gap, recorded rather than fixed.** A bundle whose
`schemaVersion` is *below* the current one is restored without running any
migration. That is correct today, since only version 1 exists. At the first
schema bump, restore must run the registered migrations over the restored data,
and this section is the note that it has not been built yet.

---

## 29. Two prerequisites for the first schema bump

§28.2 and §28.4 each described a limitation that is unreachable while only
schema version 1 exists. Both become live defects the moment a version 2 is
registered, and both are easy to forget precisely because nothing can exercise
them today. They are therefore recorded here as **prerequisites, not notes**: no
schema version above 1 may be registered until both are done.

**29.1 A per-table "introduced in version" registry.** §28.2 lets a replace
omit tables when `bundle.schemaVersion < SCHEMA_VERSION`, because a backup
taken at an older version legitimately predates newer tables. That permission
is currently blanket: it allows omitting *any* table, including one that did
exist at the bundle's own version. At the first schema bump, an older backup
that omits `transactions` would therefore pass validation and replace would
erase that table while reporting success — the §28.2 failure, reintroduced
through the exception written to prevent it.

The fix is a registry recording the version each table first appeared in, so
the exception permits omitting only tables introduced *after* the bundle's
version. Until that registry exists, `SCHEMA_VERSION` must stay at 1.

**29.2 Migrations must run over restored data.** §28.4 records that a bundle
with a `schemaVersion` below the current one is restored without any migration
being applied. At version 1 there is nothing to migrate. From version 2 onward,
restoring an older bundle without running the registered upgrades would write
rows in an outdated shape into a current-schema database, and nothing would
detect it — every later read would silently see malformed rows.

Restore must therefore apply the registered migrations to the bundle's data
before writing, or refuse the bundle and say why. Either is acceptable;
silently writing stale shapes is not.

**Why this section exists.** Three times in this project a guard has had a hole
in the case its author did not enumerate — §27.3's missing salt, §28.2's omitted
table, and the version declaration that discarded the account hooks. Each was
found by someone other than the author. Writing these two down as gates, rather
than as comments in code nobody will re-read, is the cheapest available
defence against the same pattern recurring at the one moment it would cost the
owner real data.

---

## 30. A backup button must exist before the first import

Plan 1 built export and restore as tested engine code, and built no way to
reach it. `exportBundle` and `restoreBundle` are called only from tests;
Settings is a placeholder. So the README's backup section currently has to
say, honestly, that the owner cannot take a backup from the app at all.

That is a sequencing defect in my own plan, and it has a deadline. The moment
the owner imports a statement and starts correcting categories, recording
moods and marking purchases worthwhile, they hold records that exist nowhere
else. The statement files can be re-imported; **the annotations cannot be
recreated**. §14.3 calls backup the whole safety net, and a safety net that
cannot be reached is not one.

Therefore: **a minimal export and restore UI on the Settings screen is the
first task of Plan 2, before the import pipeline lands.** It needs only an
export button that downloads the bundle as a file, a file picker that runs
`inspectBundle` and shows the report, and a confirm step that runs
`restoreBundle`. The engine, its refusals and its conflict reporting already
exist and are tested; this is wiring, not new logic.

Encrypted backup remains Plan 5. The plain export is enough to make the data
recoverable, which is the property that must not wait.

---

## 31. Corrections from the whole-branch review

**31.1 The seeded category kinds, written down.** §21.2 and §25 both refer to
"the table in §21.2", which this document never actually contained — it was
given to the implementer in a dispatch and never written back. The seeded
values are:

| ING category | ING subcategory | kind |
|---|---|---|
| Ahorro | Redondeo | `savings` |
| Alimentación | Supermercados y alimentación | `essential` |
| Compras | Compras (otros) | `discretionary` |
| Compras | Mascotas y veterinario | `essential` |
| Educación y salud | Farmacia, herbolario y nutrición | `essential` |
| Hogar | Mantenimiento del hogar | `essential` |
| Movimientos excluidos | Traspaso entre cuentas | `internal` |
| Ocio y viajes | Cafeterías y restaurantes | `discretionary` |
| Ocio y viajes | Libros, música y videojuegos | `discretionary` |
| Otros gastos | Otros gastos (otros) | `discretionary` |
| Otros gastos | Transferencias | `discretionary` |
| Vehículo y transporte | Taxis y Carsharing | `discretionary` |

`Transferencias` (a remittance, possibly family support) and `Taxis y
Carsharing` (possibly a commute) are deliberate judgement calls that default to
`discretionary`; both are editable and an edit is a learning event.

**31.2 Merge is additive. Local always wins.** §14.3's "all other tables are
keyed upserts" lets an incoming row overwrite an existing one in every table
except `annotations` and `settings`. So merging a three-month-old backup to
recover some transactions would also revert edited category kinds, merchant
patterns, budget percentages, confirmed pairings, and `recommendationState`
rejection counts — resurrecting recommendations the owner had rejected twice.
§28.3 already reasoned that owner decisions must not be silently discarded and
then fixed only `settings`.

The rule is therefore simple and uniform: **in merge mode an existing local row
always wins**. Incoming rows are written only where the key is absent. A
difference on an existing row is counted and listed as a conflict, never
applied. Merge becomes purely additive — "add what I do not have" — which is
also what the word leads the owner to expect. Replace is unchanged: it is the
mode that means "make this device match the backup".

`perTable` must distinguish new rows from conflicts, so a preview reporting
`willWrite: 4` can never be hiding four reverted edits.

**31.3 Derived data must not survive a restore.** `analyticsCache` is derived
(§7.1) and is currently exported and merge-written like durable truth. It stays
in the bundle so replace-mode completeness (§28.2) keeps its simple "every table
present" rule, but **any restore clears it** — a cache restored from a backup
describes inputs that are no longer there.

## 32. Requirements this foundation hands to Plan 2

Four things the later sections need that the schema cannot express today. All
are unindexed fields, so none needs a Dexie migration — but they must be added
deliberately rather than discovered mid-build.

**32.1 Every owner correction must append a learning event, in the same
transaction as the correction.** §11 treats corrections as events in append-only
`learningEvents`; an `annotations` row holds only the latest value. If Plans 2
and 3 write corrections before event logging exists, that history is
**permanently absent from the training record** — it cannot be reconstructed,
and it is the data the learning engine runs on. Plan 2 must therefore route
every annotation write through one function that appends the event atomically.
The same module owns the resolution rule (`transaction ⊕ annotation`) and the
dedup rule (§9.10: bank values only, never the resolved view), so each exists in
exactly one place.

**32.2 `transfers.linkKind: 'internal' | 'roundup' | 'refund'`.** §10's refund
link is structurally a transfer pair, but with no discriminator a refund and an
internal transfer are indistinguishable — and a refund must *reduce category
spending*, not merely drop out of income.

**32.3 `annotations.roundupParentIdOverride`.** `transactions.roundupParentId`
is immutable, so when two same-amount purchases share a day (§9.2's stated
ambiguous case) the owner's resolution has nowhere to go.

**32.4 A "needs review" flag on `categories`.** §21.2 says an unseen ING pair
auto-creates, defaults to `discretionary` and is flagged for review. There is no
field to flag it with, which is the whole point of the rule.

---

## 33. Corrections from the Plan 2 builder check

A reviewer read the Plan 2 plan against the real exports and found two claims in
this document's own evidence base to be wrong. Both were recorded as verified.

**33.1 The 68-character truncation claim was false, and it would have corrupted
the duplicate key.** §5.1 asserted ING hard-truncates descriptions at 68
characters, and §9.10 therefore truncated before hashing. Measured against the
current account: descriptions reach **97** characters, **19 of 50** exceed 68,
and **none is exactly 68**. The row that prompted the claim is 69 characters and
only looks clipped because ING repeats the merchant name — I generalised a rule
from a single row that did not demonstrate it.

The consequence was worse than the error. Every round-up description carries its
parent's amount at character 78, so truncating at 68 reduced **all 18 round-ups
to one identical prefix** — 1 distinct value out of 18. They would still have
been distinguishable by balance, but the description would have contributed
nothing to the key it was in.

> **Superseded by §37.** The description is no longer part of the duplicate key. The reasoning here is kept because it records why, but do not implement it.

**Truncation is removed.** `dedupKey` is now
`sha256(accountId | valueDate | amountCents | balanceCents | scrubbedDescription)`
over the **full, scrubbed** description. Hashing keeps an unbounded string out of
an indexed field, and scrubbing first means the key can never derive from the
holder's name.

**33.2 Round-up parents are ambiguous by amount alone, and the balance chain
resolves them.** §5.3 reported "18/18 round-ups paired", which was a
**many-to-many** count, not a one-to-one match. On 2026-11-11 the current
account holds two identical `Pago en COMERCIO EJEMPLO SL` −23,20 € rows and two
identical −1,60 € round-ups, each saying "tu compra de 23 EUR y 20 cts". Amount
and date cannot tell them apart.

The balance chain can, deterministically: a round-up's balance is its parent's
balance minus the round-up (205,40 → 203,80 and 190,80 → 189,20), and the two
rows are adjacent in file order. **Adjacency in the verified balance chain is
therefore an allowed disambiguator**, because it is evidence rather than a
guess — §9.2's "flag, never guess" forbids choosing between equally-supported
candidates, which this is not. Only where adjacency also ties is the link
flagged ambiguous for the owner, and `annotations.roundupParentIdOverride`
(§32.3) is where their answer goes.

## 34. Rulings that shape Plan 2

**34.1 A match against a soft-deleted transaction is a review item, never an
automatic insert.** `dedupKey` is uniquely indexed, so treating a deleted row as
absent would throw on insert and roll back the whole import. The owner is asked
whether to restore the transaction they deleted or skip it.

**34.2 Edits made in the import preview become annotations, not bank values.**
They are written inside the commit transaction, after the rows are inserted. A
preview edit that changed the stored row would violate §8.1 and alter
`dedupKey`, so the next overlapping export would stop matching and create the
duplicate G2/A4 forbids.

**34.3 A transaction's category is derived at read time, not written per row.**
`resolve()` returns the owner's annotation when present, and otherwise the
category whose ING mapping matches the row's pair. Writing an engine-authored
annotation for every import would add ~6,000 rows a year whose only purpose is
to restate what the file already says, and would blur the line between what the
owner decided and what the app inferred.

**34.4 Re-importing a byte-identical file is refused at preview.**
`imports.fileHash` is uniquely indexed; the preview hashes the bytes and, on a
match, names the date of the previous import. This is clearer than a preview
reporting fifty duplicates and writing nothing.

**34.5 `last4` is stored, subject to `privacy.storeLast4`.** §14.1 permits it and
the account guard's own comment allows a label like "Cuenta 5566". The import's
privacy test therefore asserts the absence of the **full account number** and the
**holder's name**, not of a four-digit fragment.

**34.6 One learning event per changed field**, not per save. Plan 4's
correlations are per-field; a multi-field save emits several events in one
transaction.

**34.7 Test fixtures are synthesised in code.** `.gitignore` excludes every
spreadsheet extension and CI runs on a clean checkout, so a committed binary
fixture would be silently absent and the tests would fail there. Fixtures are
built with `fflate.zipSync` from anonymised literal rows. The golden test against
the owner's real files stays environment-gated (§16, §26.2).

**34.8 The first import of an account reports `first-import`**, not `detached`.
Telling the owner their opening statement leaves an uncovered range would be
true and useless.

---

## 35. `ingMappings` uniqueness is a write-side obligation

`categoryIdForIngPair` builds an index from every category's `ingMappings` and
**throws** if two categories claim the same ING pair, rather than picking an
arbitrary winner. That is the right failure — a silent arbitrary choice would
mis-categorise transactions forever and nobody would ever see why.

But it fails at *read* time, and the resolved view is read on every screen and
inside every owner write. So a single bad row takes the whole application down,
not just the category that caused it.

The seed cannot produce a duplicate: §31.1's twelve pairs are distinct and each
category carries exactly one mapping. The exposure is everything that writes
`ingMappings` **outside** the seed:

- **Plan 2, Task 9's auto-created categories.** An unseen ING pair creates a
  leaf carrying that pair as its mapping. It must check no existing category
  already claims it — inside the same transaction as the insert, or the check
  races the write.
- **Any future category-editing UI**, which must refuse to assign a pair
  another category already holds.
- **Restore.** A bundle from an older or hand-edited database can carry
  duplicates. Validation should reject it with a reason rather than letting a
  restore produce a database that cannot be read.

The rule: **nothing may write `ingMappings` without first proving the pair is
unclaimed.** The read-time throw stays as the backstop it is meant to be.

---

> **Superseded by §37.** The description is no longer part of the duplicate key. The reasoning here is kept because it records why, but do not implement it.

## 36. The scrub must be canonical, because the duplicate key depends on it

§33.1 keys duplicates over the **scrubbed** description, deliberately: a
SHA-256 of the raw text would let anyone holding a database dump brute-force
the holder's name against the stored key, since the scrubbed description sits
beside it in plaintext and common names are guessable. Scrubbing first is the
right call and it stays.

But it couples two things that must now be reasoned about together: **if the
scrub's output varies, the duplicate key varies, and the same transaction
imported twice becomes two transactions** — the G2/A4 failure the key exists to
prevent.

The variation is realistic rather than theoretical. The name tokens come from
each file's own header block. Two exports can legitimately carry the holder's
name differently — ING already writes both the full name (here the invented stand-in
`PRUEBA ANÓNIMA TESTER`, see §5.1) and a form truncated after the second word,
`PRUEBA ANÓNIMA`, inside descriptions, and a bank that changes an
export template can change the header form too. Token-by-token replacement
would then produce `[redacted] [redacted] [redacted]` from one file and
`[redacted] [redacted]` from another for the same transaction, hashing to
different keys.

**The scrub must therefore be canonical: adjacent redactions collapse into
exactly one marker.** `Traspaso emitido a PRUEBA ANÓNIMA TESTER Tu ahorro…` and
`Traspaso emitido a PRUEBA ANÓNIMA Tu ahorro…` both scrub to
`Traspaso emitido a [redacted] Tu ahorro…`. How many name tokens matched stops
being observable in the output, and the key is stable across files that write
the name differently.

A test asserting only "the same input scrubs identically every time" does not
cover this — the inputs differ. The property to test is that **different
renderings of the same name produce the same scrubbed text.**

---

## 37. The duplicate key drops the description entirely

§33.1 keyed duplicates over the scrubbed description, and §36 then had to make
the scrub canonical so the key would be stable. The implementer of Task 4
pointed out that canonical collapsing fixes variation *within* a description
but cannot fix a mismatch between two files' **header** token sets: if one
export's header omitted a surname, that description would scrub to
`[redacted] TESTER` in one file and `[redacted]` in another, and the key
would differ again.

Rather than defend the coupling, remove it. **The description is not needed for
uniqueness at all.**

The balance is a running total, so within one account a transaction's
post-transaction balance and its amount together place it at exactly one point
in the ledger. Two distinct transactions cannot share both. Verified against
the owner's real data: across all 100 rows of the two exports,
`(valueDate, amountCents, balanceCents)` is unique — 50 of 50 in each file,
with and without the description. The description was carrying no information
the other three fields did not already carry.

**The key is therefore
`sha256(accountId | valueDate | amountCents | balanceCents)`.**

This is strictly better in three ways: the key no longer depends on the scrub,
so §36's canonical collapsing stops being load-bearing for correctness (it
stays, because a stable redaction is still right for display); the key cannot
derive from the holder's name by any route; and the ledger arithmetic that
makes it unique is a property of double-entry bookkeeping rather than a
coincidence of this bank's description format.

**§9.10's review branch is preserved and becomes clearer.** A key match means
the two rows occupy the same point in the ledger. If their descriptions also
match, it is a duplicate. If the descriptions differ, that is exactly the
"same slot, different description" case §9.10 already sends to the owner for
review — now expressed as a comparison rather than hidden inside a hash.

**One carry-forward for CSV import (plan stage 17).** A source that does not
carry a running balance would give every row the same `balanceCents` and the
key would collide. Any such importer must either refuse, or fall back to a key
that includes the description — and if it falls back, §36's canonical scrub
becomes load-bearing again for that source.

---

## 38. Correction to §21.2 — the kind an auto-created category defaults to

§21.2 says an unseen ING pair encountered at import auto-creates a node, **defaults
to `discretionary`**, and is flagged for review. The default exists so that an
unreviewed guess can never claim a spend is *essential*, which would make the owner's
spending look more unavoidable than it is. That reasoning is sound for a pair whose
rows are debits. It is wrong for a pair whose rows are all credits.

The owner's own case makes it concrete. Their exports contain **no income pair at all**,
because they had not been paid inside the exported window — verified, not assumed:
`ING_CATEGORY_MAP` holds twelve pairs and none of them is income. So the first salary
that arrives will introduce an unseen pair, and under §21.2 as written the app would
create a category for their salary and label it *discretionary spending*. The owner
would be asked to review a nonsense label.

**The rule, corrected:** an auto-created leaf defaults to `discretionary`, **except
where every row carrying that pair in the file that introduced it is a credit, in
which case it defaults to `income`**. Either way `needsReview` is true and the owner
is told the category was created.

Two things keep this safe rather than clever:

- **`kind` on a transaction is never affected.** §8.2's `classifyKind` decides by sign
  and by the two explicit ING rules, never by the category's kind, so income detection
  does not depend on this default being right. Verified end to end in a browser: a
  credit in an unmapped pair imports as `income` regardless.
- **The default is a label, not a commitment.** It is flagged for review on creation,
  so the first analysis that leans on it is one the owner has already seen.

The known cost, stated plainly: the default depends on the file that happened to
introduce the pair, so the same ING pair could have been created as `income` from one
export and `discretionary` from another. That is a file-order dependency, and it is
tolerable only because the category is flagged for review either way. It must not be
extended into any rule the owner does not confirm.

---

## 39. Carried out of Plan 2, binding on Plan 3

Plan 2's whole-branch review found work that is real but belongs to a later
plan. Recorded here because a finding that lives only in a review report is a
finding that gets rediscovered, not fixed.

**39.1 `privacy.storeLast4` has no control, and §14.1 now describes something
real.** Plan 2 is the plan that started persisting `last4`, and the import path
honours the flag correctly — but nothing lets the owner turn it off, and §14.1's
promised owner-chosen account label does not exist. Until then the account is
labelled `Cuenta <last4>` with no way to change it. Plan 3 owns both.

**39.2 Ambiguity is detected and never surfaced.** `linkRoundups` distinguishes
`'ambiguous'` (adjacency tied) from `'none'` (no candidate parent in this file),
and the commit correctly leaves `roundupParentId` null for both. Nothing asks
the owner, and `annotations.roundupParentIdOverride` (§32.3) has no writer. The
distinction was kept deliberately (P2-R34); Plan 3 must either use it or the
spec must say it is informational only.

**39.3 The daily screen opens on controls.** At 375 px the transactions
screen's eight filters fill the viewport, so the first transaction is below the
fold on every visit. Collapse them behind a disclosure, shut by default. Related
and equally small: nothing in the default view hints that deleted rows exist,
which matters because restore is the import path's only recovery route; the
preview's duplicates list truncates silently past 100; and a From date later
than To gives the generic "nothing matches" copy rather than naming the
inverted range.

**39.4 The list loads every transaction to render fifty.** The DOM is bounded,
which is what Plan 2 required, but `loadAll` reads and resolves every row and
re-runs after every single edit. At three years (~9,000 rows) that is four table
reads per save on a phone. Not a defect in Plan 2; it is the pattern Plans 3-5
would copy, so it should be bounded before they do.

Plan 4 copied it once and the whole-branch review caught it: `regretClusters`
read `db.transactions.toArray()` on its all-history branch, which is the
Intelligence screen's default view on a route in the mobile tab bar, re-run on
every period toggle. **The read is now driven from `annotations`**: regret only
concerns rows the owner has answered, `worthwhile` cannot be indexed (IndexedDB
has no boolean keys), but an annotation exists only for a row the owner has
touched — so reading the annotations and `bulkGet`ting just the answered
transactions costs what the owner's own activity costs, not what their history
costs. That is the sense of "bounded" that matters here, and it is the same
trick `src/import/pipeline.ts` uses for the classifier's training set. The two
unbounded reads this plan sanctioned stay sanctioned and stay commented as such:
`learningEvents` in `src/learning/memory.ts`, and the pass over categorised
annotations at import time.

**39.5 `AnnotationRow.subcategoryId` is vestigial** (P2-R51). It is carried
through `resolve`, listed in `OWNER_FIELDS`, `EVENT_FOR_FIELD` and
`LearningEventType`, and derived or read by nothing, because `categoryId` holds
the leaf (§21.2: parents group, never classify). Removing the field is a schema
change and waits on §29's gates. Plan 3 must not build on it as though it
carried meaning.

**39.6 A row held for review does not overstate coverage** — ruled, so that it
is not "fixed" later into a bug. The review raised that `coverageStart`/`End`
span every row in the file including rows held for review, which are never
written, and concluded coverage is recorded wider than what was stored. It is
not. Every review verdict names a row that already exists in the database:
`deleted` and `same-slot-different-description` both carry the `existingId` of
a stored row, and `duplicate-within-file` names an earlier row of the same file
which *is* written as new. There is no review verdict whose day lacks a stored
row, so the coverage span is exact. The reasoning belongs in the code beside
the computation, because the next reader will have the same doubt.

---

## 40. Two corrections from Plan 3's annotation queues

**40.1 There is a fourteenth screen: "Worth it?".** §15 lists thirteen screens, taken from
the owner's own list, and the hindsight queue is not among them — §21.4 describes it as a
queue without saying where it lives. Plan 3 gave it its own route rather than a mode inside
Mood analysis, and that is recorded here rather than left as an undocumented deviation.

The reason is §21.4's own: `worthwhile` cannot be captured at purchase time, so this is a
different activity from mood triage, done at a different time, about older transactions.
Folding it into the mood screen as a second mode would bury the one flow that §21.4 says
four separate features depend on — the regret learning, the worthwhile report, Money Score
component 6 and the reason→worthwhile correlation. A buried queue is an unused queue.

**40.2 The queue's filters are deliberately not settings; only the delay is.** §21.4 says
"the seven-day delay and the queue's filters are settings". The delay is
(`settings.worthwhileDelayDays`, default 7). The filters are not, and should not be: the
discretionary-and-eligible test is the **shared** `worthAnnotating` predicate that the mood
queue also uses, and making it separately configurable per queue would let the two drift
until the owner sees a transaction in one and not the other with no explanation they could
discover. One definition of "worth asking about", used by both, is worth more than the
flexibility.

**The known cost, stated so Plan 4 does not rediscover it.** §21.4 requires a mood *or* a
reason to be recorded before a purchase is eligible for hindsight. That makes this a
hindsight pass rather than a second triage — it revisits spending the owner already engaged
with — but it also creates a dependency chain: no mood triage means no worth-it queue,
which means no regret learning, no worthwhile report, and no data for Money Score component
6. An owner who never records moods gets nothing from any of them, and nothing in the app
would explain why. Plan 4 must either surface that dependency to the owner or offer the
widened filter — "ask about all discretionary spending" — as the setting §21.4 gestures at.

---

## 41. Which month a figure lands in: the bank's date, always

Found during Plan 3: `month.ts` bucketed spending, savings and refund subtraction by the
**resolved** date, so an owner's `dateOverride` moved a row into another month, while
`income.ts` bucketed by the **bank's** value date. The two disagreed. A refund whose date
the owner had corrected across a month boundary was therefore excluded from income in its
bank month and subtracted from its category in the override month — money leaving one
month's figures and arriving in another's, with both months looking plausible.

**The rule: every figure is bucketed by the bank's `valueDate`.** Income, spending,
savings, refunds, allocations, and anything a later plan adds. `dateOverride` changes what
the owner sees and how rows sort; it does not change which month a figure belongs to.

**What this rule does not govern.** It is about *which month a figure belongs to*, and
about every **fact about what the bank did** that figure is computed from — amounts and
signs as much as dates. It is not about the owner's **classifications**: the category, and
since §43 the kind, are theirs to correct, and a figure honours both. A classification
moves a row between figures; it cannot move one between months, which is what this rule
protects. It is not about workflow timing or display either. The annotation queues age a purchase by the
**resolved** date deliberately: the question "has enough time passed for hindsight to be
honest?" is better answered by the date the owner says the purchase happened than by one
they have explicitly corrected, and no money moves either way. The same goes for sort
order and for grouping a day's transactions under the day the owner sees them. The moment
a later plan counts those answers **per month** — Money Score component 6 — that counting
is a figure and takes the bank's date like everything else.

Two reasons, and the second is the stronger.

**Consistency within one view.** A month's income and a month's spending must mean the
same "month", or the totals on a single screen describe different windows and nothing on
it reconciles.

**A closed month must stay closed.** If an override moved money between months, then
correcting a date in March would retroactively change February's reported income, its
budget variance, its savings rate — and, once Plan 4 exists, its Money Score. The owner
would have reviewed a month, acted on it, and later found it had quietly changed. An app
whose entire claim is that its figures can be trusted cannot have months that move after
the fact.

**The cost, stated plainly.** An owner who corrects a date because the bank posted a
purchase in the wrong month will see the corrected date everywhere, but the money will
still count in the bank's month. That is the deliberate trade: the ledger reconciles
against the bank, the balance chain and the duplicate key already depend on the bank's
originals (§9.10, §37), and a figure that can be moved by an annotation is a figure no
later analysis can rely on. If this ever needs revisiting, it is a whole-app decision, not
a per-module one.

---

## 42. Ordering, paging, and what is still unbounded

Two consequences of §41 that Plan 3 hit while bounding the transactions list.

**42.1 Rows are ordered and paged by the bank's `valueDate`, and display the owner's
corrected one.** Paging by the corrected date would need an index on
`annotations.dateOverride`, which is a schema change, and §29's two gates are still shut.
It would also split one list across two orderings — the ledger reconciles against the bank
everywhere else, so the list that *is* the ledger should too.

The honest cost: a row whose date the owner corrected across a boundary shows its
corrected date while sitting where its bank date puts it. That will look wrong to someone
who does not know why. Where the two differ, say so on the row rather than leaving the
owner to notice an apparent sorting bug — the editor already explains that the bank's
version is never overwritten, and the list should carry the same honesty in one word.

**42.2 Only the unfiltered browse is bounded.** Search, category, kind, date-range and
amount-ordered views still read every row, because bounding them needs indexes that do not
exist and cannot be added while §29 is shut. That is acceptable for now and it is not
nothing: the unfiltered list is what opens on every visit and re-runs after every save,
which is where the cost was. A filtered view is an explicit act the owner takes
occasionally.

**When the schema next opens, these are the two reasons to open it** — not a feature
anyone asked for, which is exactly why they will otherwise sit unaddressed behind work
that shouts louder.

---

## 43. Facts come from the bank; classifications come from the owner, and a kind correction counts

§41 said every value a figure is computed from takes the bank's version. Applying it
exposed a distinction the rule had not drawn: **a date, an amount and a sign are facts
about what the bank did; a category and a kind are classifications**. The annotation system
exists so the owner can correct classifications, and `categoryId` is deliberately taken
from the owner's correction — the budget would be useless otherwise.

`kind` is a classification too. Plan 3 nonetheless took it from the bank, for consistency
rather than principle: `income.ts` and `month.ts` must agree about which rows are income
and which are spending, or money leaves one figure without arriving in another, and making
both follow the owner's override was a larger change than that plan should make at its end.
It left two honest options — both readers honour the override, or the control is removed
because the app ignores it — and gave the decision to Plan 4, noting that offering a
correction and ignoring it is the one option that is not honest.

**The decision, taken in Plan 4: honour it.** Every figure takes the **resolved** kind.
`kind` is the same species of value as `categoryId`, which is deliberately the owner's,
and the reason §41 exists does not reach it: §41 stops a correction moving money between
**months**, and a kind correction moves no row between months — it moves a row between
**figures**, which is exactly what the owner means when they mark a mis-filed transfer as
internal. The amount, the sign and the date stay the bank's, absolutely.

**The condition that makes it safe, and it is the whole of the implementation.** There is
one function, `treatmentOf(kind, categoryKind)` in `src/analysis/income.ts`. It takes the
resolved kind at its one definition, and all three readers pass that same value:
`income.ts` (the income sum and the refund rule), `src/budget/month.ts` (spending and
savings) and `src/import/refunds.ts` (which links the owner may make). Had one reader
honoured the override while another did not, a euro would be counted twice or counted
nowhere — the defect class §41 was written against. A reader added later asks this function
too, or it is wrong by construction.

**Where the money goes, case by case.** A spend re-kinded to `internal` or `income` leaves
spending and enters nothing. A positive re-kinded to `internal` or `spend` leaves income
and enters nothing: money that arrived can never be spending, because the sign is the
bank's. An arrival re-kinded to `income` enters income, in the bank's month. A row
re-kinded to `roundup` is savings. In every case the row stays in the month the bank dated
it, and no euro is in two figures at once.

**Two consequences worth stating plainly.**

**43.1 Income is money in.** The income sum counts a row only when the bank's amount is
positive. Without that, an owner re-kinding a purchase to `income` would subtract its
amount from income while also taking it out of spending — one correction, two figures
moved, which is precisely what this section exists to prevent. The sign is the bank's, so
it decides which side of the ledger a row can be on and the kind decides only which figure
within that side.

**43.2 A refund link follows the resolved kind too, and goes inert when it stops
matching.** `linkRefund` refuses a purchase the owner has re-kinded out of spending and a
positive they have re-kinded out of income, through the same `treatmentOf`. A link that
was valid when it was made and is later contradicted by a correction behaves exactly as a
link with a deleted leg does: the positive returns to income, nothing is subtracted from
any category, and the `transfers` row is left alone so putting the kind back revives it.

**The one gap left, stated rather than hidden.** `unconfirmedPositives` — the queue
offering payments that might be refunds — finds its candidates through an index read on the
**bank's** kind (§39.4, bounded reads). It therefore misses a row the bank filed otherwise
and the owner re-kinded **to** income, even though the income figure counts it. Linking it
from its own editor still works, because that path asks the resolved kind. Closing the gap
needs an index on `annotations.typeOverride`, and §29 is shut.

**43.3 Two readers outside `treatmentOf` had to follow, and both were in the defect classes
this project treats as worst.** The ruling above was implemented in the three readers that
ask `treatmentOf`. Two places decide the same question without going through it, and
honouring the override in the figures left each of them disagreeing with it:

- **Money counted nowhere: `regretClusters` (`src/learning/regret.ts`).** It gated on the
  **bank's** kind while `worthAnnotating` — the predicate behind the worth-it queue — gates
  on the resolved one. A bank `internal` the owner re-kinded to `spend` was therefore
  offered in the queue, answered by the owner, and dropped from every cluster: the app asked
  a question, got an answer and counted it nowhere. The gate is now the resolved kind, so
  the figure agrees with the queue that asked. Everything else in that module stays the
  bank's, as §41 requires: the amount, the sign and the `valueDate` that gives the weekday
  and the month. The sign is load-bearing, not decoration — `cents` is money OUT, so a bank
  arrival re-kinded to `spend` is excluded by §43.1 rather than entering a cluster as a
  negative. The old test named "uses the bank kind" was a statement of the superseded
  ruling, and was rewritten in place as §45 describes; the reverse case (a bank `spend`
  re-kinded out of spending leaves both the numerator and the denominator) was pinned by
  nothing and now is.
- **Money counted twice: `creditedOutflows` (`src/budget/month.ts`).** A credited round-up
  outflow is registered as counted so that an unpaired bank round-up inflow of the same date
  and amount is not credited for the same movement. The registration asked the **bank's**
  kind, so a spend the owner re-kinded to `roundup` was credited to savings and never
  registered, and the inflow was credited as well: 70 reported for 35 of movement — finding
  B1 of the previous plan arriving through the new path. Registration now asks the same
  classification the crediting decision used, the resolved kind, and keeps the bank kind in
  the test as well: an outflow the bank filed as a round-up can reach the savings branch for
  the other reason (a savings category), and it accounted for its inflow before this fix.
  Which rows are credited is unchanged; only which are registered as already counted. The
  carve-out for a **paired** outflow stays: its counterpart in-leg is already out of the
  pending set, and dropping the carve-out reintroduces an under-credit that cost a round.

Neither fix moved a figure anywhere else, and the round-up pairing itself still reads the
bank kind: it is a statement about two bank events, not a figure.

**43.4 The third direction of the same asymmetry: the pending round-up inflow.** §43.3
found two readers outside `treatmentOf`; there was a third, in `month.ts` itself. The gate
admitting a round-up **inflow** to the pending set — the one that credits savings for a
round-up whose spending-account leg was never imported — asked the **bank's** kind, while
the income sum next to it asked the resolved one. That disagreed in both directions, and
neither case was pinned:

- **Counted twice.** A bank arrival filed as `roundup`, with no `transfers` row, which the
  owner re-kinds to `income`. Income counts it, because income asks the resolved kind; the
  gate still saw the bank's `roundup`, found no credited outflow to account for it, and
  credited savings as well. One movement in two figures, with the savings rate computed off
  money nobody saved.
- **Counted nowhere.** A bank arrival filed as `income` which the owner re-kinds to
  `roundup`. Income drops it, and the bank-kind gate would not admit it, so it was in no
  figure at all — contradicting §43's own case list, which says a row re-kinded to
  `roundup` is savings.

**The gate now asks the resolved kind**, like every other figure. The amount, the sign
(`amountCents > 0`, §43.1) and the date stay the bank's. The round-up **pairing** keeps the
bank kind, for §43.3's reason: it is a statement about two bank events. The two therefore
no longer read the same value, and that is deliberate — crediting is a figure, pairing is
not. What keeps them consistent is the registration rule §43.3 installed:
`creditedOutflows` is keyed on the bank kind **or** the resolved one, so it covers both the
inflows the gate has stopped admitting and the ones it now admits. An inflow that reaches
the pending set only because of a correction is still accounted against its own registered
outflow by the same splice, so a re-kinded arrival whose outflow **was** imported credits
the movement once, not twice.

---

## 44. Real figures reached a public repository, and why the guard that was in place missed them

This document quoted the owner's real balances, real card amounts and real merchant
strings as evidence that its rules had been checked against their actual exports — among
them a savings balance and its movement across the window, two current-account balances,
several named purchases, and a merchant string naming the town they shop in. The
repository is public. The figures were committed on 2026-11-15 and pushed on 2026-11-17,
and were found and removed the same day, before any further push. They are replaced by
synthetic figures throughout (§5), and §14.0 now states the rule they broke.

**The guard that existed did not cover this, and the reason matters more than the
incident.** Git history had already been rewritten twice for this repository: once for the
owner's name and account number, and once more for a checksum-valid fake IBAN that the
first pass had only replaced in the working tree. Both passes searched for **identifiers**
— strings that name the person. Neither looked for **their data**, because an amount is
not an identifier and nothing in the process said to look for one.

Three things follow, and they are the actual content of this section:

1. **A privacy guard built from a list of known-bad strings can only find what someone
   already thought of.** Both earlier rewrites verified exactly the strings they had set
   out to remove, and both reported success honestly. The defect was in the question, not
   the answer. This is the same failure shape as the per-file date-ban lists that missed
   two files during Plan 3 (§42-era rulings): a check that is read as coverage while
   covering only its own enumeration.
2. **Evidence does not require the evidence to be quoted.** Every load-bearing finding in
   §5 survives redaction intact — "all 18 round-up outflows pair exactly, 18/18", "0
   breaks across 49 adjacent row pairs", "ING labels the round-up on both sides". Those
   are the claims the design rests on. The amounts beside them were decoration that
   carried risk, and removing them cost the document nothing.
3. **The review that catches this is a reading, not a regex.** Before anything is pushed to
   a public remote, the question to ask is "does any committed file contain a figure,
   name, or string that came out of the owner's statements?" — asked of the whole
   repository by someone looking at it with the owner's data in mind. §14.0 states the
   rule; this is how it is checked.

The cost of the miss was bounded by luck rather than by process: a repository three hours
old, with no forks and no stars. That is not a mitigation, and it is recorded here so it
is not mistaken for one.

---

## 45. The editor sentence changed with §43, and why that matters more than it looks

While `typeOverride` moved no figure, the Kind control in the transaction editor said so:
"The kind changes how this transaction is shown and whether the mood and worth-it questions
ask about it. It does not change your budget figures." That sentence was honest, and a test
pinned it, which is why the §43 decision could not be made in the readers alone.

It now reads: **the kind decides which figure this transaction counts in — spending,
income, savings, or none of them; changing it changes your budget, in the month the bank
dated it; the amount, the sign and that month stay the bank's.** Three facts in one
sentence, because an owner about to re-file a transaction needs all three: that it counts,
where it counts, and what their correction cannot move.

**The rule this is an instance of.** A control's own description is part of the behaviour.
When a figure changes, the sentence beside the control that changes it is not
documentation to update afterwards — it is the half of the change the owner actually sees,
and it belongs in the same commit and in the same test run. Four tests changed with this
one ruling: the budget's "re-kinding a purchase does not move a closed month", the two
refund tests that asserted "the bank kind decides", and the editor's sentence. Each had
been written as a statement of the old
ruling rather than of a money invariant, and each was rewritten in place with the figure it
used to assert recorded in a comment above it, so the reversal is legible in the diff
instead of looking like a test that was quietly relaxed.
