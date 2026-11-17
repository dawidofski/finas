import type { ReactNode } from 'react'
import { db } from '../../db/db'
import { Choice, RecordedMarker, useVocabulary, visibleOptions } from './vocabulary'

interface Props {
  /** The mood id on the transaction, or null for none. */
  value: string | null
  /** Called with the tapped mood's id, or null when the owner clears it (tap the chosen mood again, or "Clear mood"). */
  onChange: (moodId: string | null) => void
  disabled?: boolean
}

/**
 * A one-tap row of emoji (§15). Optional and clearable. A mood with no valence ('Other', custom) is an ordinary,
 * selectable mood: null valence is by design, not missing data.
 */
export default function MoodRow({ value, onChange, disabled }: Props): ReactNode {
  const { rows: moods, failed } = useVocabulary(() => db.moods.orderBy('order').toArray())
  const options = moods ? visibleOptions(moods, value) : []
  // An id the vocabulary no longer holds at all still has to be clearable, and is never shown as a raw id.
  const dangling = moods !== null && value !== null && !moods.some((m) => m.id === value)

  return (
    <fieldset className="annot-group">
      <legend>How did it feel? <span className="annot-optional">Optional</span></legend>
      {failed && <p role="note">The list of moods could not be loaded, so any mood you set is left exactly as it is.</p>}
      {moods === null && value !== null && <RecordedMarker>Mood recorded</RecordedMarker>}
      {!failed && <div className="mood-row">
        {options.map((m) => (
          <Choice key={m.id} className="mood-btn" selected={m.id === value} disabled={disabled}
                  onPick={() => onChange(m.id === value ? null : m.id)}>
            <span className="mood-emoji" aria-hidden="true">{m.emoji}</span>
            <span className="mood-label">{m.label}{m.archived ? ' (retired)' : ''}</span>
          </Choice>
        ))}
        {dangling && (
          <Choice className="mood-btn" selected disabled={disabled} onPick={() => onChange(null)}>
            <span className="mood-emoji" aria-hidden="true">💭</span>
            <span className="mood-label">Earlier mood</span>
          </Choice>
        )}
      </div>}
      {value !== null && moods !== null && (
        <button type="button" className="btn annot-clear" disabled={disabled} onClick={() => onChange(null)}>Clear mood</button>
      )}
    </fieldset>
  )
}
