# Finance

A personal finance app that runs entirely in your browser. It is installable on your phone and works offline.

## Where this stands today

All fourteen screens are real: **Dashboard**, **Import**, **Transactions**, **Budget**, **Goals**, **Recurring**, **Intelligence**, **Learning**, **Money Score**, **Mood**, **Worth it?**, **Reports**, **AI coach** and **Settings**.

**Where things are.** Five destinations are always on screen (a bar at the bottom on a phone): **Dashboard**, **Transactions**, **Budget**, **Intelligence** and **Settings**. The other screens are tabs inside those: Recurring under Transactions; Savings goals under Budget; Score, Advice (the Learning screen) and the Month report under Intelligence; Import a statement under Settings. Purchases waiting for a second look ("Worth it?") appear as a card on the Dashboard when there are any. Mood is recorded on a purchase, from Transactions. The AI coach is the round button that floats on every screen. Longer explanations sit behind a small "i" that opens on a tap. What exists:

- **Import an ING Spain Excel export (`.xlsx`).** Choosing a file shows a preview first, and nothing is written until you press the one import button. The preview lists the new rows, the rows already imported, rows left out and why, and any gap in the dates the account covers. A file is checked for a continuous running balance, the account number and your name are never stored (only a one-way fingerprint and the last four digits of the account number), and the same file or the same movements are never imported twice. PDF and CSV statements are refused with an explanation, and that is permanent — you decided against supporting them, so the Excel export is the only way in.
- **Dashboard.** The first screen: this month's income, spending, savings and what is left over, how that compares with last month, where the spending went, and a line of spending month by month. An income figure that is an estimate is marked as one, and the screen says plainly when there is nothing to show yet and how to begin.
- **Transactions.** Search, filter and sort everything you have imported, 50 rows at a time. Open a row to correct its date, description, amount, category, merchant, kind, payment method or note, or to add a mood, a reason for the purchase and whether it was worth it. Your corrections are kept beside what the bank recorded, which is never overwritten, and each one is logged so the app can learn from it later. A transaction can be deleted and restored. Internal movements between your own accounts are paired up once both accounts are imported, and a payment that was really a refund can be linked to the purchase it returned.
- **Budget.** Set what each spending category (or savings goal) gets, as a share of your income or a fixed amount, and see each month against it: income, what was spent, what is left, essential against discretionary spending, and how much you saved. Every figure belongs to the month the bank dated it, so correcting a date or an amount later never changes a month you have already looked at.
- **Intelligence.** Three things. What the app has learned from your corrections, merchant by merchant. Which groups of purchases you most often marked as not worth it — shown only once at least two of a group's purchases are marked not worth it out of at least three you answered. And **ten questions about your habits**: whether your mood tracks what you spend, whether stress shifts your spending towards wants, whether weekends differ, whether boredom drives impulse buys, whether the reason you gave for a purchase predicts regretting it, whether spending runs high just after payday, whether a pay rise moved your lifestyle, whether mood changes how *often* you buy, and whether spending in a category trades off against saving.

  Each question says what it still needs before it can be answered, and that is the normal state at first. When one can be answered you get the pattern, how much was looked at and over what period, how big the effect is, how sure it is in plain words, what the figure cannot tell you, what it might mean, and something to do about it. Because ten things are being asked at once, each answer is held to a stricter standard than it would be alone — the screen shows the standard it applied and says so. A result can be certain and tiny, so size and certainty are always shown separately, and anything that does not meet the standard is never presented as a finding.
- **Mood** and **Worth it?** Short queues of purchases worth a thought: how did you feel, and, a week or more later, was it worth it. Skipping writes nothing.
- **Backup and restore**, from Settings (see "Back up your data").
- The app shell: navigation, light and dark themes, installation as an app, and offline use.

- **Money Score.** Six parts, each measured against your own history and never against an income level: budget awareness, savings consistency, discretionary share over time, spending review, goal progress, and fewer repeats of purchases you marked not worth it. Every part shows its weight, what it was worked out from and the arithmetic. A part that cannot be measured yet says what it is waiting for and is left out of the sum — it is never counted as zero — and when nothing can be measured there is no number at all. Goal progress is measured once you have a savings goal with something set aside toward it.
- **Learning.** Advice drawn from your own records: a budget line that has passed its figure, small purchases adding up, savings that come in some months and not others, a purchase well above your usual, purchases you marked not worth it, and a larger share going on wants in higher-income months. Each piece shows what was noticed, the purchases behind it, what it means and something you could do, with a short note and optional challenges. You can accept, snooze or reject each one: rejecting hides it for the month, and rejecting the same advice in two different months removes it for good.
- **Goals.** A savings goal is an amount you are putting money toward, with the share of your income you plan to set aside for it and, if you like, a deadline. What counts toward a goal is worked out from what you actually saved each month, shared between your goals by their shares, and the screen shows how. An estimate of when a goal would be reached is given only when there is enough history to base one on, and says what it rests on. A goal can be edited, archived or marked completed; a completed goal stops taking a share.
- **Recurring.** Payments that come back, found from your own transactions: at least three payments to the same payee at a steady interval (the merchant you set, or else the bank description with its numbers left out) — weekly, monthly or quarterly. Each shows what it costs now, what that is per month, when it was last paid and when the next is expected, and a total per month. A price change is shown as one payment whose price changed, not as two. A payment that is late says so, and one that has missed a whole cycle is shown as seemingly stopped and left out of the total. You can confirm a payment, say it is not recurring (it moves to a Hidden list you can bring it back from) or mark it cancelled. **Yearly bills are not found**: the app looks at about fourteen months, which holds at most two payments of a yearly bill, and it needs three.
- **AI coach (optional, off until you add a key).** You can put a question about your money to DeepSeek, an outside AI service, using a key of your own. Before anything is sent, the screen shows the exact text, and it is sent only when you press the send button. What goes is your question, exactly as you typed it, and the totals of up to six completed months (income, spending, saving, what was left over). The app adds no transaction, description, shop, person, account number or note, and there is no option to include them; what you write in the question is up to you. If the request does not get through, the screen says so and lets you copy the same question and totals to paste into DeepSeek's own chat. The reply is shown as DeepSeek's words, not the app's.

There are still no charts — figures are shown as numbers and words, not graphs.

**Verified on the live site:** it loads, the service worker installs and activates, and a new version does reach an already-installed copy — with one caveat worth knowing, because it was observed rather than assumed.

After a deploy, the service worker fetches the new build and replaces the old files in its offline cache. **A tab that is already open keeps running the version it loaded**, so it goes on showing the old screens until it is loaded afresh. Immediately after one deploy, two screens that had just been built still read "Not built yet" in an open tab; the deployed files were correct and a fresh load showed them correctly. Nothing is broken by this — it is how a service worker is meant to behave — but "the update is live" and "the tab in front of you is showing it" are two different statements, and the second needs a reload.

**Not yet verified:** whether DeepSeek accepts a request sent straight from a browser page. That needs a real key and a real request, and neither was used while building this; the tests use a stand-in for the network. If your browser refuses the connection, the copy-and-paste route is there for exactly that. Also not verified: testing on a real phone (yours). Everything else has been exercised either in the test suite or on the live site, but no part of this app has been used on a phone, which is the device it is designed for.

## 1. Put it on GitHub

This is already done: the code is in a GitHub repository, and statements (`.xlsx`, `.pdf`, `.csv`) and export files are ignored by `.gitignore`, so they cannot be pushed by accident. If you ever start again from an empty repository, from this folder:

```
git remote add origin https://github.com/<user>/<repo>.git
git push -u origin main
```

## 2. Pages

Also done: **Settings → Pages → Source** is set to "GitHub Actions". Every push to `main` runs the tests, builds the app, checks the build and deploys it. Watch progress in the repository's **Actions** tab. A fresh fork would need that one setting switched on once.

## 3. Open and install it

The live site is at:

```
https://dawidofski.github.io/finas/
```

To install on Android Chrome: open the address, open the Chrome menu, choose **Add to Home screen** (or **Install app**). Once installed it works offline.

## 4. Back up your data

**Everything lives in this browser, on this device. Nothing is uploaded anywhere.**

- Browser storage is **not encrypted**.
- Clearing site data, a browser cleanup, or losing the device **destroys your history**. There is no copy anywhere else to recover it from.

**Backup works from the app: open Settings.** Nothing is saved anywhere else, so a backup file is the only copy that survives losing this browser's data. Take one before you rely on the app for anything you cannot recreate, and again after you have made corrections you care about.

- **Download encrypted backup** is the one to use. You choose a passphrase of at least 12 characters and type it twice, and the app saves one file, `finance-backup-YYYY-MM-DD-encrypted.json`, containing every table, locked with that passphrase. **The passphrase cannot be recovered by anyone.** The app does not keep it, so if you forget it that backup cannot be opened, by you or by the app. Check that the file arrived where your browser saves downloads.
- What someone holding the encrypted file can see without the passphrase: that it is an encrypted backup from this app, the settings needed to open it, and roughly how large it is. None of your transactions, names, amounts or dates.
- **Download plain backup (not encrypted)** is still there, for reading your data somewhere else. It saves `finance-backup-YYYY-MM-DD.json`, readable by anyone who has the file: keep it somewhere private.
- **Restore** is three steps: choose merge or replace, choose the file, then read the report and confirm. Choosing a file only checks it; nothing is written until you press the confirm button. The report shows, for each table, how many rows are in the backup, how many are new to this device, and how many conflict. It also lists what the check **could not** verify, so "no conflicts" is never a promise it cannot keep. Changing the mode after the check discards the report, so the plan you confirmed is always the plan that runs.
- A file that is not a backup, is damaged, or comes from a newer version of the app is refused, with the reason shown in full and nothing changed.
- **Two restore modes.** *Replace* makes this device match the backup: anything here that is not in the backup is removed. *Merge* only adds rows this device does not have and never overwrites one it already has. If the same transaction has differing annotations in both, merge keeps your local one and lists the conflict rather than choosing for you.
- **Merging a backup from a different installation is refused, on purpose.** Each installation fingerprints your accounts with its own random salt. Two installations therefore describe the same account differently, and merging them would create duplicate accounts that cannot be untangled. To restore such a backup, use **replace**.
- **Restore takes either kind of backup** and tells them apart from the file itself, not its name. For an encrypted one it asks for the passphrase first, then shows the same report and waits for the same confirm. If the file does not open, the app says the passphrase may differ from the one used or the file may have been changed or damaged; it cannot tell which of the two happened. A file that was cut short is reported as damaged or incomplete.

## What stays on your device

Everything, by default: transactions, balances, notes, settings. The app has no analytics and no tracking, and loads no fonts or scripts from a CDN; a build test checks this.

The only outbound request the app can ever make is the optional DeepSeek question on the AI coach screen, which you trigger yourself, with the exact text shown to you first. Without that, the app makes no requests of its own beyond loading itself from the site it is served from. The site's security policy allows connections to its own address and to `api.deepseek.com`, and to nothing else.

**Your DeepSeek key** is something you type in; it is in no source file. It is kept in this browser's storage, which is not encrypted, so anything with access to the device or the browser profile can read it: use a key made only for this app, with a spending limit. It is deliberately **not** written into backup files, so after restoring on another device you type it in again.

## Developer note

During development the database schema was edited in place at version 1 rather than through a migration, which is correct while nothing is released. A browser profile that opened an older development build may therefore show the storage-error screen, which describes it as an unrecognised cause and says not to clear site data. That advice is right for anyone holding real data. Only if you are the developer and the profile holds nothing you need, clearing site data for that origin fixes this one case; the screen says so too.

```
npm test            # unit tests
npm run build       # type-check and build into dist/
npm run verify:dist # checks the built output
npm run preview     # serve the build locally
```
