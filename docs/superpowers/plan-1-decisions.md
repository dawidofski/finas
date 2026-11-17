# Decisions made on your behalf — Plan 1

Every call I made during Plan 1 that you did not explicitly authorise, with what
it costs if it is wrong. Nothing here is hidden in a commit message or a scratch
file. If any of it is not what you want, each one is individually reversible —
the ones that would be awkward to reverse are marked.

A pattern worth naming up front: **nine of these are corrections to my own
specification**, not to anyone's implementation. Three were guards that had a
hole in the one case I did not think to enumerate, and each was found by someone
other than me.

---

## 1. Decisions that change what the app does

| # | Decision | Cost if wrong |
|---|---|---|
| 1 | **XLSX is the primary import format, PDF the fallback.** Your Excel export has exact numbers and one row per transaction; the PDF needs position-guessing. | Low. The PDF parser is still planned for Plan 5. |
| 2 | **OCR is dropped.** ING always exports a text layer, so a text-less PDF is rejected with "export the Excel file instead" rather than carrying a 15 MB OCR engine. | Low, unless you ever receive a scanned statement — then you would export Excel. |
| 3 | **Income means money arriving from outside your own accounts.** Transfers between your accounts are zero, however large. | High if wrong — every budget figure derives from it. You confirmed the account that receives salary, so this should be right. |
| 4 | **Round-ups count as savings, not spending**, and are paired across accounts so they are never counted twice. | Medium. Verified against both your real exports (18/18 pairs matched). |
| 5 | **Remittances (`Otros gastos / Transferencias`) and taxis default to *discretionary*.** Either could be essential — family support, a commute. | Low. One tap to change, and the change teaches the categoriser. |
| 6 | **Essential-vs-discretionary is assigned per subcategory, never per category.** Your own vet bill proves why: it sits under *Compras*, which is otherwise discretionary. | Medium. Getting it wrong would bias every behavioural finding. |
| 7 | **Categories are two levels** — 9 ING parents, 12 leaves — rather than a flat list of every subcategory you ever spend in. | Low, but awkward to change later once you have edited categories. |
| 8 | **Merging a backup is purely additive: your existing data always wins.** An incoming row is written only where you have nothing. Differences are reported, never applied. | Low risk, high benefit. Previously an old backup could have reverted edited categories, budgets, and recommendations you had already rejected. |
| 9 | **Merging backups from two different installations is refused outright.** Their account fingerprints use different salts and would produce duplicates you could not untangle. Use replace instead. | Low. Refusing costs a click; permitting it costs the data. |
| 10 | **A restore clears the analytics cache**, because a cached summary describes data that is no longer there. | None. It is derived data and recomputes. |
| 11 | **Mood prompts will default to real discretionary spending only** — not round-ups, internal transfers or recurring essentials. At ~8 transactions a day, prompting on all of them is a habit you would abandon. | Low. It is a setting. |
| 12 | **A backup button must exist before the first import lands** (Plan 2, task 1). Statements can be re-imported; your corrections and moods cannot be recreated. | None. It only delays import by one small task. |

## 2. Corrections to my own specification

Found during implementation, mostly by someone reading my rules rather than by me re-reading them.

| # | What I got wrong | How it was wrong |
|---|---|---|
| 13 | The duplicate-detection key read your *corrected* dates and amounts. | Fixing a date could have made a later import create the duplicate the whole design exists to prevent. Now it reads only the bank's original values. |
| 14 | The sub-cent rejection rule accepted `1.234`. | It would have silently accepted sub-cent amounts while the task's own test demanded rejection — a self-contradicting spec. |
| 15 | The same rule then rejected `0.950`. | Valid trailing-zero amounts, which CSV imports carry, would have thrown. |
| 16 | `openDatabase` had three failure reasons, so anything unrecognised reported "corrupt". | A full disk would have told you your financial history was corrupt. Added a fourth, honest reason. |
| 17 | The salt-mismatch guard only fired when both salts were present and *differed*. | A backup with a **missing** salt fell straight through and wiped yours, orphaning every account. |
| 18 | Replace-restore accepted a backup with an empty table list. | It would have deleted your entire database and reported success. |
| 19 | Merge treated your settings as an ordinary overwrite. | An old backup would have silently replaced your theme, privacy choices and API configuration. |
| 20 | CI was pinned to Node 20. | It forbade the only toolchain versions that clear two critical security advisories. |
| 21 | Task 5's seed data was never wired into the app. | Your categories and moods existed only in tests. Every test passed because the tests called the seed themselves. |

## 3. Technical calls

- **Stack:** React + TypeScript + Vite, Dexie over IndexedDB, hash routing, integer cents everywhere. No router, CSS framework or icon package.
- **fflate instead of SheetJS** for reading XLSX: ~8 KB against ~900 KB, and avoids a package with a known advisory. *Cost if wrong: a more focused parser could need work if ING changes its export.*
- **Build-tool majors raised** (Vite 8, Vitest 5, Node 24) to clear two critical and one high advisory. None of it ships in your browser. *Cost if wrong: CI-only; the deployed app is unaffected.*
- **Six remaining advisories accepted** — all low/moderate, build-time only, and the only "fix" npm offers would reintroduce the criticals.
- **A strict Content-Security-Policy** with no `unsafe-inline`, which required moving the theme script to its own file rather than weakening the policy.
- **Your statements are gitignored** and verified uncommittable before any file was ever staged.
- **App icon:** a euro mark in deep teal, deliberately not ING orange — this is your tool, not a bank's. Separate standard and maskable versions, because Android crops the icon and one file cannot be correct for both.
- **Browser storage (`localStorage`) holds one thing:** your theme preference, so the app does not flash the wrong colour on load. No financial data goes near it.

## 4. Open gates — these outlive Plan 1

Two defects that cannot happen today and become real the moment a second database version is registered. **No schema version above 1 may be registered until both are closed** (spec §29), and both are now enforced in code rather than prose:

1. A per-table "introduced in version" registry, so an old backup cannot omit a table that existed at its own version and have replace silently erase it.
2. Restore must migrate older backups or refuse them, rather than writing outdated row shapes that nothing detects.

And four fields Plans 2–5 need that the schema cannot express yet (spec §32) — all addable without a migration, but named now rather than discovered mid-build.

## 5. Not verified, and I will not claim otherwise

- **Live deployment.** Requires you to create the repository and push. The README says so and leaves the URL blank.
- **The service-worker update path.** Judged from code and the plugin's own source; the in-app browser refuses service-worker registration, so it needs a real deployment to confirm.
- **Real-device testing** on your Galaxy S26. I verified layout, routing, themes and focus handling at 390×844 in a desktop browser, which is not the same thing.
