import type { ReactNode } from 'react'
import { Choice } from './vocabulary'

interface Props {
  /** true = worth it, false = not worth it, null = not rated. */
  value: boolean | null
  onChange: (worthwhile: boolean | null) => void
  disabled?: boolean
  /** Offer "Not rated". A queue going forward has nothing to clear, so it hides the button rather than show one that does nothing. */
  allowClear?: boolean
}

/**
 * Three buttons. "Not rated" is the cleared state and the honest default: it says nothing has been answered, not
 * that the owner is unsure, and nothing here asks for an answer.
 */
export default function WorthwhileButtons({ value, onChange, disabled, allowClear = true }: Props): ReactNode {
  return (
    <fieldset className="annot-group">
      <legend>Worth it? <span className="annot-optional">Optional</span></legend>
      <div className="worth-row">
        <Choice className="worth-btn" selected={value === true} disabled={disabled} onPick={() => onChange(true)}>Worth it</Choice>
        <Choice className="worth-btn" selected={value === false} disabled={disabled} onPick={() => onChange(false)}>Not worth it</Choice>
        {allowClear && <Choice className="worth-btn" selected={value === null} disabled={disabled} onPick={() => onChange(null)}>Not rated</Choice>}
      </div>
    </fieldset>
  )
}
