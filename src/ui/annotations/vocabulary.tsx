import { useEffect, useState, type ReactNode } from 'react'

/**
 * Shared by the three annotation controls. The controls are controlled (`value` + `onChange`) and own no persistence:
 * they only READ the owner's vocabulary, so a queue that saves differently from the editor can mount them unchanged.
 */

/**
 * Reads a vocabulary table once on mount. `rows` is null while loading. A failed read is its own state (`failed`), never
 * an empty list: "could not load" must not look like "the owner's value is not in the vocabulary", or a transient read
 * error would invite a tap that clears a real annotation. The reader runs at call time, never at module scope.
 */
export function useVocabulary<T>(read: () => Promise<T[]>): { rows: T[] | null; failed: boolean } {
  const [state, setState] = useState<{ rows: T[] | null; failed: boolean }>({ rows: null, failed: false })
  useEffect(() => {
    let live = true
    Promise.resolve().then(read).then((r) => { if (live) setState({ rows: r, failed: false }) }, () => { if (live) setState({ rows: null, failed: true }) })
    return () => { live = false }
    // The vocabulary is read when the control mounts; `read` is a stable inline reader.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return state
}

interface Vocabulary { id: string; archived: boolean }

/**
 * What the picker offers: every live entry, plus the archived entry the transaction already carries. An archived entry
 * is hidden from choosing but never from showing (§21.3): its id is still referenced by past annotations, so dropping
 * it here would silently render the owner's history as unlabelled.
 */
export function visibleOptions<T extends Vocabulary>(all: readonly T[], value: string | null): T[] {
  return all.filter((o) => !o.archived || o.id === value)
}

/**
 * Stands in for a control whose vocabulary is not available (loading, or failed): a value is recorded but cannot be
 * labelled, so say only that. Not interactive, with the same tick and heavy border as a selected choice. The rule:
 * a control only offers to clear a value it is currently able to display.
 */
export function RecordedMarker({ children }: { children: ReactNode }): ReactNode {
  return <span className="choice choice-recorded"><span className="choice-tick" aria-hidden="true">✓</span>{children}</span>
}

interface ChoiceProps {
  selected: boolean
  disabled?: boolean
  onPick: () => void
  children: ReactNode
  className: string
}

/** A toggle button. The selected state is announced (aria-pressed) and drawn with a tick and a heavier border, never colour alone. */
export function Choice({ selected, disabled, onPick, children, className }: ChoiceProps): ReactNode {
  return (
    <button type="button" className={`${className} choice`} aria-pressed={selected} disabled={disabled} onClick={onPick}>
      {selected && <span className="choice-tick" aria-hidden="true">✓</span>}
      {children}
    </button>
  )
}
