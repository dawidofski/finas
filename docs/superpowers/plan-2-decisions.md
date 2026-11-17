# Decisions made on your behalf — Plan 2

Every call I made during Plan 2 that you did not explicitly authorise, with what
it costs if it is wrong. Fifty-three of them. Nothing here is hidden in a commit
message or a scratch file.

Two patterns are worth naming before the list.

**Nineteen of these are corrections to my own specification**, not to anyone's
implementation. Almost every one was found by someone reading my rules rather
than by me re-reading them — an implementer who hit a case I had not thought of,
or a reviewer who checked my claim against your actual bank files and found it
false.

**Eleven are acceptances of work built better than I specified.** When an
implementer departed from my instruction and was right, the fix was to the
instruction.

---

## 1. Decisions that change what the app does

| # | Decision | Cost if wrong |
|---|---|---|
| R3 | **"Edited" means any owner-authored field is set**, not just a category. A note or a mood marks a row as edited too. | Low. A row looks touched when you only added a note. |
| R4 | **Confirming the app's guess is recorded as a confirmation**, not silently ignored. The learning engine needs to know you agreed. | Medium. Without it the engine cannot distinguish "right" from "never looked at". |
| R15 | **The duplicate key drops the description entirely** — date, amount and balance alone identify a transaction. Verified unique across all 100 rows of both your exports. | High if wrong, but measured rather than assumed. A collision would silently skip a real transaction. |
| R16 | **`O'BRIEN` scrubs to `O'[redacted]`**, leaving one letter. Fixing it would mean treating apostrophes as word characters everywhere, which breaks more than it fixes. | Low. One initial survives on names with an apostrophe. |
| R21 | **A file containing the same row twice holds the second copy for review** rather than importing or silently dropping it. | Low. You see a row you must look at instead of a silent decision. |
| R24 | **Gap detection judges by ledger arithmetic, not calendar distance.** Two statements four days apart with a quiet weekend between them read as complete. | High — this is the "your history is complete when it isn't" risk. It now reports a hole only when the balances disagree. |
| R26 | **"Cannot verify" is a distinct verdict from "complete".** When no stored row exists to check a join against, the app says so and names the span to re-export. | Low, in the safe direction: it may ask you to re-export when nothing is missing. |
| R28 | **A round-up's parent is resolved by the balance chain, not flagged as ambiguous.** Your file has two identical €23.20 purchases with two identical €1.60 round-ups on one day; the chain settles which belongs to which. | Medium. A round-up credited to the wrong purchase misstates that merchant's total. |
| R30 | **Match scores are exact**: same-day 100, then 90/80/70 within three days, nothing beyond. | Low. Affects which of two candidate pairs wins. |
| R31 | **A transaction can belong to at most one transfer**, and a leg already linked is never offered again. | High. Without it, re-importing an overlapping file would double your recorded savings. |
| R32/R36 | **Round-ups pair only with round-ups naming the same purchase on the same day.** The parent phrase is a matching key, not a label applied afterwards. | High. Two different purchases can round up to the same amount. |
| R33 | **The ×2 round-up identity may corroborate a match, never create one**, because the multiplier is a setting you can change in ING. | Low. Loses a confirmation signal if ING changes it. |
| R34 | **"No parent in this file" is distinct from "ambiguous"** — the savings-side inflow has its purchase in the other account, which is normal, not a question for you. | Low. Without it you would be asked about rows that are not ambiguous. |
| R37 | **The preview writes nothing at all**, including no settings row. Previewing a file on a fresh install touches nothing. | None. It is the property the screen exists to provide. |
| R38 | **An ambiguous round-up links to nothing** rather than guessing a parent. | Low, and in the honest direction. |
| R41 | **The stored filename is redacted** by the same rule the account table uses, so a file you renamed to include your account number cannot carry it into the database. ING's own `movements-15112026.xls` date stamp is left alone. | Low. An 8-to-11-digit fragment in a renamed file would survive; no Spanish account number is that short. |
| R42 | **A file whose dates overlap your history but which shares no row with it is refused**, not merely flagged. It probably belongs to a different balance chain. | Low. One extra confirmation in a case that should not happen. |
| R45 | **An auto-created category whose rows are all credits defaults to income**, not to discretionary spending. Your exports contain no income category, so your first salary would otherwise have been filed as discretionary. | Low, and flagged for your review either way. |
| R46 | **One save writes one patch**, so a multi-field correction is one atomic record rather than several. | Low. |
| R47 | **Deleted rows must be findable in the UI.** The importer refuses to resurrect a row you deleted, so this screen is the only way back. | High. Without it, one mistaken delete is permanent. |
| R50 | **Thousands are always grouped**: `1.850,00 €`, not `1850,00 €`. Spanish convention omits the separator below five digits; a column of money needs consistent punctuation, and your bank groups them. | Low. Spanish prose convention would write the four-digit form without a separator. |
| R51 | **The Subcategory control is removed.** Your categories are two levels and the app stores the specific one, so a subcategory of a subcategory was always empty and always disabled. | Low. The field remains in the database, unused, until a schema change is safe. |

## 2. Corrections to my own specification

Found during implementation, mostly by someone reading my rules rather than by me
re-reading them.

| # | What I got wrong | How it was wrong |
|---|---|---|
| R2 | A learning event recorded the *stored* previous value. | When the app had inferred a category and you changed it, the event would have said the previous value was "none". The engine would have learned from a fiction. |
| R6 | The same event recorded the new value asymmetrically. | The two halves of one record used different rules, so the pair could not be compared. |
| R8 | Nothing stopped two categories claiming the same ING pair. | A lookup that runs on every screen throws when that happens. See R35 — it took two attempts to close properly. |
| R14 | The scrub was not canonical: different spellings of your name produced different output. | Two statements could have scrubbed the same description differently, which would then compare as different transactions. |
| R17 | My plan and my spec disagreed about the duplicate key. | Task 5 would have implemented whichever it read first. |
| R18 | Only the description was scrubbed. | `COMENTARIO` is a free-text field you can type into. It is now scrubbed too. |
| R19 | Any all-digit cell was read as an Excel date serial. | A compact date like `20261115` would have become a date in the year 56,000. |
| R20 | Column titles were compared byte-for-byte. | A trailing space in ING's export would have rejected your whole statement. |
| R24 | Gap detection branched on calendar adjacency. | It would have told you data was missing every time you spent nothing over a weekend. |
| R25 | Two fields were named for the missing days; they hold the seam dates. | Someone would eventually have "fixed" them into the wrong thing. |
| R35/R27 | The "is this pair already claimed?" check ran before the transaction, not inside it. | Two tabs importing the same new category would have left the app throwing on every screen, permanently. |
| R36 | I described the round-up parent phrase as a label rather than a match key. | The implementer built what I described, and round-ups could pair with unrelated transfers. |
| R40 | I told an implementer to use the existing error codes. | There was no code for "already imported" or "nothing new", so both reported as "empty file". |
| R45 | Every auto-created category defaulted to discretionary. | Your first salary would have been filed as discretionary spending. |
| R49 | Nothing specified that dates and amounts must not wrap. | Found in a real browser: `2026-` / `11-08` across two lines on the screen you use daily. |
| R10 | A regression guard sat after the check it was meant to protect. | It could never have fired. |
| R11 | A size cap of 100 MiB was supposed to prevent the app freezing. | It did not; 8 MiB does. |
| R12 | Two caps on rows and columns were supposed to bound memory. | Their product was unbounded. A cap on the area replaced them. |
| R13 | Rows were allowed to be ragged. | A short row made the balance column `undefined` and nothing noticed. |

## 3. Acceptances — built better than I specified

| # | What I accepted |
|---|---|
| R29 | Pairing reads and returns rows instead of writing them, so the import commit stays atomic and the preview can show what will be linked. |
| R34 | A fourth value distinguishing "no parent here" from "ambiguous". |
| R35 | A query for unmatched transfers, which §9.2 requires and nothing else provided. |
| R42 | Refusing a divergent file at the data layer rather than warning about it on screen — a warning can be forgotten by the UI; a refusal cannot. |
| R43 | Keeping the reload-hold in its own module so a screen does not import the service-worker registration. |
| R44 | Deriving the account id from its fingerprint instead of a random UUID: deterministic, so one account cannot be created twice, and it avoids a privacy guard that rejects about 0.35% of random ids. |
| R45 | The income default, above. |
| — | The implementer's own extra test that a round-up one day apart does not pair. |

## 4. Engineering and process calls

| # | Decision |
|---|---|
| R1 | Task 1 took no separate review seat; it wires an engine already reviewed. |
| R5 | Category events keep an explicit `intent`, with the default documented, because the event record is append-only and cannot be reshaped later. |
| R7 | The engine may never write a category: that path throws by design. |
| R9 | The golden test against your real file was added immediately rather than deferred, and is skipped automatically when the file is absent. |
| R22 | A test spying on a Dexie internal was replaced with one using Dexie's own middleware. |
| R23 | A 3,000-row test that had been silenced with a 30-second timeout was shrunk and restored to the default; it now runs in 83 ms. |
| R39 | The rollback test forces a real key collision rather than a mocked rejection — a mock proves the error path, not that the database rolled back. |
| R48 | The same rule applied to Task 10's 3,000-row test. |
| R53 | I declined a reviewer's suggestion that coverage dates overstate what was stored, and wrote the reasoning into the spec (§39.6) so it is not "fixed" into a bug later. |

## 5. Claims I checked and rejected

- **A reviewer reported that a test fixture's last four digits were your real ones.** They are not. I checked both of your statements directly; neither account ends in those digits, and the two accounts do not share a last4 (R52). Acting on it would have been work justified by a fact nobody verified.
- **An implementer worried the savings-side round-up text might not carry the parent phrase**, which the whole matching key depends on. I checked both exports: it does, on both legs. The rule is safe on real data.
- **A fix agent reported it might have muddled one of my spec commits into its own.** It had not.

## 6. Not verified, and I will not claim otherwise

- **Live deployment.** Still requires you to create the repository and push. The README says so and leaves the URL blank.
- **The service-worker update path.** Judged from code; the in-app browser refuses service-worker registration, so it needs a real deployment.
- **Real-device testing on your Galaxy S26.** I verified the import and transactions screens at 375×812 in a desktop browser — including a full import, commit, delete and restore — which is not the same as your phone.

## 7. Carried into Plan 3

Recorded as §39 of the spec so they are binding rather than remembered: a control
for the `last4` setting and an owner-chosen account label; surfacing round-up
ambiguity; collapsing the transactions filters so the screen opens on your money
rather than on eight controls; a hint that deleted rows exist; and bounding the
list's full load before later plans copy the pattern.
