import type Dexie from 'dexie'
import type { Transaction } from 'dexie'

export interface Migration {
  version: number
  upgrade: (tx: Transaction) => Promise<void>
  /** Table changes introduced by this version. Omit when only data changes. */
  stores?: Record<string, string | null>
}

/** The single place a future schema version is added. Empty at v1. */
const registry: Migration[] = []
let sealed = false
/** Versions already declared on each Dexie instance, so repeated opens never redeclare. */
const applied = new WeakMap<Dexie, Set<number>>()

/**
 * The schema version: the highest registered migration, or 1 when none.
 * A live binding that tracks the registry, so it cannot be left behind when a migration is added.
 * It is the version openDatabase() opens; opening `db` directly bypasses the registry.
 */
export let SCHEMA_VERSION = 1

export function registerMigration(
  version: number,
  upgrade: (tx: Transaction) => Promise<void>,
  stores?: Record<string, string | null>,
): void {
  if (sealed) {
    throw new Error(`Cannot register migration ${version}: the database has already been opened. Register migrations before openDatabase().`)
  }
  if (!Number.isInteger(version) || version < 2) {
    throw new Error(`Migration version must be an integer of at least 2, got ${version}`)
  }
  if (registry.some(m => m.version === version)) {
    throw new Error(`Migration for version ${version} is already registered`)
  }
  registry.push({ version, upgrade, stores })
  registry.sort((a, b) => a.version - b.version)
  SCHEMA_VERSION = Math.max(1, ...registry.map(m => m.version))
}

/** Stops further registration. Called once the database is being opened. */
export function sealMigrations(): void {
  sealed = true
}

/** Declares each registered version on the instance, in ascending order. Call before open(). */
export function applyMigrations(target: Dexie): void {
  sealMigrations()
  const done = applied.get(target) ?? new Set<number>()
  applied.set(target, done)
  for (const m of registry) {
    if (done.has(m.version)) continue
    const v = target.version(m.version)
    if (m.stores) v.stores(m.stores)
    v.upgrade(m.upgrade)
    done.add(m.version)
  }
}

/** Test-only seam. Calling it empties the migration registry and unseals it; never call it in app code. */
export function resetMigrationsForTest(): void {
  registry.length = 0
  sealed = false
  SCHEMA_VERSION = 1
}
