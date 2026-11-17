# Finance

A personal finance app that runs entirely in your browser. It is installable on your phone and works offline.

## Where this stands today

Nine of the fourteen screens are real: **Dashboard**, **Import**, **Transactions**, **Budget**, **Intelligence**, **Mood**, **Worth it?**, **Reports** and **Settings**. The other five (Learning, AI coach, Goals, Recurring and Money Score) are still placeholders that say "Not built yet". What exists:

- **Import an ING Spain Excel export (`.xlsx`).** Choosing a file shows a preview first, and nothing is written until you press the one import button. The preview lists the new rows, the rows already imported, rows left out and why, and any gap in the dates the account covers. A file is checked for a continuous running balance, the account number and your name are never stored (only a one-way fingerprint and the last four digits of the account number), and the same file or the same movements are never imported twice. PDF and CSV statements are refused with an explanation.
- **Dashboard.** The first screen: this month's income, spending, savings and what is left over, how that compares with last month, where the spending went, and a line of spending month by month. An income figure that is an estimate is marked as one, and the screen says plainly when there is nothing to show yet and how to begin.
- **Transactions.** Search, filter and sort everything you have imported, 50 rows at a time. Open a row to correct its date, description, amount, category, merchant, kind, payment method or note, or to add a mood, a reason for the purchase and whether it was worth it. Your corrections are kept beside what the bank recorded, which is never overwritten, and each one is logged so the app can learn from it later. A transaction can be deleted and restored. Internal movements between your own accounts are paired up once both accounts are imported, and a payment that was really a refund can be linked to the purchase it returned.
- **Budget.** Set what each spending category (or savings goal) gets, as a share of your income or a fixed amount, and see each month against it: income, what was spent, what is left, essential against discretionary spending, and how much you saved. Every figure belongs to the month the bank dated it, so correcting a date or an amount later never changes a month you have already looked at.
- **Intelligence.** What the app has learned from your corrections, merchant by merchant, and which groups of purchases you most often marked as not worth it. It says plainly when it has learned nothing yet and how much more it needs, and it shows a group only once at least two of its purchases are marked not worth it out of at least three you answered.
- **Mood** and **Worth it?** Short queues of purchases worth a thought: how did you feel, and, a week or more later, was it worth it. Skipping writes nothing.
- **Backup and restore**, from Settings (see "Back up your data").
- The app shell: navigation, light and dark themes, installation as an app, and offline use.

What you **cannot** do yet: see charts, balances or insights, set savings goals or track recurring payments, get recommendations or a Money Score, or use the optional AI coach. Later plans replace the remaining placeholders one screen at a time; those plans are not built.

**Verified on the live site:** it loads, the service worker installs and activates, and a new version does reach an already-installed copy — with one caveat worth knowing, because it was observed rather than assumed.

After a deploy, the service worker fetches the new build and replaces the old files in its offline cache. **A tab that is already open keeps running the version it loaded**, so it goes on showing the old screens until it is loaded afresh. Immediately after one deploy, two screens that had just been built still read "Not built yet" in an open tab; the deployed files were correct and a fresh load showed them correctly. Nothing is broken by this — it is how a service worker is meant to behave — but "the update is live" and "the tab in front of you is showing it" are two different statements, and the second needs a reload.

**Not yet verified:** testing on a real phone (yours). Everything else has been exercised either in the test suite or on the live site, but no part of this app has been used on a phone, which is the device it is designed for.

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

- **Download backup** saves one plain JSON file, `finance-backup-YYYY-MM-DD.json`, containing every table. It is readable, **not encrypted**: keep it somewhere private.
- **Restore** is three steps: choose merge or replace, choose the file, then read the report and confirm. Choosing a file only checks it; nothing is written until you press the confirm button. The report shows, for each table, how many rows are in the backup, how many are new to this device, and how many conflict. It also lists what the check **could not** verify, so "no conflicts" is never a promise it cannot keep. Changing the mode after the check discards the report, so the plan you confirmed is always the plan that runs.
- A file that is not a backup, is damaged, or comes from a newer version of the app is refused, with the reason shown in full and nothing changed.
- **Two restore modes.** *Replace* makes this device match the backup: anything here that is not in the backup is removed. *Merge* only adds rows this device does not have and never overwrites one it already has. If the same transaction has differing annotations in both, merge keeps your local one and lists the conflict rather than choosing for you.
- **Merging a backup from a different installation is refused, on purpose.** Each installation fingerprints your accounts with its own random salt. Two installations therefore describe the same account differently, and merging them would create duplicate accounts that cannot be untangled. To restore such a backup, use **replace**.
- **Encrypted backup is not built yet.** Only the plain export exists.

## What stays on your device

Everything, by default: transactions, balances, notes, settings. The app has no analytics and no tracking, and loads no fonts or scripts from a CDN; a build test checks this.

The only outbound request the app can ever make is an optional DeepSeek call that you trigger and approve yourself. **That feature is not built yet**, so today the app makes no requests of its own beyond loading itself from the site it is served from.

## Developer note

During development the database schema was edited in place at version 1 rather than through a migration, which is correct while nothing is released. A browser profile that opened an older development build may therefore show the storage-error screen, which describes it as an unrecognised cause and says not to clear site data. That advice is right for anyone holding real data. Only if you are the developer and the profile holds nothing you need, clearing site data for that origin fixes this one case; the screen says so too.

```
npm test            # unit tests
npm run build       # type-check and build into dist/
npm run verify:dist # checks the built output
npm run preview     # serve the build locally
```
