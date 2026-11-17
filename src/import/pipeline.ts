import { db, digitCount, IBAN_LIKE, LONG_DIGITS } from '../db/db'
import { buildCategoryIndex, type CategoryIndex } from '../db/annotations'
import { suggestCategory, type CategoriserContext, type Suggestion } from '../learning/categorise'
import { categoryMemory } from '../learning/memory'
import { classify, train } from '../learning/bayes'
import { merchantTokens } from '../learning/canonicalise'
import { epochMsToIso, formatSpanishDate } from '../lib/dates'
import { sha256Hex } from '../lib/hash'
import { MAX_FILE_BYTES, readXlsxGrid } from './xlsx'
import { detectFormat, ImportError } from './detect'
import { fingerprintAccount, last4Of, nameTokens, parseHeader, scrubDescription, type ScrubReport } from './scrub'
import { normaliseGrid, verifyBalanceChain, type CandidateRow } from './normalise'
import { classifyRows, REVIEW_REASON_TEXT, type DedupVerdict } from './dedup'
import { analyseGap, coveredRanges, type GapReport } from './coverage'
import { linkRoundups, type RoundupLink } from './pairing'

/**
 * Everything the owner needs to see before anything is written. A preview is a plain value: it holds no account
 * number and no holder name (the header's are discarded inside buildPreview), only what the commit will store.
 */
export interface ImportPreview {
  /** Scrubbed like any free text: a file name can carry the holder's name too. */
  filename: string
  format: 'xlsx'
  fileHash: string
  accountId: string
  accountFingerprint: string
  /** Null when the owner has turned storing the last four digits off (§34.5). */
  last4: string | null
  accountLabel: string
  isNewAccount: boolean
  coverageStart: string
  coverageEnd: string
  /**
   * `suggestion` is the categoriser's answer for a row that would be imported, null for any other row and when nothing
   * has anything to say. It is only ever shown: nothing is written until the owner accepts it and confirms the import.
   */
  rows: Array<{ row: CandidateRow; verdict: DedupVerdict; suggestion: Suggestion | null }>
  roundupLinks: RoundupLink[]
  balance: ReturnType<typeof verifyBalanceChain>
  gap: GapReport
  scrub: ScrubReport
  /** ING category/subcategory pairs in this file that no category maps yet. Commit creates them, flagged for review. */
  unknownPairs: Array<{ ing: string; ingSub: string }>
  /**
   * The file's window overlaps days already imported yet not one of its rows matched a stored one, so it may belong
   * to a different balance chain (P2-R27). The owner must acknowledge it before the commit.
   */
  divergent: boolean
}

/**
 * Redacts what the accounts guard would refuse, by the SAME rules (its regexes are imported, not copied, so the two
 * cannot drift): 12+ unbroken digits, 16+ digits split by spaces or dashes, or an IBAN-shaped run with 10+ digits. A
 * lower threshold would also redact ING's own movements-15112026.xls date stamp on every import.
 */
export function redactAccountNumbers(text: string): string {
  const ibans = text.replace(IBAN_LIKE, (m) => (digitCount(m) >= 10 ? '[redacted]' : m))
  return ibans.replace(new RegExp(LONG_DIGITS.source, 'g'), '[redacted]')
}

/**
 * The categoriser's inputs, read ONCE for a whole import file (never per row): merchants, the memory folded from the
 * learning log, the ING mapping, the leaf categories a suggestion may name, and a classifier trained on the owner's own
 * categorised history.
 *
 * Training reads every annotation the owner gave a category (an index range scan on `categoryId`, so rows without one are
 * never touched) and the bank rows they belong to. That single unbounded pass is sanctioned HERE, at import time, the way
 * `categoryMemory` is sanctioned for its scan of the log. Do not copy it into a screen: §39.4 forbids unbounded reads
 * there. Examples are tokenised from the BANK description, the text that recurs across imports, never from an override.
 *
 * There is no owner tier for a row that is not stored yet, so `ownerCategoryFor` is always silent. Below `MIN_EXAMPLES`
 * the classifier stays silent by itself.
 */
async function buildCategoriserContext(index: CategoryIndex): Promise<CategoriserContext> {
  const merchants = await db.merchants.toArray()
  const [memory, categories, categorised] = await Promise.all([
    categoryMemory(merchants),
    db.categories.toArray(),
    db.annotations.where('categoryId').aboveOrEqual('').toArray(),
  ])
  // Only a leaf may be suggested, because only a leaf classifies: §21.2 assigns essential-versus-discretionary at
  // subcategory level, so a parent groups and carries no classification to suggest. The preview's picker shows leaves
  // only too (Import.tsx filters `parentId !== null`), so this set agrees with what the owner can choose rather than
  // being the sole guard — which is why a suggestion can never name something the picker would refuse to accept.
  const assignable = new Set(categories.filter((c) => c.parentId !== null).map((c) => c.id))
  const history = await db.transactions.bulkGet(categorised.map((a) => a.transactionId))
  const examples = categorised.flatMap((a, i) => {
    const tx = history[i]
    return tx === undefined || tx.deletedAt !== null || a.categoryId === null
      ? []
      : [{ tokens: merchantTokens(tx.description), categoryId: a.categoryId }]
  })
  const model = train(examples)
  return {
    merchants,
    memory,
    ingCategoryFor: (ing, ingSub) => index.get(`${ing} / ${ingSub}`) ?? null,
    classify: (tokens) => classify(tokens, model),
    categoryExists: (id) => assignable.has(id),
    ownerCategoryFor: () => null,
  }
}

/** Says which case it is, so "nothing to import" never reads as a bug. */
function nothingNewMessage(verdicts: DedupVerdict[]): string {
  const known = verdicts.filter((v) => v.kind === 'duplicate').length
  const held = verdicts.filter((v) => v.kind === 'review')
  const reasons = [...new Set(held.map((v) => (v.kind === 'review' ? v.reason : null)))]
  const parts: string[] = []
  if (known > 0) parts.push(`${known} ${known === 1 ? 'row is' : 'rows are'} already in your history`)
  if (held.length > 0) parts.push(`${held.length} ${held.length === 1 ? 'row was' : 'rows were'} left out of this import`)
  const why = reasons.flatMap((r) => (r === null ? [] : [REVIEW_REASON_TEXT[r]])).join(' ')
  return `Nothing new would be imported from this file: ${parts.join(' and ')}.${why ? ` ${why}` : ''} ` +
    'If you expected newer movements, export a wider date range from ING.'
}

/**
 * Detect, size, read, header, fingerprint, account lookup, hash, scrub, normalise, verify, dedup, link, gap.
 *
 * PURE: it writes nothing, so the owner sees what will happen before anything does. That is why it reads the
 * salt with `db.settings.get` rather than `getSettings()` (which creates the row), and why a first-seen account
 * gets an id in the preview but no `accounts` row until commit. Every refusal is an ImportError whose message is
 * written for the owner.
 */
export async function buildPreview(bytes: Uint8Array, filename: string): Promise<ImportPreview> {
  // readXlsxGrid owns the owner-facing wording for empty, oversized, PDF, CSV, legacy .xls and unknown files, so a
  // file that is not a ZIP-based spreadsheet is handed to it purely to be refused.
  if (bytes.length === 0 || bytes.length > MAX_FILE_BYTES || detectFormat(bytes) !== 'xlsx') {
    readXlsxGrid(bytes)
    throw new ImportError('not-a-spreadsheet', 'This file is not an Excel spreadsheet. Export your movements from ING as Excel and choose that file.')
  }

  // Cheapest refusal first: a byte-identical file needs no parsing (§34.4).
  const fileHash = await sha256Hex(bytes)
  const previous = await db.imports.where('fileHash').equals(fileHash).first()
  if (previous) {
    throw new ImportError(
      'already-imported',
      `This exact file was already imported on ${formatSpanishDate(epochMsToIso(previous.importedAt))}, so there is nothing new in it. ` +
        'To add newer movements, export them from ING again and choose that new file.',
    )
  }

  const settings = await db.settings.get('singleton')
  if (!settings) {
    throw new ImportError(
      'unreadable',
      'The app has not finished setting itself up. Open Settings once, then choose this file again.',
    )
  }

  const grid = readXlsxGrid(bytes)
  const header = parseHeader(grid)
  const accountFingerprint = await fingerprintAccount(header.accountNumber, settings.privacy.accountSalt)
  const last4 = settings.privacy.storeLast4 ? last4Of(header.accountNumber) : null
  const tokens = nameTokens(header.holderName)
  // From here the number and the name are never referenced again except through the two derived values above.

  const known = await db.accounts.where('fingerprint').equals(accountFingerprint).first()
  const isNewAccount = known === undefined
  // Derived from the salted fingerprint (deliberately NOT a UUID: a UUID holds a 12-digit run about 0.35% of the time,
  // which the accounts guard refuses, and a derived id also cannot be minted twice for one account): stable for this account, reveals nothing, and short enough that a run of
  // digits can never look like an account number to the accounts guard (which refuses 12+).
  const accountId = known?.id ?? `acc.${accountFingerprint.slice(0, 10)}`
  const accountLabel = known?.label ?? (last4 !== null ? `Cuenta ${last4}` : `Cuenta ${(await db.accounts.count()) + 1}`)

  const { rows, scrub } = await normaliseGrid(grid, tokens, accountId)
  if (rows.length === 0) {
    throw new ImportError('nothing-new', 'This file has no transactions in it, so there is nothing to import.')
  }

  const verdicts = await classifyRows(rows)
  const withVerdicts = rows.map((row, i) => ({ row, verdict: verdicts[i] ?? ({ kind: 'new' } as const) }))
  if (!verdicts.some((v) => v.kind === 'new')) {
    // A coverage range with no transactions behind it is what makes an unverifiable seam reachable (P2-R26), and it
    // has no legitimate cause: a file whose rows are all known is a re-import.
    throw new ImportError('nothing-new', nothingNewMessage(verdicts))
  }

  // Coverage spans EVERY row of the file, including rows held for review, and that is exact (spec §39.6). Each review
  // verdict names a row that already exists in the database: 'deleted' and 'same-slot-different-description' carry
  // the existingId of a stored row, and 'duplicate-within-file' names an earlier row of this file that IS written as
  // new. No review verdict has a day without a stored row behind it, so the span cannot overstate what is held.
  let coverageStart = rows[0]?.valueDate ?? ''
  let coverageEnd = coverageStart
  for (const r of rows) {
    if (r.valueDate < coverageStart) coverageStart = r.valueDate
    if (r.valueDate > coverageEnd) coverageEnd = r.valueDate
  }

  const gap = await analyseGap(accountId, rows)
  // analyseGap argues an overlap needs no seam test because shared rows provably agree. That holds only if a row is
  // really shared, which only this stage can check (P2-R27).
  const overlapsStored = (await coveredRanges(accountId)).some((r) => r.start <= coverageEnd && r.end >= coverageStart)
  const divergent = overlapsStored && !verdicts.some((v) => v.kind === 'duplicate')

  const index = await buildCategoryIndex()
  // Built once, before the row loop. Matching runs on the bank description (`row.description` is the bank's text; an
  // owner's descriptionOverride does not exist yet for a row that is not stored).
  const context = await buildCategoriserContext(index)
  const seen = new Set<string>()
  const unknownPairs: ImportPreview['unknownPairs'] = []
  for (const { row, verdict } of withVerdicts) {
    if (verdict.kind !== 'new' || row.ingCategory === null || row.ingSubcategory === null) continue
    const pair = `${row.ingCategory} / ${row.ingSubcategory}`
    if (index.has(pair) || seen.has(pair)) continue
    seen.add(pair)
    unknownPairs.push({ ing: row.ingCategory, ingSub: row.ingSubcategory })
  }

  return {
    filename: redactAccountNumbers(scrubDescription(filename, tokens)),
    format: 'xlsx',
    fileHash,
    accountId,
    accountFingerprint,
    last4,
    accountLabel,
    isNewAccount,
    coverageStart,
    coverageEnd,
    rows: withVerdicts.map(({ row, verdict }) => ({
      row,
      verdict,
      suggestion: verdict.kind === 'new'
        ? suggestCategory({ ...row, id: '', importId: '', createdAt: 0, deletedAt: null }, context)
        : null,
    })),
    roundupLinks: linkRoundups(rows),
    balance: verifyBalanceChain(rows),
    gap,
    scrub,
    unknownPairs,
    divergent,
  }
}
