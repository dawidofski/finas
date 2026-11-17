import { useEffect, useId, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { db } from '../../db/db'
import type { AnnotationRow, CategoryRow, ImportRow } from '../../db/schema'
import { formatSpanishDate } from '../../lib/dates'
import { formatEur } from '../../lib/money'
import { commitPreview } from '../../import/commit'
import { ImportError } from '../../import/detect'
import { REVIEW_REASON_TEXT } from '../../import/dedup'
import { buildPreview, type ImportPreview } from '../../import/pipeline'
import { MAX_FILE_BYTES, TOO_LARGE_MESSAGE } from '../../import/xlsx'
import { resumeReload, suspendReload } from '../../reloadHold'

type Edits = ReadonlyMap<number, Partial<AnnotationRow>>

type Stage =
  | { kind: 'idle' }
  | { kind: 'reading' }
  | { kind: 'preview'; preview: ImportPreview; edits: Edits; acknowledged: boolean }
  | { kind: 'saving'; preview: ImportPreview; edits: Edits; acknowledged: boolean }
  | { kind: 'done'; result: ImportRow; label: string }

/** The file is read here, in memory, and handed on as bytes: it is never kept (not in storage, not in state). */
function readBytes(file: File): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer))
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.readAsArrayBuffer(file)
  })
}

/** A refusal is the sentence the pipeline wrote for the owner; anything else is reported without claiming a cause. */
const messageOf = (error: unknown, saving: boolean): string => {
  if (error instanceof ImportError) return error.message
  const detail = error instanceof Error && error.message ? ` (${error.message})` : ''
  return saving
    ? `The import could not be completed, so nothing was saved${detail}. Your records are exactly as they were.`
    : `This file could not be read${detail}. Nothing was changed.`
}

/**
 * Round-ups the import could not tie to a purchase (spec 39.2). Both cases leave the link empty, but they mean different
 * things to the owner: 'ambiguous' is a choice only they can make, 'none' usually means the purchase is in another file.
 */
function roundupMessage(links: ImportPreview['roundupLinks']): string | null {
  const ambiguous = links.filter((l) => l.basis === 'ambiguous').length
  const none = links.filter((l) => l.basis === 'none').length
  if (ambiguous + none === 0) return null
  const count = ambiguous + none
  const parts = [
    ambiguous > 0 ? `${ambiguous} could belong to more than one purchase` : null,
    none > 0 ? `${none} ${none === 1 ? 'names a purchase that is' : 'name purchases that are'} not in this file, perhaps in one you have not imported yet` : null,
  ].filter(Boolean).join(', and ')
  return `${count} ${count === 1 ? 'round-up' : 'round-ups'} could not be matched to a purchase: ${parts}. ` +
    'You can import anyway. Afterwards, open the round-up in Transactions and choose its purchase.'
}

function gapMessage(gap: ImportPreview['gap']): string {
  switch (gap.kind) {
    case 'first-import': return 'This is the first file for this account, so there is nothing earlier to join it to.'
    case 'contiguous': return 'This file joins your earlier imports with nothing missing in between.'
    case 'overlap': return 'This file covers days you have already imported.'
    case 'gap':
      return `Some movements may be missing between ${formatSpanishDate(gap.reExportFrom)} and ${formatSpanishDate(gap.reExportTo)}: the balances differ by ${formatEur(Math.abs(gap.balanceDelta))}. ` +
        'Exporting that period from ING and importing it too would fill the hole. You can still import this file now.'
    case 'detached':
      return `This file cannot be joined to your earlier imports with certainty. Exporting ${formatSpanishDate(gap.uncoveredFrom)} to ${formatSpanishDate(gap.uncoveredTo)} from ING would settle it. You can still import this file now.`
  }
}

const PAGE = 100

export default function Import(): ReactNode {
  const [stage, setStage] = useState<Stage>({ kind: 'idle' })
  const [error, setError] = useState<string | null>(null)
  const [categories, setCategories] = useState<CategoryRow[]>([])
  const [dragging, setDragging] = useState(false)
  const [shown, setShown] = useState(PAGE)
  const fileRef = useRef<HTMLInputElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const pickSeq = useRef(0) // a slow read must not overwrite a newer pick
  const inputId = useId()
  const acknowledgeId = useId()

  // Hold any service-worker reload while a file is being read, previewed or saved: a reload discards the preview
  // and every correction typed into it.
  const holding = stage.kind === 'reading' || stage.kind === 'preview' || stage.kind === 'saving'
  useEffect(() => {
    if (!holding) return
    suspendReload()
    return resumeReload
  }, [holding])

  useEffect(() => {
    let live = true
    db.categories.toArray().then(
      (all) => { if (live) setCategories(all.filter((c) => c.parentId !== null).sort((a, b) => a.name.localeCompare(b.name))) },
      () => { /* the picker is an extra: the preview still works without it */ },
    )
    return () => { live = false }
  }, [])

  // Keyboard and screen-reader users land on the result of the action they just took.
  useEffect(() => { if (stage.kind === 'preview' || stage.kind === 'done') headingRef.current?.focus() }, [stage.kind])

  function reset() {
    pickSeq.current++
    setStage({ kind: 'idle' }); setError(null); setShown(PAGE)
    if (fileRef.current) fileRef.current.value = ''
  }

  async function onFile(file: File | undefined) {
    if (!file || stage.kind === 'saving') return
    const seq = ++pickSeq.current
    setError(null); setShown(PAGE)
    if (file.size > MAX_FILE_BYTES) { setStage({ kind: 'idle' }); setError(TOO_LARGE_MESSAGE); return }
    setStage({ kind: 'reading' })
    try {
      const preview = await buildPreview(await readBytes(file), file.name)
      if (seq !== pickSeq.current) return
      setStage({ kind: 'preview', preview, edits: new Map(), acknowledged: false })
    } catch (e) {
      if (seq !== pickSeq.current) return
      setStage({ kind: 'idle' })
      setError(messageOf(e, false))
    } finally {
      if (fileRef.current) fileRef.current.value = '' // choosing the same file again must fire a change
    }
  }

  async function confirm() {
    if (stage.kind !== 'preview') return
    const { preview, edits, acknowledged } = stage
    setStage({ kind: 'saving', preview, edits, acknowledged })
    setError(null)
    try {
      const result = await commitPreview(preview, new Map(edits), { acknowledgeDivergence: acknowledged })
      setStage({ kind: 'done', result, label: preview.accountLabel })
    } catch (e) {
      setStage({ kind: 'preview', preview, edits, acknowledged })
      setError(messageOf(e, true))
    }
  }

  function edit(index: number, patch: Partial<AnnotationRow>) {
    if (stage.kind !== 'preview') return
    const next = new Map(stage.edits)
    const merged: Partial<AnnotationRow> = { ...next.get(index), ...patch }
    // An emptied field is no correction at all.
    const cleaned = Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== null && v !== '' && v !== undefined))
    if (Object.keys(cleaned).length === 0) next.delete(index)
    else next.set(index, cleaned)
    setStage({ ...stage, edits: next })
  }

  function onDrop(e: DragEvent<HTMLElement>) {
    e.preventDefault()
    setDragging(false)
    void onFile(e.dataTransfer.files[0])
  }

  const busy = stage.kind === 'reading' || stage.kind === 'saving'
  const showPicker = stage.kind === 'idle' || stage.kind === 'reading'

  return (
    <section className="import">
      <h1>Import</h1>

      {showPicker && (
        <>
          <p>Choose the Excel file you exported from ING. It is read in this browser and never leaves it, and it is not kept: only the transactions are.</p>
          <div
            className={`dropzone${dragging ? ' dropzone-active' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
          >
            <p><label htmlFor={inputId}>ING movements file (.xlsx)</label></p>
            <input id={inputId} ref={fileRef} type="file" accept=".xlsx,.xls,.pdf,.csv" disabled={busy}
                   onChange={(e) => { void onFile(e.target.files?.[0]) }} />
            <p>You can also drop the file here. Choosing a file only checks it: nothing is saved until you confirm.</p>
          </div>
          {stage.kind === 'reading' && <p role="status">Reading the file…</p>}
        </>
      )}

      {error && <div role="alert" className="notice notice-refusal"><p>{error}</p></div>}

      {(stage.kind === 'preview' || stage.kind === 'saving') && (
        <PreviewView
          stage={stage} categories={categories} shown={shown} onMore={() => setShown((n) => n + PAGE)}
          onEdit={edit} headingRef={headingRef} acknowledgeId={acknowledgeId}
          onAcknowledge={(acknowledged) => stage.kind === 'preview' && setStage({ ...stage, acknowledged })}
          onConfirm={() => { void confirm() }} onCancel={reset}
        />
      )}

      {stage.kind === 'done' && (
        <div role="status" className="notice">
          <h2 ref={headingRef} tabIndex={-1}>Import finished</h2>
          <p>
            {stage.result.rowsNew} new {stage.result.rowsNew === 1 ? 'transaction was' : 'transactions were'} added to {stage.label}
            {stage.result.rowsDuplicate > 0 && `; ${stage.result.rowsDuplicate} you already had ${stage.result.rowsDuplicate === 1 ? 'was' : 'were'} skipped`}
            {stage.result.rowsNeedsReview > 0 && `; ${stage.result.rowsNeedsReview} ${stage.result.rowsNeedsReview === 1 ? 'was' : 'were'} left out for you to decide`}.
          </p>
          <div className="actions"><button type="button" className="btn" onClick={reset}>Import another file</button></div>
        </div>
      )}
    </section>
  )
}

interface PreviewViewProps {
  stage: Extract<Stage, { kind: 'preview' | 'saving' }>
  categories: CategoryRow[]
  shown: number
  onMore: () => void
  onEdit: (index: number, patch: Partial<AnnotationRow>) => void
  onAcknowledge: (value: boolean) => void
  onConfirm: () => void
  onCancel: () => void
  headingRef: React.RefObject<HTMLHeadingElement>
  acknowledgeId: string
}

function PreviewView(props: PreviewViewProps): ReactNode {
  const { stage, categories, shown, headingRef, acknowledgeId } = props
  const { preview, edits, acknowledged } = stage
  const saving = stage.kind === 'saving'
  const indexed = preview.rows.map((entry, index) => ({ ...entry, index }))
  const fresh = indexed.filter((r) => r.verdict.kind === 'new')
  const duplicates = indexed.filter((r) => r.verdict.kind === 'duplicate')
  const review = indexed.filter((r) => r.verdict.kind === 'review')
  const blocked = saving || (preview.divergent && !acknowledged)

  return (
    <div className="preview">
      <h2 ref={headingRef} tabIndex={-1}>Check before importing</h2>
      <dl className="facts">
        <dt>Account</dt>
        <dd>{preview.accountLabel}{preview.isNewAccount ? ' (new to this app)' : ''}</dd>
        <dt>File</dt>
        <dd>{preview.filename}</dd>
        <dt>Covers</dt>
        <dd>{formatSpanishDate(preview.coverageStart)} to {formatSpanishDate(preview.coverageEnd)}</dd>
        <dt>Rows</dt>
        <dd>{preview.rows.length} found: {fresh.length} new, {duplicates.length} already imported, {review.length} not imported for a reason given below, 0 unreadable</dd>
      </dl>

      <div className="notice" role="note">
        <p>{preview.balance.ok
          ? 'The running balance adds up on every row.'
          : `The running balance does not add up in ${preview.balance.breaks.length} ${preview.balance.breaks.length === 1 ? 'place' : 'places'}, which means a row's balance differs from what the rows around it imply. The import is still possible.`}</p>
        <p>{gapMessage(preview.gap)}</p>
        {roundupMessage(preview.roundupLinks) && <p>{roundupMessage(preview.roundupLinks)}</p>}
        <p>
          Your name was replaced with [redacted] in {preview.scrub.descriptionsScrubbed} {preview.scrub.descriptionsScrubbed === 1 ? 'description' : 'descriptions'}.
          The account number is kept only as a code that recognises this account next time{preview.last4 ? `, plus its last four digits (${preview.last4})` : ''}.
        </p>
      </div>

      {preview.divergent && (
        <div className="notice notice-warn" role="alert">
          <p>
            This file covers days you have already imported, but none of its transactions match what you have. It may come from a different account or a different history.
          </p>
          <label htmlFor={acknowledgeId} className="mode">
            <input id={acknowledgeId} type="checkbox" checked={acknowledged} disabled={saving}
                   onChange={(e) => props.onAcknowledge(e.target.checked)} />
            <span>I have checked, and I want to import it anyway</span>
          </label>
        </div>
      )}

      {preview.unknownPairs.length > 0 && (
        <div className="notice" role="note">
          <p>These ING categories are new to this app. They will be added and marked for you to review:</p>
          <ul>{preview.unknownPairs.map((p) => <li key={`${p.ing}/${p.ingSub}`}>{p.ing} / {p.ingSub}</li>)}</ul>
        </div>
      )}

      <h3>New ({fresh.length})</h3>
      {fresh.length === 0 ? <p>Nothing new.</p> : (
        <div className="table-wrap">
          <table aria-label="New transactions">
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Description</th>
                <th scope="col" className="num">Amount</th>
                <th scope="col">Suggestion</th>
                <th scope="col">Your correction</th>
              </tr>
            </thead>
            <tbody>
              {fresh.slice(0, shown).map(({ row, index, suggestion }) => {
                const current = edits.get(index)
                const suggested = suggestion === null ? undefined : categories.find((c) => c.id === suggestion.categoryId)
                const accepted = suggestion !== null && current?.categoryId === suggestion.categoryId
                return (
                  <tr key={index}>
                    <td className="nowrap">{formatSpanishDate(row.valueDate)}</td>
                    <td>{row.description}{row.comment ? <><br /><small>{row.comment}</small></> : null}</td>
                    <td className="num nowrap">{formatEur(row.amountCents)}</td>
                    <td>
                      {suggestion !== null && suggested !== undefined && (
                        <>
                          <strong>{suggested.name}</strong>{' '}
                          {suggestion.tier === 'classifier' && <small>(a guess, {suggestion.confidence}% sure)</small>}
                          <br /><small>{suggestion.because}</small>
                          <br />
                          {/* Nothing is written by showing this. Accepting only fills the row's correction; the import writes it. */}
                          <button type="button" className="btn" disabled={saving || accepted}
                                  aria-label={`Use ${suggested.name} for ${formatSpanishDate(row.valueDate)} ${row.description}`}
                                  onClick={() => props.onEdit(index, { categoryId: suggestion.categoryId })}>
                            {accepted ? 'Chosen' : 'Use this'}
                          </button>
                        </>
                      )}
                    </td>
                    <td>
                      <select aria-label={`Category for ${formatSpanishDate(row.valueDate)} ${row.description}`} disabled={saving}
                              value={current?.categoryId ?? ''}
                              onChange={(e) => props.onEdit(index, { categoryId: e.target.value || null })}>
                        <option value="">As ING lists it</option>
                        {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
                      <input type="text" aria-label={`Note for ${formatSpanishDate(row.valueDate)} ${row.description}`} placeholder="Note" disabled={saving}
                             value={current?.note ?? ''} onChange={(e) => props.onEdit(index, { note: e.target.value || null })} />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      {fresh.length > shown && (
        <p><button type="button" className="btn" onClick={props.onMore}>Show {Math.min(PAGE, fresh.length - shown)} more</button></p>
      )}

      {review.length > 0 && (
        <>
          <h3>Not imported ({review.length})</h3>
          <p>These were left out of this import. Each line says why.</p>
          <ul className="review-list">
            {review.map(({ row, verdict, index }) => (
              <li key={index}>
                <strong>{formatSpanishDate(row.valueDate)} {row.description} {formatEur(row.amountCents)}</strong>
                <br />{verdict.kind === 'review' ? REVIEW_REASON_TEXT[verdict.reason] : null}
              </li>
            ))}
          </ul>
        </>
      )}

      {duplicates.length > 0 && (
        <details>
          <summary>Already imported ({duplicates.length}), skipped</summary>
          <ul className="review-list">
            {duplicates.slice(0, shown).map(({ row, index }) => (
              <li key={index}>{formatSpanishDate(row.valueDate)} {row.description} {formatEur(row.amountCents)}</li>
            ))}
          </ul>
          {duplicates.length > shown && (
            // Never a silent cut: say how many are listed, and let the owner see the rest.
            <p>
              Showing {shown} of {duplicates.length}.{' '}
              <button type="button" className="btn" onClick={props.onMore}>Show {Math.min(PAGE, duplicates.length - shown)} more</button>
            </p>
          )}
        </details>
      )}

      <div className="actions">
        <button type="button" className="btn btn-primary" disabled={blocked} onClick={props.onConfirm}>
          {saving ? 'Importing…' : `Import ${fresh.length} new ${fresh.length === 1 ? 'transaction' : 'transactions'}`}
        </button>
        <button type="button" className="btn" disabled={saving} onClick={props.onCancel}>Cancel</button>
      </div>
      {edits.size > 0 && <p role="status">{edits.size} {edits.size === 1 ? 'correction' : 'corrections'} will be saved with the import.</p>}
    </div>
  )
}
