# Encrypted Backup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build §14.3's encrypted backup: the whole database to one file, AES-GCM 256 under a key derived from an owner passphrase with PBKDF2, restorable through the restore flow that already exists, with the plain export kept beside it.

**Architecture:** Encryption is a wrapper, not a second backup. `exportBundle` still produces the `Bundle`; a new envelope module turns its JSON text into ciphertext and back. On restore, the file is classified **by its content**; an encrypted file is decrypted into exactly the object a plain file parses into, and from there it takes the existing road unchanged — `inspectBundle` (validate, salt rule, dry run), the owner's confirm, then `restoreBundle` (one transaction, clears `analyticsCache`). No restore rule is reimplemented, so none can drift.

**Tech Stack:** React 18.3.1, TypeScript 5.5.4 (`strict`, `noUncheckedIndexedAccess`), Vite 8.3.8, Dexie 4.0.8, Vitest 5.1.0, WebCrypto (`crypto.subtle`). **No new dependency** — the four runtime dependencies (`dexie`, `fflate`, `react`, `react-dom`) stay four.

**Spec:** `docs/superpowers/specs/2026-11-15-personal-finance-intelligence-design.md` — §14.3 (encrypted backup, plain export, restore), §14.4 (nothing leaves the device), §19 (encrypted round-trip and wrong-passphrase tests), §27.2, §27.3, §28, §29.2, §31.3.

**No schema change.** Dexie stays at version 1, `SCHEMA_VERSION` stays 1. Nothing here adds a table, an index, a field or a setting — not even a "has seen the passphrase warning" flag (the warning is shown every time instead; see Task 4).

## Global Constraints

- **No floating point anywhere in `src/`**: no `parseFloat`, `toFixed`, `**`, no decimal literals. `src/sourceRules.test.ts` scans every file. Base64 and byte work is integer shifts and masks only.
- **Never read the clock** outside the allowlist in `src/sourceRules.test.ts`. The new modules read none: `exportedAt` is already stamped inside `exportBundle` (`db/backup.ts` is allowlisted for `new Date()` for exactly that), and the file name's day comes from `today()` in `Settings.tsx`, already allowlisted for `Date.now` "names the backup file with the UTC day". **No allowlist entry is added or reworded.**
- **The passphrase is never stored, logged, put in a URL, or kept past the operation.** No `console.*` in the new modules. Passphrase inputs are uncontrolled, have **no `name` attribute** (a form submitted without script would otherwise serialise them into a GET query string on this origin), are read once at submit, and are cleared in `finally`. It is never in React state. JavaScript cannot zero a string, so the plan promises "no reference kept", not "wiped from memory"; the derived `CryptoKey` is created non-extractable.
- **Nothing is uploaded.** WebCrypto runs locally; no `fetch`, no new `connect-src` (§14.4).
- **What is in clear in the file:** the format marker, the envelope version, the KDF name and iteration count, the cipher name, the salt and the IV. **Nothing else** — not `schemaVersion`, not `exportedAt`, not a table name or row count. The ciphertext length does reveal roughly how big the database is; say so in the README rather than pad.
- **Authenticated encryption, honestly reported.** AES-GCM cannot tell a wrong passphrase from an altered file. Every failure is reported before anything is written, and no message claims to know which of the two happened.
- **Every existing restore rule still applies, by construction**: validate first, dry-run report, nothing written until confirm, merge from a different installation refused (`salt-mismatch`), any restore clears `analyticsCache`. A decrypted bundle reaches them only through `inspectBundle` and `restoreBundle`.
- Owner-facing copy passes `causalWords`, `jargonWords` and `shamingWords` from `src/test/bannedWords.ts` (read from there; **do not create a new list**). No "AES", "PBKDF2", "salt", "IV", "decrypt" or "authentication tag" on screen. Note `shamingWords` bans "should" and `causalWords` bans "because".

## Decisions, each with its reason

1. **File format.** One JSON text document, `format` written first: `{"format":"finance-encrypted","version":1,"kdf":"PBKDF2-SHA-256","iterations":600000,"cipher":"AES-256-GCM","salt":"…","iv":"…","data":"…"}`, binary fields in standard padded base64. JSON text, not a binary blob, because the existing restore path reads files with `FileReader.readAsText` (and jsdom's `Blob` has no `arrayBuffer()` or `text()` — checked), so one reader serves both kinds; base64's third more size is irrelevant at this scale.
2. **The header is authenticated.** The seven header fields, in a fixed order, are encoded by `headerBytes` and passed as AES-GCM `additionalData`, so editing the iteration count, the version or the IV makes opening fail rather than silently changing what is derived.
3. **Version field.** `version: 1`. It changes only for a change the header cannot express (another cipher, KDF or layout). A file with a higher version is refused **before the passphrase is asked for**: asking for a passphrase the app then cannot use would waste the owner's attempt and imply it might work.
4. **PBKDF2-HMAC-SHA-256 at 600 000 iterations**, 16-byte random salt, 12-byte random IV, both fresh per export. 600 000 is the current OWASP figure for this hash; measured under this project's Vitest jsdom setup on this machine it takes about 940 ms per derivation, which an owner pays once per backup and once per restore attempt. **Raising it later** means changing `PBKDF2_ITERATIONS` only: the reader always derives with the count in the file's header, so older files keep opening. `PBKDF2_MIN_ITERATIONS` stays 600 000 forever, and `PBKDF2_MAX_ITERATIONS` (10 000 000) stops a crafted header from hanging the tab for minutes.
5. **Passphrase rules.** At least 12 characters, counted as code points after NFC normalisation; typed twice on export; no strength meter, no composition rules — they reward `Passw0rd!` over four plain words and tell the owner nothing they can act on. One hint line suggests several unrelated words.
6. **Normalisation.** NFC on both paths, so the same characters typed on a different keyboard or system produce the same key. On export a passphrase that **starts or ends with whitespace is refused** (it is almost always a stray space or paste artefact, and invisible). Because no export can contain edge whitespace, the open path **trims** edges, which can never turn a correct passphrase into a wrong one and forgives a pasted trailing newline. `encryptBundle` itself refuses such a passphrase, so the engine cannot write a file the open path would read differently.
7. **The plain export stays**, with its current warning, relabelled "Download plain backup (not encrypted)". The encrypted one becomes the primary button. They are told apart on restore **by content**: a parsed object whose `format` is `finance-encrypted` is encrypted; everything else that parses takes today's route unchanged. The file name is never read.
8. **Large databases: one-shot encryption.** A personal database is a few thousand rows a year — single-digit megabytes of JSON after many years. The plain export already holds the whole JSON string in memory, so encryption adds a constant factor (plaintext, ciphertext, base64) rather than a new limit, and WebCrypto's AES-GCM bound is far above it. Streaming would need a chunked format and a new dependency or hand-rolled framing; not worth it. Base64 is built in chunks so `String.fromCharCode` never sees a huge argument list. No compression: `fflate` is available but the gain does not justify a second transform to get wrong.
9. **Test environment.** `crypto.subtle` (`importKey`, `deriveKey` with PBKDF2, AES-GCM `encrypt`/`decrypt`) works under the project's Vitest jsdom environment on Node 24 — the jsdom environment keeps Node's WebCrypto global, and `src/lib/hash.ts` already relies on `crypto.subtle.digest` in tests. A truncated ciphertext rejects with `OperationError`. No polyfill or setup change is needed. Tests use the **real** iteration count (no test-only knob that production code could be called with); tests that derive more than twice set `{ timeout: 20000 }`.

## Review Focus

1. **Wrong passphrase versus a corrupted file.** They are indistinguishable to AES-GCM, so they must produce the same refusal with copy that names both possibilities and claims neither. A message saying "wrong passphrase" for a damaged file sends the owner hunting for a passphrase they never forgot. → Task 2 tests 2 and 3, Task 5 test 3.
2. **A truncated download.** Cut mid-file, the JSON does not parse; today that reads "not a backup from this app", which is false and alarming. A file that **starts** like an encrypted (or plain) backup but does not parse is reported as damaged or incomplete. Cut so that it still parses (a shortened `data` field) it fails authentication. → Task 3 test 2, Task 2 test 4.
3. **An encrypted file from a newer format version** is refused before any passphrase field appears, saying the app needs updating. → Task 2 test 6, Task 5 test 4.
4. **Non-ASCII passphrases and edge spaces.** `ñ` composed and decomposed must open the same file; a trailing space typed on export must be refused, not silently kept. → Task 1 tests 2–4, Task 2 test 7.
5. **Restoring an encrypted backup over existing data.** The decrypted bundle must meet every rule a plain one does: merge from another installation refused, conflicts reported not applied, replace warned about, `analyticsCache` cleared. → Task 3 tests 4–6.
6. **The owner closes the tab mid-restore.** Decryption writes nothing; the write is `restoreBundle`'s single Dexie transaction, which IndexedDB rolls back if the page goes away before it commits; re-seeding is idempotent and retried on the next launch. So "nothing is changed" is true and the copy may say it. → Task 3 test 7, Task 5 test 6.
7. **The passphrase escaping** into storage, a log, the URL or the DOM after the operation. → Task 4 test 5.

---

### Task 1: Passphrase rules and byte encoding

**Files:** Create `src/lib/passphrase.ts`, `src/lib/passphrase.test.ts`, `src/lib/base64.ts`, `src/lib/base64.test.ts`

**Interfaces:**
```ts
// src/lib/passphrase.ts
export const PASSPHRASE_MIN_CHARS = 12
export type PassphraseProblem = 'too-short' | 'edge-space' | 'mismatch'
/** Export only: checks a new passphrase typed twice. Length is code points after NFC; the comparison is after NFC. */
export function newPassphraseProblem(first: string, second: string): PassphraseProblem | null
/** The one place a passphrase becomes bytes: NFC, edges trimmed, UTF-8. Both encrypt and decrypt call it. */
export function passphraseBytes(passphrase: string): Uint8Array
/** Owner-facing sentence for each problem. */
export const PASSPHRASE_MESSAGES: Record<PassphraseProblem, string>

// src/lib/base64.ts
export function bytesToBase64(bytes: Uint8Array): string
/** Strict: standard alphabet, padded, length a multiple of 4. Anything else is null, never a partial decode. */
export function base64ToBytes(text: string): Uint8Array | null
```

- [ ] **Step 1: Write the failing tests**

```ts
it('refuses a passphrase shorter than twelve characters, counting characters rather than bytes', () => {})
it('treats a composed and a decomposed accented letter as the same passphrase', () => {})
it('refuses a new passphrase that starts or ends with a space, and says so plainly', () => {})
it('trims edge whitespace when turning a passphrase into bytes, and nothing inside it', () => {})
it('reports two different typings as a mismatch, and two NFC-equal ones as a match', () => {})
it('words every problem without jargon, shame or a strength score', () => {})
it('round-trips every byte value, and a buffer large enough to overflow a naive fromCharCode', () => {})
it('rejects base64 with a bad character, bad padding or a cut-short length instead of decoding part of it', () => {})
```

Test 1 matters for non-ASCII owners: `ñññññññññññ` is eleven characters and 22 UTF-8 bytes, and a byte count would accept it. Test 4 pins the asymmetry in Decision 6 — trimming on open is safe *only* because export refuses edges, so the two tests together are the contract. Test 8 is what turns a truncated `data` field into a clean refusal rather than a decrypt of garbage.

- [ ] **Step 2: Run the tests and watch each fail for the right reason**

Run: `npx vitest run src/lib/passphrase.test.ts src/lib/base64.test.ts`
Expected: FAIL, "does not provide an export named".

- [ ] **Step 3: Implement both modules.** `String.prototype.normalize('NFC')` (not locale-dependent), `TextEncoder`, `btoa`/`atob` over chunks. Integer arithmetic only.

- [ ] **Step 4: Run the tests and confirm they pass**

- [ ] **Step 5: Mutate each rule and confirm a test that names it reddens** — the minimum (11, and bytes instead of code points); dropping NFC; trimming on create instead of refusing; dropping the trim on open; a lenient base64 decoder. **Verify every mutation reached the file by comparing before and after**, and report the table.

- [ ] **Step 6: Commit**

```bash
git commit -- src/lib/passphrase.ts src/lib/passphrase.test.ts src/lib/base64.ts src/lib/base64.test.ts -m "feat: passphrase rules and strict base64 for the encrypted backup"
```

---

### Task 2: The encrypted envelope

**Files:** Create `src/db/encryptedBackup.ts`, `src/db/encryptedBackup.test.ts`

**Interfaces:**
```ts
export const ENCRYPTED_FORMAT = 'finance-encrypted'
export const ENCRYPTED_VERSION = 1
export const KDF = 'PBKDF2-SHA-256'
export const CIPHER = 'AES-256-GCM'
export const PBKDF2_ITERATIONS = 600_000      // what new files are written with; may rise
export const PBKDF2_MIN_ITERATIONS = 600_000  // never raised: older files must keep opening
export const PBKDF2_MAX_ITERATIONS = 10_000_000
export const SALT_BYTES = 16
export const IV_BYTES = 12
/** Exactly the keys a file may carry, in the order they are written. */
export const ENVELOPE_KEYS = ['format', 'version', 'kdf', 'iterations', 'cipher', 'salt', 'iv', 'data'] as const

export type EnvelopeHeader = {
  format: typeof ENCRYPTED_FORMAT; version: number; kdf: typeof KDF; iterations: number
  cipher: typeof CIPHER; salt: string; iv: string
}
export type Envelope = EnvelopeHeader & { data: string }

/** The header in a fixed order, as AES-GCM additional data: altering any header field makes opening fail. */
export function headerBytes(h: EnvelopeHeader): Uint8Array
/** Whole-file text. Throws if `newPassphraseProblem(p, p)` is not null, so no file can need a passphrase the open path reads differently. */
export async function encryptBundle(bundle: Bundle, passphrase: string): Promise<string>
export type EnvelopeCheck =
  | { ok: true; envelope: Envelope }
  | { ok: false; reason: 'newer-format' | 'malformed'; detail: string }
/** Structure only, no crypto: version, known kdf/cipher, iterations in bounds, salt and iv the right decoded length. */
export function checkEnvelope(parsed: unknown): EnvelopeCheck
export type Opened = { ok: true; bundle: unknown } | { ok: false; reason: 'cannot-open'; detail: string }
/** Derives with the header's own iteration count. Touches no database. */
export async function decryptEnvelope(envelope: Envelope, passphrase: string): Promise<Opened>
```

- Consumes: `Bundle` from `src/db/backup.ts`; Task 1's `passphraseBytes`, `newPassphraseProblem`, `bytesToBase64`, `base64ToBytes`.
- Plaintext is `JSON.stringify(bundle)`; the decrypted value is `JSON.parse` of it and is returned as `unknown` — validation is `inspectBundle`'s job, not this module's.

- [ ] **Step 1: Write the failing tests**

```ts
it('round-trips an exported database through encrypt and decrypt, every table identical', () => {})
it('refuses a wrong passphrase with cannot-open, before anything is written', () => {})
it('refuses a file with one ciphertext byte flipped with the same reason and the same words', () => {})
it('refuses a data field cut short, even though the file still parses', () => {})
it('refuses a file whose iteration count or iv was edited, since the header is authenticated', () => {})
it('refuses a newer envelope version as newer-format without deriving a key', () => {})
it('opens a file with a passphrase typed in decomposed form and a trailing space', () => {})
it('writes no financial data in clear: only the eight envelope keys, and none of the seeded figures or names', () => {})
it('uses a fresh salt and iv for every export', () => {})
it('opens a file written with a higher iteration count, and refuses one outside the bounds before deriving', () => {})
```

Tests 2 and 3 are Review Focus 1: assert their `detail` strings are **equal**, so no later edit can make the copy guess. Test 8 seeds rows with synthetic, distinctive merchant text and amounts (never real ones — §14.0) and asserts the file text contains none of them, nor `schemaVersion`, `exportedAt` or any table name, and that `Object.keys` of the parsed file equals `ENVELOPE_KEYS`. Test 10 builds a header at 700 000 to prove the reader follows the header (Decision 4), and at `PBKDF2_MAX_ITERATIONS + 1` to prove the bound — spy on `crypto.subtle.deriveKey` and assert it was **not** called for the out-of-bounds and newer-format files.

- [ ] **Step 2: Run the tests and watch each fail for the right reason**

Run: `npx vitest run src/db/encryptedBackup.test.ts`
Expected: FAIL, "does not provide an export named".

- [ ] **Step 3: Implement `src/db/encryptedBackup.ts`.** `importKey('raw', …, 'PBKDF2', false, ['deriveKey'])`, `deriveKey` to `{ name: 'AES-GCM', length: 256 }` non-extractable, `encrypt`/`decrypt` with `additionalData: headerBytes(h)`. Any rejection from `decrypt` becomes `cannot-open`; never inspect the error's text.

- [ ] **Step 4: Run the tests and confirm they pass**

- [ ] **Step 5: Mutate each rule** — drop `additionalData`; reuse a fixed IV; derive with `PBKDF2_ITERATIONS` instead of the header's count; remove the upper bound; give tampering a different message than a wrong passphrase. Verify each mutation applied, report the table.

- [ ] **Step 6: Commit** `feat: the encrypted backup envelope, AES-GCM under a PBKDF2 key`.

---

### Task 3: Reading a backup file by its content, through the existing restore rules

**Files:** Create `src/db/backupFile.ts`, `src/db/backupFile.test.ts`. Modify `src/db/backup.ts` (the `RefusedReason` union only).

**Interfaces:**
```ts
// src/db/backup.ts — two members added, nothing else changes
export type RefusedReason = 'format' | 'newer-schema' | 'older-schema' | 'malformed' | 'write-failed'
  | 'salt-mismatch' | 'conflict' | 'cannot-open' | 'newer-format'

// src/db/backupFile.ts
export type BackupFile =
  | { kind: 'plain'; bundle: unknown }        // anything that parses and is not encrypted: today's route, unchanged
  | { kind: 'encrypted'; envelope: Envelope } // ask for the passphrase
  | { kind: 'refused'; report: RestoreReport }
/** Classifies by content only. A file that starts like one of ours but does not parse is "damaged or incomplete". */
export function readBackupFile(text: string): BackupFile
export async function openEncryptedBackup(envelope: Envelope, passphrase: string):
  Promise<{ ok: true; bundle: unknown } | { ok: false; report: RestoreReport }>
```

- Consumes: `RestoreReport`, `inspectBundle`, `restoreBundle` from `src/db/backup.ts`; `checkEnvelope`, `decryptEnvelope` from Task 2.
- The "starts like ours" test is a regex over the text's start for `"format"` followed by `"finance-encrypted"` or `"finance-export"` (both writers put `format` first; the plain one pretty-prints, so allow whitespace). It is content, and it never reads a file name.

- [ ] **Step 1: Write the failing tests**

```ts
it('routes a file by its content, whatever it is named', () => {})
it('reports a cut-short encrypted or plain backup as damaged or incomplete, not as a stranger file', () => {})
it('keeps today\'s refusal for JSON that is not a backup at all', () => {})
it('refuses to merge a decrypted backup from another installation, and writes nothing', () => {})
it('reports conflicts in a decrypted merge exactly as for the same bundle in plain', () => {})
it('clears analyticsCache when a decrypted backup is restored', () => {})
it('touches no database until the passphrase has opened the file', () => {})
it('restores an encrypted backup onto a fresh install with replace, salt and every table intact', () => {})
```

Test 2 is Review Focus 2: slice a real file in half and assert the refusal neither says "not a backup" nor claims which half is missing. Tests 4–6 are the reason this plan wraps rather than duplicates: for each, run the **same** bundle plain and encrypted and assert the two `RestoreReport`s are deep-equal — a decrypted path that skipped one rule would differ. Test 7 spies on `db.transaction` and the table methods during `openEncryptedBackup` with a wrong and a right passphrase, and asserts no call; with Task 2 test 2 and the existing atomicity tests in `src/db/backup.test.ts`, it is the evidence for Review Focus 6.

- [ ] **Step 2: Run the tests and watch each fail for the right reason**

Run: `npx vitest run src/db/backupFile.test.ts src/db/backup.test.ts`
Expected: the new file FAILs on missing exports; `backup.test.ts` still passes.

- [ ] **Step 3: Implement.** `readBackupFile` → `JSON.parse` → `format === ENCRYPTED_FORMAT` ? `checkEnvelope` : plain. Refusal `detail` strings are owner sentences ending "Nothing was changed."; for `cannot-open` it says the passphrase may differ from the one used **or** the file may have changed or been damaged since, and that the app cannot tell which.

- [ ] **Step 4: Run the whole suite** (`npx vitest run`); `src/db/backup.test.ts` and `src/sourceRules.test.ts` must stay green untouched.

- [ ] **Step 5: Mutate** — detect by `.json` name instead of content; skip `inspectBundle` for decrypted bundles; drop the "starts like ours" check. Verify, report.

- [ ] **Step 6: Commit** `feat: restore reads a backup by its content and opens encrypted ones`.

---

### Task 4: Settings — the encrypted download

**Files:** Modify `src/ui/screens/Settings.tsx`, `src/ui/screens/Settings.test.tsx`

**Interfaces:**
- Consumes: `exportBundle`, `encryptBundle`, `newPassphraseProblem`, `PASSPHRASE_MESSAGES`, `PASSPHRASE_MIN_CHARS`; the existing `today()` and `REVOKE_DELAY_MS`.
- A new `EncryptedBackup` component inside `Settings.tsx`, beside `Accounts` and `RebuildFigures`. File name `finance-backup-${today()}-encrypted.json`. `type="password"`, no `name`, `autoComplete="new-password"` (an owner's own password manager may offer to keep it; the app does not).

**Copy, above the fields, every time** (§14.3 "said before the first backup"; showing it always needs no stored flag): the backup opens only with the passphrase chosen now; the app does not keep it and cannot recover it; if it is forgotten, nobody — not the owner, not the app — can open that backup. The existing "not encrypted" storage note stays and gains one clause naming the encrypted option. The plain button keeps its warning and is relabelled.

- [ ] **Step 1: Write the failing tests**

```ts
it('says before any download that a forgotten passphrase means nobody can open the backup', () => {})
it('asks for the passphrase twice and downloads nothing until both match and are long enough', () => {})
it('downloads an encrypted file that opens with the passphrase and restores to the same data', () => {})
it('still offers the plain backup, labelled as not encrypted, with its warning', () => {})
it('leaves no trace of the passphrase in storage, the URL, the console or the fields afterwards', () => {})
it('keeps focus and is not left busy when encryption fails', () => {})
it('uses no causal, shaming or jargon wording in the new copy', () => {})
```

Test 3 reads the downloaded blob back with the file's existing `FileReader` helper (jsdom's `Blob` has no `text()`), opens it with `openEncryptedBackup`, and compares. Test 5 is Review Focus 7: after a download, both fields are empty and neither has a `name`; every Dexie table, `localStorage` and `sessionStorage` is dumped and searched for the passphrase; `location.href` does not contain it; and `console.log/info/warn/error` spies saw it in no argument.

- [ ] **Steps 2–6 as Task 1**, mutating: no confirm field; the field kept in state; a `name` attribute added; the warning shown only once. Commit `feat: download an encrypted backup from Settings`.

---

### Task 5: Settings — restoring from an encrypted backup

**Files:** Modify `src/ui/screens/Settings.tsx`, `src/ui/screens/Settings.test.tsx`

**Interfaces:**
- Consumes: `readBackupFile`, `openEncryptedBackup`; the existing `inspectBundle`, `restoreBundle`, `Preview`, `Refusal`, `pickSeq` and `reset`.
- `onPick` replaces its bare `JSON.parse` with `readBackupFile`. An `encrypted` result shows one passphrase field (`autoComplete="current-password"`, no `name`) and an "Open backup" button; success hands the bundle to `inspectBundle(bundle, mode)` and the **existing** preview, so confirm, cancel, the conflict lists and the replace warning are reused as they are. The `Preview` holds the decrypted bundle, never the passphrase, so confirming needs no second entry.
- The pick-sequence guard covers the decrypt too: a slow open must not overwrite a newer pick. Changing the mode calls `reset()`, which discards the opened bundle — the owner types the passphrase again, which is the existing "a preview is pinned to its mode" rule.
- `accept` gains nothing: the encrypted file is `.json`.

- [ ] **Step 1: Write the failing tests**

```ts
it('asks for a passphrase for an encrypted file, and shows the dry run once it opens', () => {})
it('writes nothing until confirm, exactly as for a plain file', () => {})
it('shows one message for a wrong passphrase or a damaged file, claims neither, and lets the owner try again', () => {})
it('asks for no passphrase for a file from a newer version, and says to update the app', () => {})
it('refuses a merge of an encrypted backup from another installation, and points to replace', () => {})
it('says that closing the page before it finishes changes nothing', () => {})
it('discards an opened backup when the mode changes, so a merge preview never confirms a replace', () => {})
it('keeps focus on the passphrase field after a failed attempt, and clears it', () => {})
```

Test 3 asserts the rendered text matches neither "wrong passphrase" nor "corrupt" on its own, and that the field is usable again without re-picking the file. Test 6 is the owner-facing half of Review Focus 6: the line sits beside the confirm button, and it is true only because Task 3 test 7 and the existing atomicity tests hold.

- [ ] **Steps 2–6 as Task 1**, mutating: decrypting on pick with an empty passphrase; keeping the passphrase in the preview; dropping the sequence guard around the open. Commit `feat: restore an encrypted backup through the existing dry run`.

---

### Task 6: README and the closing checks

**Files:** Modify `README.md`.

- Replace "Encrypted backup is not built yet. Only the plain export exists." with: what the encrypted backup is, that the passphrase cannot be recovered by anyone, that restore recognises either kind from the file itself, what the file shows in clear (that it is an encrypted backup from this app, the settings needed to open it, and roughly how large it is), and that the plain backup is still there for reading the data elsewhere.
- No figure, merchant or date from the owner's statements anywhere (§14.0); examples are synthetic.

- [ ] **Step 1: Run the whole suite and the build** — `npx vitest run`, `npm run build`. `src/sourceRules.test.ts` passes with **no allowlist edit**; `git diff package.json package-lock.json` is empty; `grep -rn "version(" src/db/db.ts` still shows only `this.version(1)`.
- [ ] **Step 2: Manual check in the production build** (`npm run preview`): take an encrypted backup, read the file in a text editor and confirm only the eight keys are visible, restore it with replace into a cleared site, then cut the file in half and confirm the "damaged or incomplete" message.
- [ ] **Step 3: Commit** `docs: the encrypted backup in the README`.

---

## Self-review, run before dispatch

1. **Spec coverage.** §14.3's encrypted backup (whole database, one file, AES-GCM 256, PBKDF2 with random salt and IV, unrecoverable passphrase said before the backup) → Tasks 2 and 4; plain export kept → Task 4; restore with schema check, dry run and merge/replace → reused, Tasks 3 and 5; §19's encrypted round-trip and wrong-passphrase tests → Task 2 tests 1–2, Task 4 test 3. §27.2, §27.3, §28 and §31.3 are reached through `inspectBundle`/`restoreBundle`, and Task 3 tests 4–6 prove the encrypted path meets them identically. §14.3's backup reminders and deletion controls are **out of scope**.
2. **No schema change, no new dependency, no new clock read.** Nothing touches `src/db/db.ts`, `src/db/migrations.ts`, `package.json` or the `sourceRules` allowlists; Task 6 step 1 checks all three.
3. **Names verified against the tree.** I grepped for every existing name this plan uses and each exists as stated: `exportBundle`, `inspectBundle`, `restoreBundle`, `Bundle`, `RestoreReport`, `RefusedReason` (currently seven members) in `src/db/backup.ts`; `seedDatabase` in `src/db/seed.ts`; `SCHEMA_VERSION` in `src/db/migrations.ts` and `this.version(1)` in `src/db/db.ts`; `today()`, `REVOKE_DELAY_MS`, `Preview`, `Refusal`, `pickSeq`, `reset`, `readText` and the `accept="application/json,.json"` input in `src/ui/screens/Settings.tsx`; the `FileReader` helper and `fileOf`/`pick` in `src/ui/screens/Settings.test.tsx`; `causalWords`, `jargonWords`, `shamingWords` in `src/test/bannedWords.ts`; the `db/backup.ts` `new Date()` and `ui/screens/Settings.tsx` `Date.now` allowlist entries in `src/sourceRules.test.ts`; `crypto.subtle` already used by `src/lib/hash.ts`; the README line Task 6 replaces. `src/lib/passphrase.ts`, `src/lib/base64.ts`, `src/db/encryptedBackup.ts` and `src/db/backupFile.ts` do not exist yet.
4. **The WebCrypto claim was checked, not assumed.** A throwaway Vitest file run under `--environment jsdom` outside the repo derived a PBKDF2 key at 600 000 iterations (~940 ms), round-tripped AES-GCM with additional data, and saw `OperationError` on a truncated ciphertext; it also showed jsdom's `Blob`/`File` lack `arrayBuffer()`/`text()`, which is why Decision 1 keeps the file as text.
5. **Type consistency.** `Envelope` is defined once (Task 2) and consumed by Tasks 3 and 5; `RefusedReason` gains exactly `cannot-open` and `newer-format`, used only by Task 3; the passphrase becomes bytes in exactly one function, `passphraseBytes`.
6. **Proportion.** Six tasks, exact signatures and constants, named tests, no function bodies. Every Review Focus item has an owning task and test.
