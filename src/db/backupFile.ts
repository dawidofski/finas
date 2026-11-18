/**
 * Reads a backup file by its content, never by its name, and opens encrypted ones. An encrypted file is turned back
 * into exactly the object a plain file parses into; from there the caller takes the road that already exists
 * (inspectBundle, the owner's confirm, restoreBundle). No restore rule is repeated here, so none can drift.
 * Nothing in this module touches the database.
 */
import type { RestoreReport } from './backup'
import { ENCRYPTED_FORMAT, checkEnvelope, decryptEnvelope } from './encryptedBackup'
import type { Envelope } from './encryptedBackup'

export type BackupFile =
  | { kind: 'plain'; bundle: unknown } // anything that parses and is not encrypted: today's route, unchanged
  | { kind: 'encrypted'; envelope: Envelope } // ask for the passphrase
  | { kind: 'refused'; report: RestoreReport }

/** Both writers put `format` first; the plain one pretty-prints, so whitespace is allowed. */
const STARTS_LIKE_OURS = /^\s*\{\s*"format"\s*:\s*"(?:finance-encrypted|finance-export)"/

const DAMAGED =
  'This looks like a backup from this app, but the file is damaged or incomplete, so it cannot be read. Nothing was changed.'
/** The wording the restore screen already uses for text that is not JSON. */
const NOT_JSON = 'This file is not valid JSON, so it is not a backup from this app.'

const refused = (refusedReason: NonNullable<RestoreReport['refusedReason']>, detail: string): BackupFile => ({
  kind: 'refused', report: { ok: false, refusedReason, detail, perTable: {} },
})

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)

/** Classifies by content only. A file that starts like one of ours but does not parse is "damaged or incomplete". */
export function readBackupFile(text: string): BackupFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return STARTS_LIKE_OURS.test(text) ? refused('malformed', DAMAGED) : refused('malformed', NOT_JSON)
  }
  if (isRecord(parsed) && parsed.format === ENCRYPTED_FORMAT) {
    const checked = checkEnvelope(parsed)
    return checked.ok ? { kind: 'encrypted', envelope: checked.envelope } : refused(checked.reason, checked.detail)
  }
  return { kind: 'plain', bundle: parsed }
}

/** Opens the file with the passphrase; a refusal is shaped like every other refused RestoreReport. */
export async function openEncryptedBackup(
  envelope: Envelope,
  passphrase: string,
): Promise<{ ok: true; bundle: unknown } | { ok: false; report: RestoreReport }> {
  const opened = await decryptEnvelope(envelope, passphrase)
  if (opened.ok) return { ok: true, bundle: opened.bundle }
  return { ok: false, report: { ok: false, refusedReason: opened.reason, detail: opened.detail, perTable: {} } }
}
