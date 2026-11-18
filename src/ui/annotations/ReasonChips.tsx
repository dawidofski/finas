import type { ReactNode } from 'react'
import { db } from '../../db/db'
import { Choice, RecordedMarker, useVocabulary, visibleOptions } from './vocabulary'

interface Props {
  /** The purchase-reason id on the transaction, or null for none. */
  value: string | null
  /** The tapped reason's id, or null when cleared (tap the chosen reason again, or "Clear reason"). */
  onChange: (reasonId: string | null) => void
  disabled?: boolean
}

/** Why the owner bought it, as chips. Optional and clearable; an archived reason already on the transaction still shows. */
export default function ReasonChips({ value, onChange, disabled }: Props): ReactNode {
  const { rows: reasons, failed } = useVocabulary(() => db.purchaseReasons.orderBy('order').toArray())
  const options = reasons ? visibleOptions(reasons, value) : []
  const dangling = reasons !== null && value !== null && !reasons.some((r) => r.id === value)

  return (
    <fieldset className="annot-group">
      <legend>What was the reason for buying it? <span className="annot-optional">Optional</span></legend>
      {failed && <p role="note">The list of reasons could not be loaded, so any reason you set is left exactly as it is.</p>}
      {reasons === null && value !== null && <RecordedMarker>Reason recorded</RecordedMarker>}
      {!failed && <div className="chip-row">
        {options.map((r) => (
          <Choice key={r.id} className="chip" selected={r.id === value} disabled={disabled}
                  onPick={() => onChange(r.id === value ? null : r.id)}>
            {r.label}{r.archived ? ' (retired)' : ''}
          </Choice>
        ))}
        {dangling && <Choice className="chip" selected disabled={disabled} onPick={() => onChange(null)}>Earlier reason</Choice>}
      </div>}
      {value !== null && reasons !== null && (
        <button type="button" className="btn annot-clear" disabled={disabled} onClick={() => onChange(null)}>Clear reason</button>
      )}
    </fieldset>
  )
}
