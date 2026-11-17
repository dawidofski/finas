# Decisions made on your behalf — Plan 4

Every call I made during Plan 4 that you did not explicitly authorise, with what
it costs if it is wrong. Thirty-four of them. Nothing here is hidden in a commit
message or a scratch file.

Plan 4 is the learning engine: the app now learns your own categorisation from
your corrections, and every suggestion can say what it rests on.

Three patterns are worth naming before the list.

**The most serious defect was in my plan, not in anyone's code.** The function
that creates a merchant had no caller — so the feature this whole plan exists for
could not run at all. Nine tasks each checked their own module and every one was
right about its module. Nobody owned the wiring between them, and I wrote all
nine interface descriptions without once asking whether every function promised
had someone to call it. That is now a standing check.

**Eleven of these are corrections to my own instructions**, found by whoever read
them. Two tests I specified would have proved nothing. One instruction would have
corrupted every regret total it touched. One contradicted the very ruling it was
implementing. One told an implementer to follow a pattern that would have fixed
only half the bug. I have listed each one rather than quietly fixing it.

**Eight of nine tasks also found a test of their own that pinned nothing** —
usually because something unrelated already forced the expected result. The habit
that caught them: after writing a test, ask what *else* could make it green.

---

## 1. Decisions that change what the app does

| # | Decision | Cost if wrong |
|---|---|---|
| R1 | **Plan 4 is the learning engine alone**, not the dashboard and the statistical battery too. Those three stages together would have been two or three times the size of Plan 3, which took a full day. They become Plan 5, and the remaining features Plan 6. | Low. The plan count grows by one; no work is wasted either way. |
| R3 | **A merchant name is cleaned up by a rule that sometimes guesses wrong** — a three-word shop followed by a country code loses its last word. Accepted because renaming it once fixes it permanently: a wrong guess you can correct beats a cleverer guess you cannot. | Low. Some shops need one manual rename, once. |
| R9 | **The pattern the app remembers is the name *you type*, not the bank's wording** — when your words appear in the bank's text. Otherwise correcting one branch of a shop would leave every other branch to be corrected separately, one town at a time. | Low, and bounded by your own words. |
| R13 | **No minimum length on a name you type.** Real shops often have short single-word names, and no rule separates those from a word so short it would match half your statement. Three things limit the damage: whole-word matching, a more specific shop always winning, and nothing rewriting your history. | Low. Some future rows land on the wrong shop until you rename one. |
| R15 | **Shops are matched on the bank's wording, not on a description you rewrote.** The bank's text is what recurs every month and is what your saved patterns are anchored to; matching on a rewrite would break matching altogether. | Low; it is the behaviour you would expect. |
| R16 | **A category you chose that has since been deleted falls through to a suggestion** rather than leaving the row with nothing. The screen already shows it as removed, so a suggestion beside it is help, and you still confirm it. | Low. |
| R18 | **You accept suggestions one row at a time.** The friction is smaller than it sounds: a row you leave alone still shows ING's own category, so accepting is only needed to override that. A single "accept all" would manufacture agreement for rows you never read, and that agreement is what later plans learn from. | Low. Several clicks when you want many. |
| R19 | **A correction counts toward learning even when the row has no shop attached**, by matching the bank's wording against the patterns you have created. Without this the engine would only ever learn about shops you had named by hand, twice each — the tier meant to learn from you would barely fire. | Low; corrections attribute to a pattern you wrote yourself. |
| R21 | **A "pattern" needs at least two regrets out of at least three answers.** One-out-of-one, one-of-two and one-of-three all rest on a single purchase, which is exactly the false confidence this app is meant not to produce. Groups below the bar are counted and explained, not silently dropped. | Low, in the honest direction. |
| R24 | **Changing a transaction's Kind now changes the figures** — the gap the spec handed to this plan. Kind is a classification, like Category, which was always yours. The safety condition is that income and budget honour it through one shared function, so no euro can be counted twice or nowhere. | High if the two readers ever disagree; that is why there is only one function. |
| R25 | **Relabelling a payment as "income" does not subtract it from your income.** Found beyond anything I asked for: the sign stays the bank's, so money that left the account can never be added to earnings. | High. It would have moved two figures from one correction. |
| R26, R31 | **A round-up you relabel counts once, in one figure.** Two directions were wrong: one landed in both income and savings, the other in neither. | High. Both were live double-counts or losses. |
| R32 | **You can now name the shop behind a transaction** — the wire that was missing, and without which nothing above could happen. | The plan's whole purpose depended on it. |

## 2. Decisions about honesty on screen

| # | Decision | Cost if wrong |
|---|---|---|
| R14 | **Each suggestion carries a confidence you can read**: your own choice 100, your own history 90, the bank's category 80, and a guess never above 70. The order you would expect is visible in the number. | Low; presentational. |
| R21 | **Held-back findings are counted and explained** rather than hidden, so the screen never implies it has nothing when it has something it judged too thin. | Low. |
| R22, R33 | **A number or a reason stated beside a control is part of the behaviour.** The threshold is imported rather than retyped, so the sentence cannot drift from the rule; and a comment that gave a false reason was corrected even though the code was right. | Low each, individually. This is how the next person is misled. |
| R17, R34 | **Merchant examples in this repository are synthetic.** One real shop from your statements survived two earlier redaction passes and is now gone, along with brand names used as examples. | See section 4. |

## 3. Decisions about how the code is built

| # | Decision | Cost if wrong |
|---|---|---|
| R2 | **No database change**, so the two gates the spec put in front of the first schema bump stay off the critical path. What the engine knows is derived from the record of your corrections, not stored as a second copy that could drift from it. | None; it avoids work rather than creating it. |
| R4 | **Confirming a category the app already showed is not a correction.** I nearly overruled this and was wrong: confirming a *guess* already counts, because a guess was never the value in force. | None identified. |
| R5, R8, R29 | **Three orderings and one tally made total**, so no result can depend on the order the database happened to return rows in. This project has been bitten by that repeatedly. | None; it only removes a dependence. |
| R7 | **The clock is passed in, never read inside** the modules that must stay predictable. | Low. |
| R20 | **A change and the caller it forces must be committed together.** My rule to "stage only your own files" left the build red once, because a module and its caller had to move as one. | None now; the rule is fixed. |
| R23 | **One extra read of a small table on one screen is accepted** rather than restructured. | Low. |
| R30 | **Every function a plan promises must have a caller outside its own tests, checked before the plan is dispatched.** This is the check whose absence caused the plan's only Critical finding. | High if skipped again — it is how a feature passes every test and still does nothing. |

## 4. Privacy — the third incomplete list

A real receipt line from your statements — a named international merchant,
repeated twice inside one description — was still in a test file, beside
neighbours I had already made synthetic. **Neither of this morning's two
redaction passes included it, because neither pattern list did.** It was also
quoted in the spec as evidence about description lengths, which means it has been
in the public repository since this morning's push; the measurement it supported
is kept, the string is not. I am not repeating it here either, which is a mistake
I made in the first draft of this very section.

That is the third time my enumeration has been incomplete: the fake IBAN that
survived the first history rewrite, your balances that survived the second, and
now this. The spec already says the check has to be a reading of the whole
repository rather than a regex. Today proved it a third time.

It is gone, along with brand names used as examples and two fixture ids derived
from real chains. Nothing in the repository now contains a merchant string, a
balance or a transaction amount from your statements.

## 5. Gaps written down rather than fixed

- **A row you relabel into a category that counts neither as spending nor income lands in no figure at all.** That is you telling the app the money is not spending — recorded in the spec, not hidden.
- **"Money that arrived" cannot offer a row you relabelled *into* income**, because finding it needs a database index the schema does not have yet.
- **The classifier's confidence is not a calibrated probability.** Naive Bayes is known to be overconfident, which is why it stays silent below 60 and never reports above 70, and why it says "this looks like" rather than asserting.
- **The regret screen reads every annotation**, not every transaction — a real improvement, but if you use the daily mood prompt heavily those two tables grow alike. Worth knowing before the next plan copies the approach.
- **Naming a shop saves immediately**, separately from Save, so Cancel does not undo it. The screen says so.

---

Two things cannot be proved by any test here, and both are named so they are not
mistaken for verified:

- **Nothing in Plan 4 has run in a real browser.** It is verified in a simulated
  one. The Intelligence screen, the naming control and the import preview's
  suggestions have never been seen on a real device.
- **Nothing in Plan 4 is deployed.** The live site still runs the code from this
  morning. Thirteen commits sit on this machine only.
