# Decisions made on your behalf — Plan 3

Every call I made during Plan 3 that you did not explicitly authorise, with what
it costs if it is wrong. Fifty of them. Nothing here is hidden in a commit
message or a scratch file.

Three patterns are worth naming before the list.

**Eleven of these exist because a confident zero is a lie.** Over and over, a
percentage computed against nothing came out as `0` and read on screen as
"exactly on budget" or "saving nothing", when the truth was "there is no budget"
or "no income has landed yet". Every one of those fields is now `number | null`,
and a screen with nothing to say says nothing.

**Seven are the same disease: one rule written down twice.** Two definitions of
"the transactions of a month", two lists of banned date calls, two sort
comparators, two copies of the refund rule. Every single time, one copy got fixed
and the other did not. By the end of the plan the guards had been turned from
denylists — which go stale silently — into whole-tree scans with named allowlists
that fail when one of their entries becomes obsolete.

**Six are gaps I chose to write down rather than fix.** They have their own
section at the bottom. None of them makes a number wrong today; each one is a
reason to open the database schema the next time it opens.

---

## 1. Decisions that change what the app does

| # | Decision | Cost if wrong |
|---|---|---|
| R9 | **A round-up pair nets to zero for income and counts once as savings** — the spending-account leg carries it. Counting both legs would double your saving; counting neither would say you saved nothing while your savings balance grew. | High, and it is why R46 below was treated as urgent. |
| R10 | **A category you spent in without a budget still gets a line**, marked unbudgeted. Otherwise the screen showed lines summing to 300 € under a total of 800 €, with 500 € unexplained. | Low. One more row on the screen. |
| R13 | **The most specific budget wins, and a parent covers only the remainder.** A category singled out for its own budget is pulled *out* of its group's, not counted twice — so every euro is claimed exactly once, by construction. | High if wrong, which is why it is built as an invariant rather than checked afterwards. |
| R18 | **Dates you read are in Spanish format (dd/MM/yyyy), everywhere.** The app had been printing `2026-11-08` since Plan 2. Storage, keys and comparisons stay ISO — that boundary is the whole risk in this change. | Medium. Getting the boundary wrong would break duplicate detection. |
| R20 | **A line for a deleted category stops offering "Plan an amount".** The button showed "Choose…" while holding the deleted id — the screen displayed one thing and would have saved another. | Low. A missing button instead of a lying one. |
| R23 | **A failed read of your mood vocabulary cannot delete an annotation.** On error the list came back empty, the control decided your saved mood was not a valid option, and clearing it was one tap away. A transient database hiccup became lost data, with the interface inviting the tap that lost it. | High, in a rare path. |
| R26 | **A control may only offer to clear a value it is currently able to show you.** No more "Earlier mood" placeholder standing in for a value the app cannot read. | Low. |
| R27 | **The app never asks how your salary felt.** Beyond being faintly absurd, mood on income rows would sit in the mood-versus-spending samples as noise and corrupt what Plans 4 and 5 learn. | Low; reversible. |
| R28 | **The mood queue has a Back button.** A one-tap save that advances with no way back means a mis-tap writes a wrong answer into the permanent record, and later plans read it as real. | Low. |
| R29 | **Rating a whole day is one database transaction** — the rows are chosen and written together, so "nothing was changed" is true by construction, and a bulk write can never land on top of an answer you gave in between. | Medium. |
| R30 | **"Worth it?" is its own screen**, a fourteenth beyond the thirteen you listed. Hindsight about older purchases is a different activity from rating today's, and folding it in would have buried the one flow four later features depend on. | Low; recorded in the spec as a deviation rather than slipped in. |
| R31 | **Both queues share one definition of "worth asking about".** Only the delay is a setting. Separately tunable filters would let the two screens drift until a transaction appeared in one and not the other for no discoverable reason. | Low. You cannot widen the hindsight net from the screen. |
| R32 | **Keyboard focus survives skipping or saving in a queue** — in both queues. The reviewer filed it as a Minor; a queue exists to be worked through rapidly, so a keyboard or switch user lost their place on *every single item*. | Medium for keyboard use, zero otherwise. |
| R33 | **"Not rated" is hidden unless you are revisiting**, instead of looking pressable and silently doing nothing. | Low. |
| R34 | **A refund link applies only while both of its transactions are live.** With the purchase soft-deleted, the refund was taken out of income *and* subtracted from no category — money counted nowhere, the worst defect class in this app. Deleting is reversible and consequence-free again, and restoring reactivates the link exactly. | High. This one was a real hole. |
| R36 | **"Unconfirmed positives" became "Money that arrived this month".** The original list contains your salary every month, forever: a to-do list that can never be emptied teaches people to ignore it, and then it is worse than nothing. | Low. |
| R40 | **The list sorts and pages by the bank's date, and a row whose date you corrected says so in a word.** Sorting by your corrected date needs a database index the schema does not have yet. The cost had to be visible, not merely true — otherwise it reads as a sorting bug to anyone who does not know why. | Low, and now self-explaining. |
| R46 | **A round-up is credited to savings once even when its two legs never paired.** Found by the final review: both legs present but unpaired counted twice — 70 cents of savings for a 35-cent round-up, and an inflated savings rate. Reachable in practice, because ING sometimes words the savings leg without naming the purchase. | High. It was a live double-count, fixed before the deploy. |
| R48 | **Savings counts round-up movements, it does not merely check that one happened.** The first fix for R46 asked whether a matching outflow existed; with two genuine round-ups of the same amount on the same day and only one of them imported, that credited one saving where you had made two. Found by asking the reviewer to hunt for the opposite of the bug it had just confirmed fixed. | Low, and it was in the honest direction — it understated your saving rather than inflating it. Fixed because the savings rate is what the Money Score will read later, so a quietly low figure would be inherited as data instead of found as a bug. |
| R49 | **A round-up that already found its partner cannot stand in for another one.** The remaining under-credit after R48: a matched round-up could be "used up" by an unrelated round-up of the same amount on the same day, hiding the second saving. Fixed because of what your own statements say — 18 of your round-up outflows pair cleanly while 31 round-ups exist on the savings side, so thirteen of them have no spending-side leg in the export, and two such round-ups coinciding on one day is ordinary rather than exotic. | Low in euros, every time. Worth one more round because the measured data says the state occurs. |
| R50 | **One over-credit is documented instead of fixed**: a cross between round-ups across *three* accounts could count one saving twice. You have two accounts. A guard against a state your data cannot produce would be a claim the code cannot honour. | Low. It needs an account you do not have. |
| R47 | **The "Refund" badge and "Money that arrived" now use the same rule the figures use.** A link that was live but had stopped doing anything still badged the row and hid the payment from the list, while income went on counting it. No figure was wrong; the lists contradicted what the editor had just told you. | Low. |

## 2. Decisions about the numbers

| # | Decision | Cost if wrong |
|---|---|---|
| R4 | **A figure is "provisional" whenever it is not an observation of the month itself** — an estimate is not, and neither is a zero standing in for "nothing recorded yet". | Low. Without it, a month with no data would show a budget of zeros labelled definite. |
| R5 | **A refund's two legs are told apart by sign, not by which column they sit in** — the money-in leg is positive by construction, so a row written in the wrong order cannot defeat it. The column convention is still pinned by a test, for every other reader. | Low. |
| R11, R14, R16, R19 | **Four percentages became "no answer" instead of a confident `0`**: budget variance on a line with no budget, and over-commitment and savings rate against an income basis of zero. The same trap, caught four times in four modules. | Medium each. A confident 0 % beside "−250 € unallocated" is the plausible-wrong-number class. |
| R35 | **A refund link is validated against the bank's dates**, not the dates you corrected. A link is a statement about two bank events; an edit must never move money between months. | Medium. |
| R37 | **Every figure in the app buckets by the bank's value date** — now spec §41, together with "a closed month must stay closed". The budget had been bucketing by your corrected date while income bucketed by the bank's, so a refund you re-dated across a month boundary left income in one month and a category in the next. | High. This was a live disagreement between two screens. |
| R45 | **Facts come from the bank; classifications come from you** (spec §43). Amount, sign and date are facts. Category is yours. Kind is a classification too — but taking it from the bank is what keeps money from moving, so today changing Kind changes the lists and changes no figure, and the editor says so plainly. | Named as a gap, not hidden. Plan 4 owns it. |

## 3. Corrections to my own specification and plan

| # | Decision | Cost if wrong |
|---|---|---|
| R1 | The plan never said what shape `saveAllocation` takes. Decided, and carried in the dispatch rather than left to inference. | None. |
| R2 | **The plan returned a field no test asserted.** A field nobody checks is a field nobody is checking. Tests added for its sign and its magnitude. | Low. |
| R3 | **My own plan text contained a syntax error** — an apostrophe inside a single-quoted test name. Caught by the pre-flight scan before any implementer read it. | None. |
| R6 | The shared exclusion set legitimately holds transactions dated *outside* the month you asked for: that is cross-month netting working. Documented, because counting it or intersecting it gives quietly wrong numbers. | Medium if left undocumented. |
| R7, R8 | **A budget may not name a category that does not exist**, and the budget screen must tolerate one deleted afterwards. Two layers, because a check at write time cannot cover a later deletion. | Low. |
| R22 | **I asserted a general rule about the learning log that was false**, and the implementer changed correct code to match my sentence. Reverted: three fields are deliberately untracked, and the code says so on purpose. | Medium. It would have logged events Plans 4 and 5 read as signal. |
| R25, R47 | **Two comments that stated the opposite of the code they sat above** — one in each review wave. This is how the next person re-adds what was just removed. | Low each, individually. |
| R24 | **Unpinned a test that listed the files in a directory.** A test that breaks when unrelated, correct work happens teaches people to edit tests until they pass — the habit this project can least afford, having already found three tests that passed for the wrong reason. | Low. |

## 4. One rule, one place

| # | Decision | Cost if wrong |
|---|---|---|
| R12 | **Extracted "the transactions of a month" into one shared helper** instead of letting a second private copy exist. Two definitions is how one gets a bound fixed and the other does not, and two figures disagree with nobody able to say which is right. | None; it removes a copy. |
| R15, R42, R43 | **The guards against unsafe date and clock calls were per-file lists, and those lists missed a file twice.** A guard that silently stops covering code is worse than no guard, because it is read as coverage. They now scan every file in the project and keep an allowlist that fails when one of its entries goes stale. | High if left. These guards are what keep a transaction's date from shifting by a day depending on where your phone is. |
| R44 | **One sort comparator, used by both the list and the pager.** The two had diverged; a divergence fixed in one of two copies is a divergence waiting to return. | None; it removes a copy. |
| R39 | **A bad account label surfaces the database's own refusal** rather than a second rule saying the same thing in a second place. | Low. |

## 5. Gaps written down rather than fixed

These are the honest edges. None of them makes a figure wrong today.

- **R17: "today" is the UTC date.** Local-timezone date calls are banned
  project-wide, so the "month still running" flag can lag for up to two hours
  after local midnight at a month boundary. Accepted deliberately: the ban exists
  to stop a *transaction's* date shifting by a day depending on where your phone
  is, which is a far worse bug than a two-hour lag on one flag.
- **R21: one hand-typed `0,00 €` replaced with the formatter.** Right today,
  wrong the moment formatting changes.
- **R38: the "what gets stored" disclosure remembers itself per device**, in
  browser storage rather than in the settings row — because the settings row
  travels inside your backup file, and a view preference should not follow you
  between machines.
- **R41: only the unfiltered list is bounded.** Search, category, kind,
  date-range and amount-sorted views still read the whole table, because bounding
  them needs database indexes the schema does not have yet. The unfiltered list is
  the one that opens on every visit and re-runs after every save, which is where
  the cost was.
- **R45: changing Kind changes no figure** (above). The clearest unfinished edge
  in the app, and the editor says so in the one place you could be misled.
- **R40 and R41 together are the reasons to open the database schema** when it
  next opens. Neither is a feature anyone will ask for, which is exactly why they
  would otherwise sit behind work that shouts louder.

---

Two things in Plan 3 cannot be proved by any test in this repository, and both are
named here so they are not mistaken for verified:

- **The GitHub Actions versions.** Five action majors were bumped and the runner
  pinned, to clear the Node deprecation warnings. No test can cover a workflow
  file; the first push either runs green or fails outright, and that run is the
  only confirmation there is.
- **The service worker's update path, and the app on a real phone.** The worker
  was verified installing and activating on the live site. What happens when a
  *new* version is published has not been seen yet, and will not be until the
  second deploy.
