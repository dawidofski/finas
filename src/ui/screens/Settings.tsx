import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { rebuildAnalytics } from '../../analytics/cache'
import { exportBundle, inspectBundle, restoreBundle, type RestoreReport } from '../../db/backup'
import { db } from '../../db/db'
import { renameAccount, setStoreLast4 } from '../../db/privacy'
import { getSettings } from '../../db/seed'
import type { AccountRow } from '../../db/schema'
import { epochMsToIso } from '../../lib/dates'

type Mode = 'merge' | 'replace'

/** A preview is pinned to the mode and the exact bundle it was computed for; confirm reuses both. */
type Preview = { mode: Mode; bundle: unknown; report: RestoreReport }

/** A refusal the owner can read. Reason and detail are shown as the engine wrote them. */
function Refusal({ report }: { report: Pick<RestoreReport, 'refusedReason' | 'detail' | 'blockedIds'> }) {
  return (
    <div role="alert" className="notice notice-refusal">
      <p><strong>Refused ({report.refusedReason ?? 'unknown'}).</strong> Nothing was changed.</p>
      {report.detail && <p>{report.detail}</p>}
      {report.blockedIds && report.blockedIds.length > 0 && (
        <>
          <p>Rows that cannot be written:</p>
          <IdList ids={report.blockedIds} />
        </>
      )}
    </div>
  )
}

function IdList({ ids }: { ids: string[] }) {
  return <ul className="id-list">{ids.map(id => <li key={id}><code>{id}</code></li>)}</ul>
}

const refusal = (refusedReason: RestoreReport['refusedReason'], detail: string): RestoreReport =>
  ({ ok: false, refusedReason, detail, perTable: {} })

function readText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error ?? new Error('read failed'))
    r.readAsText(file)
  })
}

// The file name keeps the sortable year-month-day form on purpose: it is a name for a file, not a date the owner reads
// in the app. It uses the UTC day, like every other date in the app, never a local-timezone Date method.
const today = () => epochMsToIso(Date.now())

/** The message of whatever refused a write, as it was written. The accounts guard words its own refusals for the owner. */
const reasonOf = (e: unknown) => (e instanceof Error && e.message ? e.message : 'Nothing was changed.')

function AccountName({ account, index, onRenamed }: { account: AccountRow; index: number; onRenamed: () => void }) {
  const [draft, setDraft] = useState(account.label)
  const [problem, setProblem] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const id = useId()
  // The name can change underneath this field (switching the digits off relabels the accounts named after them).
  useEffect(() => { setDraft(account.label) }, [account.label])
  async function save() {
    setBusy(true); setProblem(null); setSaved(false)
    try { await renameAccount(account.id, draft); setSaved(true); onRenamed() } catch (e) { setProblem(reasonOf(e)) } finally { setBusy(false) }
  }
  return (
    <form className="settings-account" onSubmit={(e) => { e.preventDefault(); void save() }}>
      <label htmlFor={id}>Name for account {index + 1}</label>
      <input id={id} type="text" value={draft} maxLength={60} autoComplete="off" aria-invalid={problem !== null}
             onChange={(e) => { setDraft(e.target.value); setSaved(false) }} />
      <div className="actions">
        <button type="submit" className="btn" disabled={busy || draft.trim() === account.label}>Save name</button>
      </div>
      {problem && <div role="alert" className="notice notice-refusal"><p>{problem}</p></div>}
      {saved && <p role="status">Saved.</p>}
    </form>
  )
}

function Accounts() {
  const [accounts, setAccounts] = useState<AccountRow[] | null>(null)
  const [storeLast4, setStoreLast4State] = useState<boolean | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const load = useCallback(async () => {
    const [settings, rows] = await Promise.all([getSettings(), db.accounts.toArray()])
    setStoreLast4State(settings.privacy.storeLast4)
    setAccounts(rows.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1)))
  }, [])
  useEffect(() => { void load().catch(() => setProblem('Your accounts could not be read.')) }, [load])

  async function toggle(enabled: boolean) {
    setBusy(true); setProblem(null); setNotice(null)
    try {
      const { cleared } = await setStoreLast4(enabled)
      setNotice(enabled
        ? 'Saved. Files you import from now on will keep the last four digits.'
        : cleared > 0
          ? `Saved. The last four digits were removed from ${cleared} ${cleared === 1 ? 'account' : 'accounts'}.`
          : 'Saved. Nothing about an account number is kept.')
      await load()
    } catch (e) { setProblem(`${reasonOf(e)}`) } finally { setBusy(false) }
  }

  return (
    <>
      <h2>Accounts</h2>
      {problem && <div role="alert" className="notice notice-refusal"><p>{problem}</p></div>}
      {storeLast4 !== null && (
        <>
          <label className="switch">
            <input type="checkbox" role="switch" checked={storeLast4} disabled={busy} onChange={(e) => { void toggle(e.target.checked) }} />
            <span>Keep the last four digits of each account number</span>
          </label>
          <p>
            The full number is never kept, only a code that recognises the account next time. With this off, the four digits are
            removed too, and an account named after them gets a plain number instead. A name you typed yourself is left exactly as you
            wrote it, so if it contains digits they stay. Switching it back on only affects files you import afterwards.
          </p>
        </>
      )}
      {notice && <p role="status">{notice}</p>}
      {accounts !== null && accounts.length === 0 && <p>Accounts appear here once you import a statement.</p>}
      {accounts?.map((a, i) => <AccountName key={a.id} account={a} index={i} onRenamed={() => { void load() }} />)}
    </>
  )
}

/**
 * Recomputes every remembered figure. It writes nothing the owner entered: rebuildAnalytics only clears the analytics store
 * (design 7.1). The copy deliberately promises no particular scenario. It used to name a stale label "after you renamed a mood,
 * a reason, a category or a merchant", and there is no screen that renames any of those; the two gaps that were real (a refund
 * link and a budget change) are now noticed by the figures themselves. So this is the last resort it says it is, and the comment
 * on inputsHash names the tables a future rename or goal screen would have to add before this copy could go stale again.
 * `aria-disabled` plus a guard rather than `disabled`: a disabled button that has focus drops it to the page, which strands a
 * keyboard user mid-action. The busy state is always left in `finally`, so a failure cannot leave the control stuck.
 */
function RebuildFigures() {
  const [busy, setBusy] = useState(false)
  const [cleared, setCleared] = useState<number | null>(null)
  const [failed, setFailed] = useState(false)
  async function rebuild() {
    if (busy) return
    setBusy(true); setCleared(null); setFailed(false)
    try { setCleared(await rebuildAnalytics()) } catch { setFailed(true) } finally { setBusy(false) }
  }
  return (
    <>
      <h2>Recalculate figures</h2>
      <p>
        So that screens open quickly, the app remembers the totals and averages it works out, and works them out again by itself
        whenever anything they are based on changes. This throws away everything it remembers, so every figure is worked out
        again from scratch. You should not need it: it is here in case a figure ever looks wrong or out of date, and trying it
        costs you nothing but a moment.
      </p>
      <p><strong>Nothing you entered is touched.</strong> Your transactions, notes, tags and everything the app has learned from you stay exactly as they are.</p>
      <button type="button" className="btn" aria-disabled={busy} onClick={() => { void rebuild() }}>
        {busy ? 'Recalculating…' : 'Recalculate figures'}
      </button>
      {failed && (
        <div role="alert" className="notice notice-refusal">
          <p>The figures could not be recalculated. Nothing you entered was changed. Try again.</p>
        </div>
      )}
      {cleared !== null && (
        <p role="status">
          {cleared === 0
            ? 'Done. No figures were remembered, so there was nothing to clear. Each screen works its figures out fresh as you open it.'
            : `Done. ${cleared} remembered ${cleared === 1 ? 'figure was' : 'figures were'} cleared. Each screen works its figures out again as you open it.`}
        </p>
      )}
    </>
  )
}

function ReportTable({ report }: { report: RestoreReport }) {
  const rows = Object.entries(report.perTable)
  return (
    <div className="table-wrap">
      <table aria-label="What this restore would do">
        <thead>
          <tr>
            <th scope="col">Table</th>
            <th scope="col" className="num">In backup</th>
            <th scope="col" className="num">New rows</th>
            <th scope="col" className="num">Conflicts</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([name, c]) => (
            <tr key={name}>
              <th scope="row">{name}</th>
              <td className="num">{c.incoming}</td>
              <td className="num">{c.willWrite}</td>
              <td className="num">{c.conflicts}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** How long the backup's object URL stays valid after the click that starts the download. */
const REVOKE_DELAY_MS = 5000

export default function Settings(): ReactNode {
  const [mode, setMode] = useState<Mode>('merge')
  const [busy, setBusy] = useState(false)
  const [exportFailed, setExportFailed] = useState(false)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [refused, setRefused] = useState<RestoreReport | null>(null)
  const [done, setDone] = useState<RestoreReport | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const pickSeq = useRef(0) // a slow read must not overwrite a newer pick
  const modeName = useId()

  function reset() {
    pickSeq.current++
    setPreview(null); setRefused(null); setDone(null)
    if (fileRef.current) fileRef.current.value = ''
  }

  async function download() {
    setExportFailed(false)
    try {
      const bundle = await exportBundle()
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `finance-backup-${today()}.json`
      a.click()
      // Not synchronously: some engines start the download after click() returns, and a revoked URL gives an empty file.
      setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS)
    } catch {
      setExportFailed(true)
    }
  }

  async function onPick(file: File | undefined) {
    const seq = ++pickSeq.current
    setPreview(null); setRefused(null); setDone(null)
    if (!file) return
    let bundle: unknown
    try {
      bundle = JSON.parse(await readText(file))
    } catch (err) {
      if (seq !== pickSeq.current) return
      setRefused(err instanceof SyntaxError
        ? refusal('malformed', 'This file is not valid JSON, so it is not a backup from this app.')
        : refusal('malformed', 'Could not read this file.'))
      return
    }
    if (seq !== pickSeq.current) return
    setBusy(true)
    try {
      const report = await inspectBundle(bundle, mode)
      if (seq !== pickSeq.current) return
      if (report.ok) setPreview({ mode, bundle, report })
      else setRefused(report)
    } finally {
      setBusy(false)
    }
  }

  async function confirm() {
    if (!preview) return
    setBusy(true)
    try {
      // Same mode and same bundle as the preview, by construction (design 27.2).
      const report = await restoreBundle(preview.bundle, preview.mode)
      setPreview(null)
      if (report.ok) setDone(report)
      else setRefused(report)
    } finally {
      setBusy(false)
    }
  }

  const label = (m: Mode) => (m === 'merge' ? 'Merge' : 'Replace')

  return (
    <section className="settings">
      <h1>Settings</h1>

      <div className="notice" role="note">
        <p>
          Your data lives only in this browser, on this device, and browser storage is <strong>not encrypted</strong>.
          Clearing site data or losing the device destroys it. A downloaded backup is a plain, readable file: keep it somewhere private.
        </p>
      </div>

      <Accounts />

      <h2>Back up</h2>
      <p>Download everything as one JSON file.</p>
      <button type="button" className="btn btn-primary" onClick={() => { void download() }}>Download backup</button>
      {exportFailed && (
        <div role="alert" className="notice notice-refusal">
          <p>The backup could not be created. Nothing on this device was changed. Try again, and if it keeps failing, reload the page first.</p>
        </div>
      )}

      <RebuildFigures />

      <h2>Restore</h2>
      <fieldset className="modes" disabled={busy}>
        <legend>How to restore</legend>
        {(['merge', 'replace'] as const).map(m => (
          <label key={m} className="mode">
            <input type="radio" name={modeName} checked={mode === m}
                   onChange={() => { setMode(m); reset() }} />
            <span>
              <strong>{label(m)}</strong>
              {m === 'merge'
                ? ' adds what this device does not have. It never changes a row that is already here.'
                : ' makes this device match the backup.'}
            </span>
          </label>
        ))}
      </fieldset>
      {mode === 'replace' && (
        <div className="notice notice-warn" role="note">
          <p>Replace makes this device match the backup. Everything here that is not in the backup is removed. Download a backup of this device first if you may need it.</p>
        </div>
      )}

      <p><label htmlFor="backup-file">Backup file</label></p>
      <input id="backup-file" ref={fileRef} type="file" accept="application/json,.json" disabled={busy}
             onChange={e => { void onPick(e.target.files?.[0]) }} />
      <p>Choosing a file only checks it. Nothing is written until you confirm.</p>

      {refused && <Refusal report={refused} />}

      {preview && (
        <div className="preview">
          <h3>What this restore would do ({label(preview.mode)})</h3>
          <p>“New rows” counts only rows this device does not have. A row that exists here with different content is a conflict and is left as it is.</p>
          <ReportTable report={preview.report} />
          {preview.report.conflictIds && preview.report.conflictIds.length > 0 && (
            <>
              <p>Transactions whose annotation differs (yours was kept):</p>
              <IdList ids={preview.report.conflictIds} />
            </>
          )}
          {preview.report.conflictRows && preview.report.conflictRows.length > 0 && (
            <details>
              <summary>Every differing row ({preview.report.conflictRows.length})</summary>
              <IdList ids={preview.report.conflictRows} />
            </details>
          )}
          {preview.report.localSettingsKept && <p>Your settings on this device differ from the backup’s and were kept.</p>}
          <h4>Not checked by this preview</h4>
          <ul>{(preview.report.unchecked ?? []).map(u => <li key={u}>{u}</li>)}</ul>
          {preview.mode === 'replace' && (
            <p><strong>Replace removes everything on this device that is not in the backup.</strong></p>
          )}
          <div className="actions">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => { void confirm() }}>
              Confirm {preview.mode}
            </button>
            <button type="button" className="btn" disabled={busy} onClick={reset}>Cancel</button>
          </div>
        </div>
      )}

      {done && (
        <div role="status" className="notice">
          <p><strong>Restore finished.</strong></p>
          <ReportTable report={done} />
        </div>
      )}
    </section>
  )
}
