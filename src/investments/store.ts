import { db } from '../db/db'
import { getSettings } from '../db/seed'
import { parseTrading212, type InvestmentEvent } from './trading212'

/**
 * Where the rows of imported Trading 212 files are kept: on the settings row (`investments`), so they travel in a backup
 * and need no new table. A few hundred small rows a year; the row is rewritten only when a file is imported.
 *
 * A known limit of keeping them there: restoring a backup in MERGE mode keeps this device's settings row, so investment
 * rows that exist only in the backup are not added by a merge. A replace restore brings them back in full.
 */
export async function investmentEvents(): Promise<InvestmentEvent[]> {
  return (await getSettings()).investments ?? []
}

export interface ImportOutcome {
  /** Rows in the file. */
  inFile: number
  /** Rows that were new and are now stored. */
  added: number
  /** Rows already stored from an earlier file (the same broker id, or the same content where the broker gives no id). */
  already: number
}

/**
 * Reads a Trading 212 history file and stores the rows not already stored. The whole file is read and checked first
 * (parseTrading212 throws on a file that is not this export or has a row it cannot read), so a refused file changes
 * nothing. Files may overlap: a row is recognised by its id and counted once.
 */
export async function importTrading212(text: string): Promise<ImportOutcome> {
  const events = parseTrading212(text)
  await getSettings()   // the row exists before the transaction below updates it
  return db.transaction('rw', db.settings, async () => {
    const row = await db.settings.get('singleton')
    const stored = row?.investments ?? []
    const known = new Set(stored.map((e) => e.id))
    const fresh = events.filter((e) => !known.has(e.id))
    if (fresh.length > 0) await db.settings.update('singleton', { investments: [...stored, ...fresh] })
    return { inFile: events.length, added: fresh.length, already: events.length - fresh.length }
  })
}

/** Removes every stored investment row. The bank transactions are not touched. */
export async function clearInvestments(): Promise<void> {
  await getSettings()
  await db.settings.update('singleton', { investments: [] })
}
