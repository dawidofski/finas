import { useId, useRef, useState, type ReactNode } from 'react'
import { readCoachKey, removeCoachKey, saveCoachKey } from '../coach/key'

/**
 * Where the owner's DeepSeek key is added and removed. It lives on the Settings screen; the coach screen only asks whether a
 * key exists. The field is uncontrolled, has no `name`, is read once and emptied: the key is never in React state and is
 * never shown back.
 */
export function CoachKey(): ReactNode {
  const [hasKey, setHasKey] = useState(() => readCoachKey() !== null)
  const [problem, setProblem] = useState<string | null>(null)
  const keyRef = useRef<HTMLInputElement>(null)
  const keyId = useId()

  function save() {
    const typed = keyRef.current?.value ?? ''
    if (keyRef.current) keyRef.current.value = ''
    if (typed.trim() === '') { setProblem('Type or paste your key first.'); return }
    if (!saveCoachKey(typed)) { setProblem('This browser did not keep the key. It may be blocking storage for this site.'); return }
    setProblem(null); setHasKey(true)
  }

  function forget() {
    removeCoachKey()
    setHasKey(false); setProblem(null)
  }

  if (hasKey) {
    return (
      <>
        <p>A key is saved in this browser. It is not part of any backup file.</p>
        <div className="actions"><button type="button" className="btn" onClick={forget}>Remove the key</button></div>
      </>
    )
  }
  return (
    <form onSubmit={(e) => { e.preventDefault(); save() }}>
      <p>Only needed for the AI coach. Everything else works without it.</p>
      <details className="tip">
        <summary>Before you save a key</summary>
        <p>
          The key is kept in this browser&rsquo;s storage, which is not encrypted: anything with access to this device or this browser profile can read it.
          Use a key made only for this app, with a spending limit set at DeepSeek. The key is not written into any backup file.
        </p>
      </details>
      <p><label htmlFor={keyId}>DeepSeek key</label></p>
      <input id={keyId} ref={keyRef} type="password" autoComplete="off" spellCheck={false} />
      <div className="actions"><button type="submit" className="btn">Save the key</button></div>
      {problem && <div role="alert" className="notice notice-refusal"><p>{problem}</p></div>}
    </form>
  )
}
