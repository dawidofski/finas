import { db } from '../db/db'
import { writeAnnotation } from '../db/annotations'
import type { AnnotationRow, CategoryRow, ImportRow, TransactionRow } from '../db/schema'
import { fold } from '../lib/text'
import { ImportError } from './detect'
import { pairAcrossAccounts } from './pairing'
import type { ImportPreview } from './pipeline'

export interface CommitOptions {
  /** Required when the preview is `divergent`: the owner has seen the warning and chosen to go on. */
  acknowledgeDivergence?: boolean
}

const slug = (text: string): string =>
  fold(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

/**
 * Leaf categories for ING pairs no category maps yet (§21.2), each under its parent, which is created too when the
 * parent is unseen. They are flagged `needsReview` so the owner decides what they really are. A parent never
 * carries a kind (§21.2); the leaf's kind is a placeholder (income when every row of the pair is a credit,
 * otherwise discretionary) that the review flag marks as unconfirmed.
 */
async function createUnseenCategories(preview: ImportPreview): Promise<void> {
  if (preview.unknownPairs.length === 0) return
  const existing = await db.categories.toArray()
  // §35: whether a pair is already mapped is decided HERE, inside the commit's transaction. The preview's answer
  // was given earlier and may be stale; two leaves claiming one pair make buildCategoryIndex throw on every read.
  const claimed = new Set(existing.flatMap((c) => c.ingMappings))
  for (const { ing, ingSub } of preview.unknownPairs) {
    if (claimed.has(`${ing} / ${ingSub}`)) {
      throw new ImportError(
        'stale-preview',
        'Another import added the category "' + ing + ' / ' + ingSub + '" while you were reviewing this file, so nothing was saved. Choose the file again.',
      )
    }
  }
  const taken = new Set(existing.map((c) => c.id))
  const parents = new Map(existing.filter((c) => c.parentId === null).map((c) => [c.name, c.id]))
  const unique = (base: string): string => {
    let id = base
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
    taken.add(id)
    return id
  }
  const created: CategoryRow[] = []
  // Relies on `unknownPairs` being distinct: buildPreview dedupes them through its `seen` set (pipeline.ts, unknownPairs loop).
  for (const { ing, ingSub } of preview.unknownPairs) {
    let parentId = parents.get(ing)
    if (parentId === undefined) {
      parentId = unique(`cat.group.${slug(ing)}`)
      parents.set(ing, parentId)
      created.push({ id: parentId, name: ing, parentId: null, kind: null, isUserCreated: false, ingMappings: [] })
    }
    // The pair is known to be unclaimed (checked above), so an id collision here is a different pair whose slug
    // matches, and a suffix is right; it must never be used to get past a claimed mapping.
    const amounts = preview.rows
      .filter(({ row, verdict }) => verdict.kind === 'new' && row.ingCategory === ing && row.ingSubcategory === ingSub)
      .map(({ row }) => row.amountCents)
    created.push({
      id: unique(`cat.ing.${slug(ing)}.${slug(ingSub)}`),
      name: ingSub,
      parentId,
      // §38: discretionary, except income when every row of the pair in THIS file is a credit. Known cost: the default
      // depends on which file introduced the pair, so one pair could be born income from one export and discretionary
      // from another. Tolerable only because needsReview is true; do not extend this to a rule the owner never confirms.
      kind: amounts.length > 0 && amounts.every((a) => a > 0) ? 'income' : 'discretionary',
      isUserCreated: false,
      ingMappings: [`${ing} / ${ingSub}`],
      needsReview: true,
    })
  }
  await db.categories.bulkAdd(created)
}

/**
 * Writes one import, entirely or not at all (§34). A single transaction covers the account, the unseen
 * categories, this account's transactions, the round-up parent ids, the cross-account transfer pairs, the
 * `imports` row and the owner's corrections, so any failure leaves the database exactly as it was.
 *
 * `edits` is keyed by index into `preview.rows`. Each is written as an annotation, never into the bank row:
 * `transactions` is immutable after import (§8.1).
 */
export async function commitPreview(
  preview: ImportPreview,
  edits: ReadonlyMap<number, Partial<AnnotationRow>> = new Map(),
  options: CommitOptions = {},
): Promise<ImportRow> {
  const newIndices = preview.rows.flatMap(({ verdict }, i) => (verdict.kind === 'new' ? [i] : []))
  if (newIndices.length === 0) {
    throw new ImportError('nothing-new', 'Nothing new would be imported from this file, so nothing was written.')
  }
  if (preview.divergent && options.acknowledgeDivergence !== true) {
    throw new ImportError(
      'divergent-history',
      'This file overlaps days you have already imported but shares no transaction with them, so it may belong to a different account history. Nothing was written. Review the warning and confirm to go on.',
    )
  }
  for (const index of edits.keys()) {
    if (preview.rows[index]?.verdict.kind !== 'new') {
      throw new ImportError('invalid-correction', 'A correction was entered for a transaction that is not being imported, so nothing was saved. Remove the correction or choose the file again.')
    }
  }

  const importId = `imp.${crypto.randomUUID()}`
  const now = Date.now()
  // Ids are minted up front so a round-up can name its parent in the very row that is inserted: the transaction
  // guard forbids updating `roundupParentId` afterwards.
  const idByIndex = new Map(newIndices.map((i) => [i, crypto.randomUUID()]))

  // A parent may be a row the file shares with the ledger (a duplicate keeps its stored id). A parent that is
  // ambiguous, absent, or waiting on a decision is left null: a guess here would be a wrong link the owner cannot see.
  const parentIdFor = (parentIndex: number | null): string | null => {
    if (parentIndex === null) return null
    const verdict = preview.rows[parentIndex]?.verdict
    if (verdict?.kind === 'new') return idByIndex.get(parentIndex) ?? null
    return verdict?.kind === 'duplicate' ? verdict.existingId : null
  }
  const parentOf = new Map<number, string | null>()
  for (const link of preview.roundupLinks) {
    if (link.basis === 'adjacency' || link.basis === 'unique-amount') parentOf.set(link.roundupIndex, parentIdFor(link.parentIndex))
  }

  const transactions: TransactionRow[] = newIndices.map((i) => {
    const entry = preview.rows[i]
    if (!entry) throw new ImportError('stale-preview', 'This preview is no longer complete, so nothing was saved. Choose the file again.')
    return {
      ...entry.row,
      id: idByIndex.get(i) ?? '',
      accountId: preview.accountId,
      importId,
      roundupParentId: parentOf.get(i) ?? null,
      createdAt: now,
      deletedAt: null,
    }
  })

  const imported: ImportRow = {
    id: importId,
    filename: preview.filename,
    format: preview.format,
    fileHash: preview.fileHash,
    accountId: preview.accountId,
    importedAt: now,
    coverageStart: preview.coverageStart,
    coverageEnd: preview.coverageEnd,
    rowsDetected: preview.rows.length,
    rowsNew: newIndices.length,
    rowsDuplicate: preview.rows.filter(({ verdict }) => verdict.kind === 'duplicate').length,
    rowsErrored: 0,
    rowsNeedsReview: preview.rows.filter(({ verdict }) => verdict.kind === 'review').length,
    balanceChainOk: preview.balance.ok,
    scrubReport: preview.scrub,
    notes: preview.divergent ? 'Imported after the owner confirmed it shared no transaction with the overlapping history.' : null,
  }

  await db.transaction(
    'rw',
    [db.accounts, db.transactions, db.annotations, db.categories, db.imports, db.transfers, db.learningEvents],
    async () => {
      const stored = await db.accounts.where('fingerprint').equals(preview.accountFingerprint).first()
      if (stored === undefined) {
        await db.accounts.add({
          id: preview.accountId, fingerprint: preview.accountFingerprint, label: preview.accountLabel,
          last4: preview.last4, currency: 'EUR', createdAt: now, archived: false,
        })
      } else if (stored.id !== preview.accountId) {
        // The row keys were hashed with the preview's account id; writing them under another would orphan them.
        throw new ImportError('stale-preview', 'This account was added while you were reviewing the file. Choose the file again.')
      }

      await createUnseenCategories(preview)
      await db.transactions.bulkAdd(transactions)

      // After this account's rows exist, because pairing finds the opposite leg by querying the table.
      const transfers = await pairAcrossAccounts(preview.accountId, transactions.map((t) => t.id))
      if (transfers.length > 0) await db.transfers.bulkAdd(transfers)

      await db.imports.add(imported)

      for (const [index, patch] of edits) {
        const id = idByIndex.get(index)
        if (id !== undefined) await writeAnnotation(id, patch, 'owner')
      }
    },
  )
  return imported
}
