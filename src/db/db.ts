import Dexie, { type EntityTable } from 'dexie'
import { applyMigrations, sealMigrations } from './migrations'
import type {
  AccountRow, TransactionRow, AnnotationRow, CategoryRow, MerchantRow, MoodRow,
  PurchaseReasonRow, BudgetAllocationRow, ImportRow, TransferRow, SavingsGoalRow,
  RecurringRow, LearningEventRow, RecommendationStateRow, AnalyticsCacheRow, SettingsRow,
} from './schema'

/** Governs Dexie migrations. Derived from the migration registry (highest registered version, 1 if none). */
export { SCHEMA_VERSION } from './migrations'
/** Invalidates cached analytics when a formula changes. Independent of SCHEMA_VERSION. */
export const ENGINE_VERSION = 1

export type OpenResult =
  | { ok: true }
  | { ok: false; reason: 'blocked' | 'unsupported' | 'corrupt' | 'unknown'; detail: string }

class FinanceDB extends Dexie {
  accounts!: EntityTable<AccountRow, 'id'>
  transactions!: EntityTable<TransactionRow, 'id'>
  annotations!: EntityTable<AnnotationRow, 'transactionId'>
  categories!: EntityTable<CategoryRow, 'id'>
  merchants!: EntityTable<MerchantRow, 'id'>
  moods!: EntityTable<MoodRow, 'id'>
  purchaseReasons!: EntityTable<PurchaseReasonRow, 'id'>
  budgetAllocations!: EntityTable<BudgetAllocationRow, 'id'>
  imports!: EntityTable<ImportRow, 'id'>
  transfers!: EntityTable<TransferRow, 'id'>
  savingsGoals!: EntityTable<SavingsGoalRow, 'id'>
  recurring!: EntityTable<RecurringRow, 'id'>
  learningEvents!: EntityTable<LearningEventRow, 'id'>
  recommendationState!: EntityTable<RecommendationStateRow, 'key'>
  analyticsCache!: EntityTable<AnalyticsCacheRow, 'key'>
  settings!: EntityTable<SettingsRow, 'id'>

  /**
   * Applies every registered migration before opening, on every path that opens this database
   * (an explicit open() and Dexie's auto-open on first query alike). Without this, code touching
   * `db` directly would open it at v1, a silent downgrade from v2 onward (design 29).
   * applyMigrations also seals the registry, so registering a migration after any open fails loudly.
   */
  override open() {
    if (!this.isOpen()) applyMigrations(this)
    return super.open()
  }

  constructor(name = 'finance') {
    // Resolve indexedDB at call time so a denied or missing store is seen as it is now.
    // IDBFactory is exactly open, deleteDatabase, databases and cmp. databases() is missing in some
    // browsers, so it is exposed only when the real one exists (Dexie feature-detects it).
    const live = {
      open: (name: string, version?: number) => globalThis.indexedDB.open(name, version),
      deleteDatabase: (name: string) => globalThis.indexedDB.deleteDatabase(name),
      cmp: (a: unknown, b: unknown) => globalThis.indexedDB.cmp(a, b),
      get databases() {
        const real = globalThis.indexedDB?.databases
        return typeof real === 'function' ? () => globalThis.indexedDB.databases() : undefined
      },
    } as unknown as IDBFactory
    super(name, { indexedDB: live })

    // Guards (below) are attached on every open, once the final table objects exist, so no code
    // path that opens the database can end up without them. A plain on('ready', fn) is one-shot
    // (Dexie unsubscribes it after the first open); the second argument makes it sticky.
    this.on.ready.subscribe(() => { installGuards(this) }, true)

    this.version(1).stores({
      accounts: 'id, &fingerprint',
      // IndexedDB cannot index null. The deletedAt and roundupParentId indexes therefore serve
      // "find the deleted / the round-ups" only; "not deleted" must be a filter, never where('deletedAt').equals(null).
      transactions:
        'id, &dedupKey, [accountId+valueDate], accountId, valueDate, importId, kind, roundupParentId, deletedAt',
      // Booleans are not valid IndexedDB keys, so reviewed and worthwhile are deliberately not indexed:
      // the needs-review queue filters (about 3,000 rows a year). categoryId and purchaseReasonId drive
      // the category breakdown and the purchase-reason analysis.
      annotations: '&transactionId, merchantId, moodId, categoryId, purchaseReasonId',
      categories: 'id, parentId',
      merchants: 'id, defaultCategoryId',
      moods: 'id, order',
      purchaseReasons: 'id, order',
      budgetAllocations: 'id, categoryId, savingsGoalId',
      imports: 'id, &fileHash, accountId, importedAt',
      transfers: 'id, outTransactionId, inTransactionId',
      savingsGoals: 'id',
      recurring: 'id, merchantId',
      learningEvents: 'id, at, type',
      recommendationState: '&key',
      analyticsCache: '&key',
      settings: 'id',
    })
  }
}

// --- Account identity guard (design §14.1) --------------------------------
// accounts may hold a fingerprint and last4 only; never the IBAN or holder name.
const ACCOUNT_FIELDS = new Set(['id', 'fingerprint', 'label', 'last4', 'currency', 'createdAt', 'archived'])
// A label such as 'Cuenta nómina' or 'Ahorro 2026' is fine. Refused: 12+ digits in a row, 16+ digits
// when separated by spaces or dashes, or an IBAN-shaped run containing 10+ digits.
export const IBAN_LIKE = /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]){11,30}\b/gi
export const digitCount = (s: string) => (s.match(/\d/g) ?? []).length
// An unbroken run of 12+ digits is refused; digits separated by spaces or dashes need 16+, so a label
// such as '2026 2027 2028' (12 digits in groups) passes while '9999 0418 4502 0005 1332' (20) does not.
export const LONG_DIGITS = /\d{12,}|\d(?:[\s-]?\d){15,}/

function assertAccountSafe(row: Record<string, unknown>, creating: boolean): void {
  for (const key of Object.keys(row)) {
    if (!ACCOUNT_FIELDS.has(key)) throw new Error(`accounts.${key} is not allowed: accounts never store identity data`)
  }
  const last4 = row.last4
  if (last4 !== undefined && last4 !== null && !(typeof last4 === 'string' && /^\d{4}$/.test(last4))) {
    throw new Error('accounts.last4 must be exactly four digits or null')
  }
  const label = row.label
  if (typeof label === 'string' && (LONG_DIGITS.test(label) || [...label.matchAll(IBAN_LIKE)].some(m => digitCount(m[0]) >= 10))) {
    throw new Error('That name looks like an account number, so it was not used. Choose a plain name such as "Savings" or "Cuenta principal".')
  }
  // Present-and-checked on create; on update a key that is present (even as undefined) is checked too.
  const checked = (key: string) => creating || key in row
  const fingerprint = row.fingerprint
  if (checked('fingerprint') && !(typeof fingerprint === 'string' && /^[0-9a-f]{64}$/.test(fingerprint))) {
    throw new Error('accounts.fingerprint must be a SHA-256 hex digest (64 lowercase hex characters)')
  }
  const currency = row.currency
  if (checked('currency') && !(typeof currency === 'string' && /^[A-Z]{3}$/.test(currency))) {
    throw new Error('accounts.currency must be a three-letter uppercase code')
  }
  const createdAt = row.createdAt
  if (checked('createdAt') && !(typeof createdAt === 'number' && Number.isFinite(createdAt) && createdAt >= 0)) {
    throw new Error('accounts.createdAt must be an epoch-millisecond number')
  }
  if (checked('archived') && typeof row.archived !== 'boolean') {
    throw new Error('accounts.archived must be a boolean')
  }
  const id = row.id
  if (typeof id === 'string' && (LONG_DIGITS.test(id) || [...id.matchAll(IBAN_LIKE)].some(m => digitCount(m[0]) >= 10))) {
    throw new Error('accounts.id looks like an account number and was refused')
  }
}

// --- Transaction immutability guard (design §8.1) --------------------------
// Guarantee: no field of a committed bank row can change except its soft-delete marker (deletedAt);
// owner edits go to annotations. It does NOT cover delete-then-re-add of a row (hard deletes stay
// allowed for restore and "delete all my data"); that rests on the import code never doing it.
const TRANSACTION_MUTABLE = new Set(['deletedAt'])

// Declaring a later schema version makes Dexie rebuild its table objects, which discards hooks
// attached to the old ones (found by a test). The 'ready' event fires on every open after the final
// table objects exist, so the guards are (re)attached there. Idempotent per table object.
const guarded = new WeakSet<object>()
function installGuards(target: FinanceDB): void {
  if (!guarded.has(target.transactions)) {
    guarded.add(target.transactions)
    target.transactions.hook('updating', (mods) => {
      for (const key of Object.keys(mods)) {
        if (!TRANSACTION_MUTABLE.has(key)) {
          throw new Error(`transactions.${key} is immutable after import: write an override to annotations instead`)
        }
      }
    })
  }
  if (!guarded.has(target.accounts)) {
    guarded.add(target.accounts)
    target.accounts.hook('creating', (_pk, obj) => { assertAccountSafe(obj as unknown as Record<string, unknown>, true) })
    target.accounts.hook('updating', (mods) => { assertAccountSafe(mods as Record<string, unknown>, false) })
  }
}

export function createDatabase(name = 'finance'): FinanceDB {
  return new FinanceDB(name)
}
export const db = createDatabase()

// --- Opening --------------------------------------------------------------

export function classifyOpenError(err: unknown): Extract<OpenResult, { ok: false }> {
  const detail = err instanceof Error && err.message ? err.message : String(err)
  // Dexie may wrap the browser's error (inner) or prefix the error name onto the message.
  const names = new Set<string>()
  for (let e: unknown = err, i = 0; e instanceof Error && i < 5; e = (e as { inner?: unknown }).inner, i++) {
    names.add(e.name)
  }
  const prefix = /^(\w+Error):/.exec(detail)?.[1]
  if (prefix) names.add(prefix)
  if (['SecurityError', 'InvalidStateError', 'MissingAPIError'].some(n => names.has(n))) {
    return { ok: false, reason: 'blocked', detail }
  }
  if (['VersionError', 'DatabaseClosedError'].some(n => names.has(n))) {
    return { ok: false, reason: 'corrupt', detail }
  }
  // Quota, UnknownError, transient platform failures: we do not know the cause, so we do not claim one.
  return { ok: false, reason: 'unknown', detail }
}

export async function openDatabase(): Promise<OpenResult> {
  if (typeof globalThis.indexedDB === 'undefined' || globalThis.indexedDB === null) {
    return { ok: false, reason: 'unsupported', detail: 'This browser does not provide IndexedDB.' }
  }
  sealMigrations()
  try {
    await db.open() // open() applies the registered migrations
    return { ok: true }
  } catch (err) {
    return classifyOpenError(err)
  }
}
