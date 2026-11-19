/**
 * Row types for the Dexie database (design §8, with the §23 deltas applied).
 * Types only: no runtime code lives here.
 *
 * Money is signed integer cents. Dates are 'YYYY-MM-DD' strings. Timestamps
 * are epoch milliseconds.
 *
 * `transactions` is immutable after import (§8.1). Every owner edit lives in
 * `annotations`, keyed by transactionId. The application reads the resolved
 * view `transaction + annotation`; `dedupKey` is computed only from the bank's
 * original values on the transactions row, never from that resolved view.
 */

/** Kind of a transaction (§8.2). Distinct from CategoryKind. */
export type TransactionKind = 'spend' | 'income' | 'internal' | 'roundup'

/** Kind of a category (§21.2). Distinct from TransactionKind. */
export type CategoryKind = 'essential' | 'discretionary' | 'savings' | 'internal' | 'income'

/** §23.1: a peer (Bizum, named individual) is never a merchant. */
export type MerchantKind = 'merchant' | 'person'

/**
 * Deliberately has no field for the account number or the holder's name (§14.1).
 * Only a salted fingerprint and the last four digits may be stored.
 */
export interface AccountRow {
  id: string
  fingerprint: string
  label: string
  last4: string | null
  currency: string
  createdAt: number
  archived: boolean
}

export interface TransactionRow {
  id: string
  accountId: string
  valueDate: string
  amountCents: number
  balanceCents: number
  description: string
  comment: string | null
  ingCategory: string | null
  ingSubcategory: string | null
  kind: TransactionKind
  /** Unique. Derived solely from the bank's original values (§9.10). */
  dedupKey: string
  importId: string
  fileSeq: number
  roundupParentId: string | null
  createdAt: number
  deletedAt: number | null
}

/** Owner-authored fields only. One row per transaction, keyed by transactionId. */
export interface AnnotationRow {
  transactionId: string
  categoryId: string | null
  subcategoryId: string | null
  merchantId: string | null
  typeOverride: TransactionKind | null
  paymentMethod: string | null
  note: string | null
  moodId: string | null
  purchaseReasonId: string | null
  worthwhile: boolean | null
  reviewed: boolean
  dateOverride: string | null
  amountCentsOverride: number | null
  descriptionOverride: string | null
  /** §32. Undefined means no override; null means the owner detached the round-up link. */
  roundupParentIdOverride?: string | null
  updatedAt: number
}

export interface CategoryRow {
  id: string
  name: string
  parentId: string | null
  /** Null on a parent (parents group, never classify, §21.2/§25); required on a leaf. */
  kind: CategoryKind | null
  isUserCreated: boolean
  ingMappings: string[]
  /** §21.2: auto-created from an unmapped ING pair. Undefined is treated as false. */
  needsReview?: boolean
}

export interface MerchantRow {
  id: string
  canonicalName: string
  kind: MerchantKind
  matchPatterns: string[]
  defaultCategoryId: string | null
  isSubscription: boolean
  createdAt: number
}

export interface MoodRow {
  id: string
  label: string
  emoji: string
  /** Integer -2..+2; null for 'Other' and for custom moods until assigned (§21.3). */
  valence: number | null
  isCustom: boolean
  /** Display position; distinct from valence. */
  order: number
  /** Hidden from pickers, never deleted: past annotations keep referencing it (§21.3). */
  archived: boolean
}

export interface PurchaseReasonRow {
  id: string
  label: string
  isCustom: boolean
  order: number
  /** Hidden from pickers, never deleted (§21.3). */
  archived: boolean
}

/** Targets exactly one of categoryId or savingsGoalId (§23.2). */
export interface BudgetAllocationRow {
  id: string
  categoryId: string | null
  savingsGoalId: string | null
  percentBp: number | null
  fixedCents: number | null
  effectiveFrom: string
  note: string | null
}

export interface ImportRow {
  id: string
  filename: string
  format: 'xlsx' | 'pdf' | 'csv'
  fileHash: string
  accountId: string
  importedAt: number
  coverageStart: string
  coverageEnd: string
  rowsDetected: number
  rowsNew: number
  rowsDuplicate: number
  rowsErrored: number
  rowsNeedsReview: number
  balanceChainOk: boolean
  scrubReport: unknown
  notes: string | null
}

export interface TransferRow {
  id: string
  outTransactionId: string
  inTransactionId: string
  amountCents: number
  matchScore: number
  confirmedByUser: boolean
  matchedAt: number
  /** §32.2. Undefined is treated as 'internal'. */
  linkKind?: 'internal' | 'roundup' | 'refund'
}

export interface SavingsGoalRow {
  id: string
  name: string
  targetCents: number
  deadline: string | null
  contributionPercentBp: number
  createdAt: number
  completedAt: number | null
  archived: boolean
}

export interface RecurringRow {
  id: string
  merchantId: string
  amountCents: number
  toleranceCents: number
  /** The spec (§10, §13.4) names annual and irregular bills but never lists the set; this is the builder's closed set. */
  frequency: 'weekly' | 'monthly' | 'quarterly' | 'annual' | 'irregular'
  lastSeenDate: string
  expectedNextDate: string | null
  matchScore: number
  confirmedByUser: boolean
  cancelled: boolean
  /**
   * The owner said "this is not recurring": detection must not show it again. Undefined means false (a row written before
   * this field existed, or by a backup that predates it). Deliberately separate from `cancelled`: "I stopped paying" is a
   * payment that did recur; this is a pattern that never was one. Not indexed, so no Dexie version.
   */
  dismissed?: boolean
}

/**
 * The event types §11 describes (category/merchant correction, merchant rename pattern,
 * recommendation feedback, outcome re-measurement, regret marking). §11 does not give
 * identifiers, so these names are the builder's; extend by adding to the union.
 */
export type LearningEventType =
  | 'merchantRename'
  // One event per changed annotation field (§34.6). Mood, reason and worthwhile arrive in Plan 3.
  | 'category' | 'subcategory' | 'merchant' | 'paymentMethod' | 'date' | 'amount' | 'description' | 'kind' | 'note'
  | 'roundupParent'
  | 'recommendationAccepted' | 'recommendationRejected' | 'recommendationSnoozed'
  | 'outcomeMeasured' | 'regretMarked'

/** States implied by §11: shown, accepted, rejected (twice => suppressed), snoozed. */
export type RecommendationStatus = 'active' | 'accepted' | 'rejected' | 'snoozed' | 'suppressed'

/**
 * Append-only. Annotation events (written only by writeAnnotation) carry
 * `{ transactionId, field, old, new }`; 'category' events add oldWasDerived, newIsDerived and
 * `intent` ('correction' | 'confirmation'). On every other annotation event an absent `intent`
 * means correction. 'roundupParent' events may hold undefined for old or new (no override): test
 * `payload.old === undefined`, never `'old' in payload`, because a backup (JSON) drops the key.
 * See writeAnnotation for the full contract.
 */
export interface LearningEventRow {
  id: string
  at: number
  type: LearningEventType
  payload: unknown
  /** Outcome tracking, §11. Null until measured. */
  outcome: 'improved' | 'unchanged' | 'worsened' | null
}

export interface RecommendationStateRow {
  key: string
  status: RecommendationStatus
  shownCount: number
  rejectedCount: number
  lastShownAt: number | null
  suppressedUntil: number | null
  evidenceFingerprint: string | null
}

export interface AnalyticsCacheRow {
  key: string
  engineVersion: number
  inputsHash: string
  computedAt: number
  payload: unknown
}

export interface SettingsRow {
  id: 'singleton'
  theme: 'system' | 'light' | 'dark'
  locale: string
  privacy: {
    /** Random per-installation salt for account fingerprints (§14.1). */
    accountSalt: string
    storeLast4: boolean
  }
  moodPrompting: { enabled: boolean }
  /** Days before spending is asked about in the "Worth it?" queue (§21.4). Absent means the default of 7. */
  worthwhileDelayDays?: number
  deepseek: { enabled: boolean }
  backup: { lastBackupAt: number | null }
  /**
   * The owner's own rules for filing a transaction: when the bank's description contains `contains` (compared with case,
   * accents and spaces ignored), the transaction is filed under `categoryId` unless the owner set a category on it by hand.
   * Kept on the settings row so it travels in a backup and needs no new table. Absent means no rules.
   */
  categoryRules?: CategoryRule[]
  /** The owner's mood for a whole day, by ISO date ('YYYY-MM-DD') -> mood id. Absent means none recorded. */
  dayMoods?: Record<string, string>
}

export interface CategoryRule {
  id: string
  contains: string
  categoryId: string
}
