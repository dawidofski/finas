import type { Table } from 'dexie'
import { db, SCHEMA_VERSION } from './db'
import { seedDatabase } from './seed'

/**
 * Faithful JSON copy of every table. Values are never transformed: money stays integer cents and dates
 * stay YYYY-MM-DD strings, so a backup is a copy, not a migration. Every function enumerates db.tables
 * rather than a fixed list, so a table added by a later schema version is covered without editing this file.
 */
export type Bundle = {
  format: 'finance-export'
  schemaVersion: number
  exportedAt: string
  tables: Record<string, unknown[]>
}

/** 'write-failed' is added to the brief's three: a full disk is not a malformed file, and saying so would mislead (cf. design 24). */
export type RefusedReason = 'format' | 'newer-schema' | 'older-schema' | 'malformed' | 'write-failed' | 'salt-mismatch' | 'conflict' | 'cannot-open' | 'newer-format'

export type RestoreReport = {
  ok: boolean
  refusedReason?: RefusedReason
  /** Human-readable cause for a refusal; never claims data loss. */
  detail?: string
  /**
   * `willWrite` is the rows a restore adds or replaces. In merge mode that is purely NEW rows (the key
   * is absent locally), so it can never hide a reverted edit; every row that exists locally with
   * different content is counted in `conflicts` instead and is not written (design 31.2). Rows that
   * are identical locally appear in neither. analyticsCache always reports 0 written: any restore clears it (31.3).
   */
  perTable: Record<string, { incoming: number; willWrite: number; conflicts: number }>
  /** Merge mode: "table:id" of every incoming row that differs from an existing local row. The local row was kept. */
  conflictRows?: string[]
  /**
   * Merge mode only: transactionIds whose incoming annotation differs from the local one (the annotation
   * subset of conflictRows). The local annotation was kept; the owner decides per conflict (design 14.3, anti-goal A3).
   */
  conflictIds?: string[]
  /** Merge refusal 'conflict': "table:id" of incoming rows that cannot be written because a unique value (dedupKey, fingerprint, fileHash) is already held by a different local row. */
  blockedIds?: string[]
  /** Merge mode: the local settings differ from the backup's and were kept. */
  localSettingsKept?: boolean
  /** What this dry run cannot foresee, so "no conflicts" never over-promises. */
  unchecked?: string[]
}

const UNCHECKED = [
  'Merge is additive: it adds rows this device does not have and never changes a row it already has. A row that exists here with different content is counted as a conflict and left as it is, in every table (including a soft-delete marker on a transaction).',
  'Every restore clears the figures the app had worked out, as the restored records may differ, and they are worked out again when they are needed.',
  'Storage running out or the browser failing partway: the restore would then be refused whole and nothing changed.',
  'Per-field rules on accounts (fingerprint, label) are applied only when writing.',
]

type Mode = 'merge' | 'replace'
type Row = Record<string, unknown>
type Refusal = { ok: false; reason: RefusedReason; detail?: string }

const isRow = (v: unknown): v is Row => typeof v === 'object' && v !== null && !Array.isArray(v)

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((v, i) => deepEqual(v, b[i]))
  }
  if (isRow(a) && isRow(b)) {
    const ka = Object.keys(a)
    return ka.length === Object.keys(b).length && ka.every(k => k in b && deepEqual(a[k], b[k]))
  }
  return false
}

const primaryKeyPath = (t: Table): string => String(t.schema.primKey.keyPath)
const isKeyValue = (v: unknown) => (typeof v === 'string' && v.length > 0) || (typeof v === 'number' && Number.isFinite(v))

/** Primary key plus unique single-path indexes (dedupKey, fingerprint, fileHash): a row without one cannot be a real row. */
function requiredPaths(t: Table): string[] {
  const paths = [primaryKeyPath(t)]
  for (const ix of t.schema.indexes) {
    if (ix.unique && !ix.compound && !ix.multi && typeof ix.keyPath === 'string') paths.push(ix.keyPath)
  }
  return paths
}

/**
 * The schema version each table first existed in (design 29.1). A bundle may omit a table only if that
 * table was introduced AFTER the bundle's own version. Adding a table in a later schema version means adding
 * its line here; a test fails if db.tables and this map ever disagree.
 */
export const TABLE_INTRODUCED_IN: Record<string, number> = {
  accounts: 1, transactions: 1, annotations: 1, categories: 1, merchants: 1, moods: 1, purchaseReasons: 1,
  budgetAllocations: 1, imports: 1, transfers: 1, savingsGoals: 1, recurring: 1, learningEvents: 1,
  recommendationState: 1, analyticsCache: 1, settings: 1,
}

/** Tables a bundle of this schema version may legitimately lack. A table with no entry is never omittable. */
export function omittableTables(bundleVersion: number, tableNames: string[]): Set<string> {
  return new Set(tableNames.filter(n => (TABLE_INTRODUCED_IN[n] ?? 0) > bundleVersion))
}

export async function exportBundle(): Promise<Bundle> {
  return db.transaction('r', db.tables, async () => {
    const tables: Record<string, unknown[]> = {}
    for (const table of db.tables) tables[table.name] = await table.toArray()
    // Stamp the version the data actually has (what the open database is), not the registry's idea of it.
    return { format: 'finance-export', schemaVersion: db.verno, exportedAt: new Date().toISOString(), tables }
  })
}

/** Structural validation only; reads nothing from the database. */
const validSalt = (row: unknown): boolean => {
  const salt = (row as { privacy?: { accountSalt?: unknown } } | undefined)?.privacy?.accountSalt
  return typeof salt === 'string' && salt.trim().length > 0
}

function validate(input: unknown, mode: Mode): Refusal | { ok: true; tables: Map<string, Row[]> } {
  if (!isRow(input) || input.format !== 'finance-export') {
    return { ok: false, reason: 'format', detail: 'This is not a finance export file.' }
  }
  const { schemaVersion, tables, exportedAt } = input
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion) || schemaVersion < 1) {
    return { ok: false, reason: 'malformed', detail: 'schemaVersion is missing or not a positive integer.' }
  }
  if (typeof exportedAt !== 'string' || !isRow(tables)) {
    return { ok: false, reason: 'malformed', detail: 'exportedAt or tables is missing.' }
  }
  if (schemaVersion > SCHEMA_VERSION) {
    return {
      ok: false, reason: 'newer-schema',
      detail: `This file was made by a newer version (schema ${schemaVersion}); this app understands up to ${SCHEMA_VERSION}.`,
    }
  }
  if (schemaVersion < SCHEMA_VERSION) {
    // Design 29.2: refuse rather than write rows in an outdated shape. Migrating restored data is the alternative, not yet built.
    return {
      ok: false, reason: 'older-schema',
      detail: `This file was made by an older version (schema ${schemaVersion}); this app is at ${SCHEMA_VERSION} and cannot yet upgrade a backup's data while restoring it. Nothing was changed.`,
    }
  }
  const known = new Map(db.tables.map(t => [t.name, t]))
  const out = new Map<string, Row[]>()
  for (const [name, rows] of Object.entries(tables)) {
    const table = known.get(name)
    // An unknown table would be dropped silently, so refuse instead of restoring part of the file.
    if (!table) return { ok: false, reason: 'malformed', detail: `Unknown table "${name}".` }
    if (!Array.isArray(rows)) return { ok: false, reason: 'malformed', detail: `Table "${name}" is not a list.` }
    const paths = requiredPaths(table)
    const seenBy = paths.map(() => new Set<unknown>())
    for (const [i, row] of rows.entries()) {
      if (!isRow(row)) return { ok: false, reason: 'malformed', detail: `${name}[${i}] is not a record.` }
      for (const p of paths) {
        if (!isKeyValue(row[p])) return { ok: false, reason: 'malformed', detail: `${name}[${i}] has no valid "${p}".` }
      }
      // Without a salt every account fingerprint would stop matching its transactions (design 14.3).
      if (name === 'settings' && !validSalt(row)) {
        return { ok: false, reason: 'malformed', detail: `settings[${i}] has no usable privacy.accountSalt.` }
      }
      for (const [k, p] of paths.entries()) {
        if (seenBy[k]!.has(row[p])) return { ok: false, reason: 'malformed', detail: `${name} has "${String(row[p])}" twice in "${p}".` }
        seenBy[k]!.add(row[p])
      }
    }
    out.set(name, rows as Row[])
  }
  if (mode === 'replace') {
    // A replace clears every table, so an omitted table would be wiped while reporting success.
    // Only tables introduced after the bundle's version may legitimately be absent (design 29.1).
    const mayOmit = omittableTables(schemaVersion, db.tables.map(t => t.name))
    for (const t of db.tables) {
      if (!out.has(t.name) && (t.name === 'settings' || !mayOmit.has(t.name))) {
        return { ok: false, reason: 'malformed', detail: `Table "${t.name}" is missing; a replace would erase it. Nothing was changed.` }
      }
    }
    if ((out.get('settings') ?? []).length === 0) {
      return { ok: false, reason: 'malformed', detail: 'The backup has no settings row, which every backup from this app has. Nothing was changed.' }
    }
  }
  return { ok: true, tables: out }
}

/** Decides what a restore would write. Reads only; shared by inspectBundle and restoreBundle so they cannot disagree. */
async function plan(incomingTables: Map<string, Row[]>, mode: Mode): Promise<{ report: RestoreReport; writes: Map<string, Row[]> }> {
  const perTable: RestoreReport['perTable'] = {}
  const writes = new Map<string, Row[]>()
  const conflictIds: string[] = []
  const conflictRows: string[] = []
  const blockedIds: string[] = []
  let localSettingsKept = false
  if (mode === 'merge') {
    // Fingerprints are salted hashes: two different salts make the datasets mutually unintelligible.
    const incomingSalt = (incomingTables.get('settings')?.[0] as { privacy?: { accountSalt?: unknown } } | undefined)?.privacy?.accountSalt
    const local = (await db.table('settings').toCollection().first()) as { privacy?: { accountSalt?: unknown } } | undefined
    const localSalt = local?.privacy?.accountSalt
    if (typeof incomingSalt === 'string' && typeof localSalt === 'string' && incomingSalt !== localSalt) {
      return {
        writes,
        report: {
          ok: false, refusedReason: 'salt-mismatch', perTable,
          detail: 'This backup came from a different installation: each installation marks your accounts in its own way, so merging would create duplicate accounts that cannot be untangled. Use replace mode to restore it. Nothing was changed.',
        },
      }
    }
  }
  for (const table of db.tables) {
    const incoming = incomingTables.get(table.name) ?? []
    let toWrite = incoming
    let conflicts = 0
    if (mode === 'merge' && incoming.length > 0) {
      const pk = primaryKeyPath(table)
      const existing = await table.bulkGet(incoming.map(r => r[pk] as string))
      // A unique value (dedupKey, fingerprint, fileHash) already held by a DIFFERENT local row cannot be written.
      const heldByOther = new Set<string>()
      for (const p of requiredPaths(table).slice(1)) {
        const byValue = new Map(incoming.map(r => [r[p], r[pk]]))
        for (const l of await table.where(p).anyOf([...byValue.keys()] as string[]).toArray()) {
          const owner = byValue.get((l as Row)[p])
          if (owner !== (l as Row)[pk]) heldByOther.add(String(owner))
        }
      }
      toWrite = []
      incoming.forEach((row, i) => {
        const local = existing[i] as Row | undefined
        if (heldByOther.has(String(row[pk]))) { conflicts++; blockedIds.push(`${table.name}:${String(row[pk])}`) }
        else if (local === undefined) toWrite.push(row)
        else if (deepEqual(local, row)) return // already identical: nothing to write
        else {
          // Local always wins (design 31.2): a difference on an existing row is reported, never applied.
          conflicts++
          conflictRows.push(`${table.name}:${String(row[pk])}`)
          if (table.name === 'settings') localSettingsKept = true
          if (table.name === 'annotations') conflictIds.push(String(row[pk]))
        }
      })
    }
    // Derived data is never restored (design 31.3); restoreBundle clears it.
    if (table.name === 'analyticsCache') toWrite = []
    perTable[table.name] = { incoming: incoming.length, willWrite: toWrite.length, conflicts }
    writes.set(table.name, toWrite)
  }
  if (blockedIds.length > 0) {
    return {
      writes,
      report: {
        ok: false, refusedReason: 'conflict', perTable, blockedIds,
        detail: 'Some incoming rows carry a unique bank identity (dedupKey, fingerprint or file hash) that a different local row already holds, so they cannot be written. Nothing was changed.',
      },
    }
  }
  const report: RestoreReport = { ok: true, perTable, unchecked: UNCHECKED }
  if (conflictRows.length > 0) report.conflictRows = conflictRows
  if (conflictIds.length > 0) report.conflictIds = conflictIds
  if (localSettingsKept) report.localSettingsKept = true
  return { report, writes }
}

const refusal = (r: Refusal): RestoreReport => ({
  ok: false, refusedReason: r.reason, ...(r.detail ? { detail: r.detail } : {}), perTable: {},
})

/** Pure dry run: validates and reports what restoreBundle would do, and writes nothing. Async because merge compares with local rows. `mode` is deliberately required: the dry run equals the real run (design 27.2) only when the caller passes the mode it will then restore with. */
export async function inspectBundle(bundle: unknown, mode: Mode): Promise<RestoreReport> {
  const v = validate(bundle, mode)
  if (!v.ok) return refusal(v)
  return db.transaction('r', db.tables, async () => (await plan(v.tables, mode)).report)
}

/**
 * A bundle with a schemaVersion below the current one is refused (validate, design 29.2), so restored
 * rows are never in an outdated shape. Replace clears every table; any restore clears analyticsCache (31.3).
 */
export async function restoreBundle(bundle: unknown, mode: Mode): Promise<RestoreReport> {
  const v = validate(bundle, mode)
  if (!v.ok) return refusal(v)
  try {
    // One transaction over every table: any failure (schema violation, QuotaExceededError) aborts
    // it and the database is left exactly as it was.
    const report = await db.transaction('rw', db.tables, async () => {
      const { report, writes } = await plan(v.tables, mode)
      if (!report.ok) return report // refused before any write
      for (const table of db.tables) {
        if (mode === 'replace' || table.name === 'analyticsCache') await table.clear()
        const rows = writes.get(table.name) ?? []
        if (rows.length > 0) await table.bulkPut(rows)
      }
      return report
    })
    // A replace clears the reference tables, so a backup that lacked them would leave the owner without
    // categories, moods or reasons. Re-seeding only adds what is missing. It is outside the restore
    // transaction on purpose: a seeding failure must not undo or misreport a restore that succeeded.
    if (report.ok) await seedDatabase().catch(() => { /* retried on the next launch */ })
    return report
  } catch (err) {
    const perTable: RestoreReport['perTable'] = {}
    for (const table of db.tables) {
      perTable[table.name] = { incoming: v.tables.get(table.name)?.length ?? 0, willWrite: 0, conflicts: 0 }
    }
    const name = err instanceof Error ? err.name : 'Error'
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, refusedReason: 'write-failed', detail: `${name}: ${message}. Nothing was changed.`, perTable }
  }
}
