import { db } from './db'
import type { AnnotationRow, LearningEventRow, LearningEventType, TransactionRow } from './schema'

/**
 * The resolved view (`transaction + annotation`) and the single annotation write path (§32.1, §34).
 * `transactions` is immutable (§8.1); nothing here ever writes to it. Every read of `db.<table>`
 * happens at call time so a rebuilt Dexie table object is never stale.
 */

/** ING "category / subcategory" pair -> category id. Keys use the seed's `ingMappings` format. */
export type CategoryIndex = ReadonlyMap<string, string>

const pairKey = (ing: string, ingSub: string) => `${ing} / ${ingSub}`

export interface ResolvedTransaction extends TransactionRow {
  /** Owner's category, else the category derived from the ING pair (§34.3), else null. */
  categoryId: string | null
  subcategoryId: string | null
  merchantId: string | null
  paymentMethod: string | null
  note: string | null
  moodId: string | null
  purchaseReasonId: string | null
  worthwhile: boolean | null
  reviewed: boolean
  /** True when any owner-authored annotation field is set (everything but the `reviewed` workflow flag). */
  hasOverrides: boolean
}

/** One query over `categories`, used for a whole batch. */
export async function buildCategoryIndex(): Promise<CategoryIndex> {
  const index = new Map<string, string>()
  for (const c of await db.categories.toArray()) {
    for (const m of c.ingMappings) {
      const claimed = index.get(m)
      if (claimed !== undefined) {
        throw new Error(`ING pair "${m}" is claimed by both ${claimed} and ${c.id}; a pair must map to one category`)
      }
      index.set(m, c.id)
    }
  }
  return index
}

export async function categoryIdForIngPair(ing: string, ingSub: string): Promise<string | null> {
  return (await buildCategoryIndex()).get(pairKey(ing, ingSub)) ?? null
}

/** Pure. The transaction's bank values with each owner override applied on top. */
export function resolve(
  tx: TransactionRow,
  ann: AnnotationRow | undefined,
  categoryIndex: CategoryIndex,
): ResolvedTransaction {
  const derived = tx.ingCategory !== null && tx.ingSubcategory !== null
    ? categoryIndex.get(pairKey(tx.ingCategory, tx.ingSubcategory)) ?? null
    : null
  const ownerCategory = ann?.categoryId ?? null
  // undefined = no override; an explicit null detaches the round-up link.
  const parentOverride = ann?.roundupParentIdOverride
  return {
    ...tx,
    valueDate: ann?.dateOverride ?? tx.valueDate,
    amountCents: ann?.amountCentsOverride ?? tx.amountCents,
    description: ann?.descriptionOverride ?? tx.description,
    kind: ann?.typeOverride ?? tx.kind,
    roundupParentId: parentOverride !== undefined ? parentOverride : tx.roundupParentId,
    categoryId: ownerCategory ?? derived,
    subcategoryId: ann?.subcategoryId ?? null,
    merchantId: ann?.merchantId ?? null,
    paymentMethod: ann?.paymentMethod ?? null,
    note: ann?.note ?? null,
    moodId: ann?.moodId ?? null,
    purchaseReasonId: ann?.purchaseReasonId ?? null,
    worthwhile: ann?.worthwhile ?? null,
    reviewed: ann?.reviewed ?? false,
    hasOverrides: ann !== undefined && hasOwnerFields(ann),
  }
}

/**
 * Every AnnotationRow field except the three below is owner-authored and counts toward
 * `hasOverrides`. The Record type makes a newly added AnnotationRow field a compile error here until
 * it is classified, so the set cannot silently go stale.
 */
const NOT_OWNER_AUTHORED = { transactionId: true, reviewed: true, updatedAt: true } as const
type OwnerField = Exclude<keyof AnnotationRow, keyof typeof NOT_OWNER_AUTHORED>
const OWNER_FIELDS: Record<OwnerField, true> = {
  categoryId: true, subcategoryId: true, merchantId: true, typeOverride: true, paymentMethod: true,
  note: true, moodId: true, purchaseReasonId: true, worthwhile: true, dateOverride: true,
  amountCentsOverride: true, descriptionOverride: true, roundupParentIdOverride: true,
}

function hasOwnerFields(ann: AnnotationRow): boolean {
  return (Object.keys(OWNER_FIELDS) as OwnerField[]).some(k => {
    const v = ann[k]
    // For roundupParentIdOverride an explicit null is an answer (detached); elsewhere null is unset.
    return k === 'roundupParentIdOverride' ? v !== undefined : v !== null && v !== undefined
  })
}

/** Two reads for the whole batch (categories, annotations), however many rows. */
export async function resolveMany(txs: TransactionRow[]): Promise<ResolvedTransaction[]> {
  if (txs.length === 0) return []
  const [index, anns] = await Promise.all([
    buildCategoryIndex(),
    db.annotations.bulkGet(txs.map(t => t.id)),
  ])
  return txs.map((t, i) => resolve(t, anns[i], index))
}

/**
 * Owner fields with no editing control yet; they arrive with Plan 3 and get an event type then. Naming them here
 * is what makes EVENT_FOR_FIELD complete by construction: a newly added owner field is a compile error until it is
 * either given an event or listed here on purpose, so a correction can never silently leave no learning record (§32.1).
 */
const NOT_YET_TRACKED = { moodId: true, purchaseReasonId: true, worthwhile: true } as const

/** Annotation fields that feed the learning engine, and the event each one emits (§34.6). */
const EVENT_FOR_FIELD: Record<Exclude<OwnerField, keyof typeof NOT_YET_TRACKED>, LearningEventType> = {
  categoryId: 'category',
  subcategoryId: 'subcategory',
  merchantId: 'merchant',
  paymentMethod: 'paymentMethod',
  dateOverride: 'date',
  amountCentsOverride: 'amount',
  descriptionOverride: 'description',
  typeOverride: 'kind',
  note: 'note',
  roundupParentIdOverride: 'roundupParent',
}

/** The fields a caller may patch: every owner-authored field plus the `reviewed` workflow flag. */
const PATCHABLE = new Set<string>([...Object.keys(OWNER_FIELDS), 'reviewed'])

const emptyAnnotation = (transactionId: string): AnnotationRow => ({
  transactionId, categoryId: null, subcategoryId: null, merchantId: null, typeOverride: null,
  paymentMethod: null, note: null, moodId: null, purchaseReasonId: null, worthwhile: null,
  reviewed: false, dateOverride: null, amountCentsOverride: null, descriptionOverride: null,
  updatedAt: 0,
})

/**
 * The only way to write an annotation. An annotation row holds the latest value only, so for an
 * owner write each changed tracked field appends one learning event in the same transaction (§32.1,
 * §34.6); an unchanged field emits none.
 *
 * Event payload, by field:
 * - `categoryId`: `{ transactionId, field, old, oldWasDerived, new, newIsDerived, intent }`. `old` and
 *   `new` are EFFECTIVE categories: the stored one, else the one derived from the ING pair (§34.3);
 *   the two flags say which. `intent` is 'confirmation' when old equals new (the owner endorsed the
 *   value in force), else 'correction'.
 * - every other field: `{ transactionId, field, old, new }`. These carry no `intent`: an absent
 *   `intent` means correction, because an unchanged value emits no event, so every such event is a
 *   change. For date, amount, description and kind, old/new are the stored overrides (null = none),
 *   not the effective bank value; the bank value is recoverable from the immutable transactions row.
 *   For roundupParentIdOverride, undefined = no override (the bank link stands) and null = the owner
 *   detached the link; both are kept distinct in old/new. Test `payload.old === undefined`, never
 *   `'old' in payload`: JSON (a backup) drops undefined keys, so a membership check differs before
 *   and after a restore.
 *
 * Passing `roundupParentIdOverride: undefined` explicitly removes that override (back to the bank's
 * link). For every other field undefined means "leave as is". Unknown keys are dropped.
 *
 * `source: 'engine'` writes the row but no event: the engine's inferences are not owner corrections
 * and must never be trained on as if they were. It may not write `categoryId` (§34.3): the engine's
 * category opinion lives in the read-time derivation, and a stored one would be indistinguishable
 * from the owner's.
 */
export async function writeAnnotation(
  transactionId: string,
  patch: Partial<AnnotationRow>,
  source: 'owner' | 'engine',
): Promise<void> {
  if (source === 'engine' && patch.categoryId !== undefined) {
    throw new Error(
      'The engine may not write categoryId (§34.3): its category lives in the read-time derivation, ' +
      "and a stored one would be indistinguishable from the owner's.",
    )
  }
  await db.transaction('rw', db.transactions, db.annotations, db.learningEvents, db.categories, async () => {
    const tx = await db.transactions.get(transactionId)
    if (tx === undefined) {
      throw new Error(`Cannot annotate transaction ${transactionId}: it does not exist`)
    }
    const before = (await db.annotations.get(transactionId)) ?? emptyAnnotation(transactionId)
    const known = Object.entries(patch).filter(([k]) => PATCHABLE.has(k))
    const next: AnnotationRow = {
      ...before,
      ...Object.fromEntries(known.filter(([, v]) => v !== undefined)),
      transactionId,
      updatedAt: Date.now(),
    }
    if (known.some(([k, v]) => k === 'roundupParentIdOverride' && v === undefined)) {
      delete next.roundupParentIdOverride
    }

    if (source === 'owner') {
      const at = Date.now()
      const events: LearningEventRow[] = []
      const derived = tx.ingCategory !== null && tx.ingSubcategory !== null
        ? await categoryIdForIngPair(tx.ingCategory, tx.ingSubcategory)
        : null
      for (const [field, type] of Object.entries(EVENT_FOR_FIELD) as [keyof typeof EVENT_FOR_FIELD, LearningEventType][]) {
        if (field === 'roundupParentIdOverride') {
          if (before[field] === next[field]) continue
          events.push(event(at, type, { transactionId, field, old: before[field], new: next[field] }))
          continue
        }
        const oldValue = before[field] ?? null
        const newValue = next[field] ?? null
        if (oldValue === newValue) continue
        if (field === 'categoryId') {
          const oldEffective = oldValue ?? derived
          const newEffective = newValue ?? derived
          events.push(event(at, type, {
            transactionId, field,
            old: oldEffective, oldWasDerived: oldValue === null && derived !== null,
            new: newEffective, newIsDerived: newValue === null && derived !== null,
            // A confirmation endorses the value in force; counting it as a correction would make the
            // engine look worse than it is.
            intent: oldEffective === newEffective ? 'confirmation' : 'correction',
          }))
        } else {
          events.push(event(at, type, { transactionId, field, old: oldValue, new: newValue }))
        }
      }
      if (events.length > 0) await db.learningEvents.bulkAdd(events)
    }
    await db.annotations.put(next)
  })
}

const event = (at: number, type: LearningEventType, payload: unknown): LearningEventRow =>
  ({ id: crypto.randomUUID(), at, type, payload, outcome: null })
