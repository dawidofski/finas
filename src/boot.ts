import { openDatabase, type OpenResult } from './db/db'
import { seedDatabase } from './db/seed'

/**
 * Opens the database and makes sure the reference data exists, in that order and fully awaited,
 * before anything renders. The order matters: ThemeProvider's getSettings() and seedDatabase() both
 * add the settings singleton, and run concurrently they collide with a ConstraintError that only
 * one of them swallows. Awaiting the seed first means the UI only ever sees a seeded database.
 * Never throws: every failure becomes a result the storage-error screen can present.
 */
export async function boot(): Promise<OpenResult> {
  let opened: OpenResult
  try { opened = await openDatabase() } catch (err) { return { ok: false, reason: 'unknown', detail: String(err) } }
  if (!opened.ok) return opened
  try {
    await seedDatabase()
  } catch (err) {
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    return { ok: false, reason: 'unknown', detail: `Seeding the reference data failed. ${detail}` }
  }
  return { ok: true }
}
