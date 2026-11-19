import { useId, useRef, useState, type ReactNode } from 'react'
import { COACH_MONTHS, coachContext } from '../../coach/context'
import { readCoachKey, removeCoachKey, saveCoachKey } from '../../coach/key'
import { QUESTION_MAX_CHARS, buildRequest, questionText, sendRequest, type SendResult } from '../../coach/request'

/** What was prepared for one question: the exact request text that would be sent, and the same content as plain text. */
interface Prepared { body: string; plain: string; months: number }

type Outcome = SendResult | { ok: false; kind: 'no-data' } | { ok: false; kind: 'read-failed' }

function failureText(o: Exclude<Outcome, { ok: true }>): string {
  switch (o.kind) {
    case 'blocked':
      return 'The question did not get through, and nothing was received. The app cannot tell what stopped it: for example, your browser may not have allowed this page to contact DeepSeek directly, this device may be offline, or the saved key may hold a character that cannot be sent. You can copy your question and totals below and paste them into DeepSeek’s own chat instead.'
    case 'refused':
      return `DeepSeek answered with an error (number ${o.status}) and gave no reply. Number 401 is the one DeepSeek gives for a key it does not accept, and 402 for an account with no balance left.`
    case 'unreadable':
      return 'DeepSeek answered, but there was no text in the answer for this app to show.'
    case 'no-data':
      return 'There is no completed month with records yet, so there are no totals to send. Import a statement first, and come back once a month has ended.'
    case 'read-failed':
      return 'Your monthly totals could not be read, so nothing was prepared and nothing was sent.'
  }
}

/**
 * The optional AI coach (design 13.5). Off until the owner saves a key of their own. Nothing is sent on load, on typing or
 * on preparing: the only request this screen can make is the one behind "Send this to DeepSeek", and the text it sends is
 * the text shown above that button, character for character (`prepared.body` is built once and passed on unchanged).
 * The question cannot be edited while a text is being prepared or sent (the field is read-only then), and any edit
 * discards what was prepared, so the text shown always holds the question as it stands in the field. Discard is not
 * offered while a send is under way: a request that has left cannot be called back, and the screen does not pretend it can.
 *
 * Only monthly totals are ever included. Sending transactions or descriptions is not offered at all.
 * The key field is uncontrolled, has no `name`, is read once and emptied: the key is never in React state.
 */
export default function Coach({ today, computedAt }: { today: string; computedAt: number }): ReactNode {
  const [hasKey, setHasKey] = useState(() => readCoachKey() !== null)
  const [keyProblem, setKeyProblem] = useState<string | null>(null)
  const [question, setQuestion] = useState('')
  const [prepared, setPrepared] = useState<Prepared | null>(null)
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [copied, setCopied] = useState<'yes' | 'no' | null>(null)
  const keyRef = useRef<HTMLInputElement>(null)
  const seq = useRef(0)
  const keyId = useId()
  const questionId = useId()

  function saveKey() {
    const typed = keyRef.current?.value ?? ''
    if (keyRef.current) keyRef.current.value = ''
    if (typed.trim() === '') { setKeyProblem('Type or paste your key first.'); return }
    if (!saveCoachKey(typed)) { setKeyProblem('This browser did not keep the key. It may be blocking storage for this site.'); return }
    setKeyProblem(null); setHasKey(true)
  }

  function forgetKey() {
    removeCoachKey()
    setHasKey(false); setKeyProblem(null)
  }

  function discard() {
    seq.current++
    setPrepared(null); setOutcome(null); setCopied(null); setBusy(false)
  }

  async function prepare() {
    if (busy || question.trim() === '') return
    const mine = ++seq.current
    setPrepared(null); setOutcome(null); setCopied(null); setBusy(true)
    try {
      const months = await coachContext(today, computedAt)
      if (mine !== seq.current) return
      if (months.length === 0) { setOutcome({ ok: false, kind: 'no-data' }); return }
      setPrepared({ body: buildRequest(question, months), plain: questionText(question, months), months: months.length })
    } catch {
      if (mine === seq.current) setOutcome({ ok: false, kind: 'read-failed' })
    } finally {
      if (mine === seq.current) setBusy(false)
    }
  }

  async function send() {
    const key = readCoachKey()
    if (busy || !prepared || key === null) return
    const mine = seq.current
    setOutcome(null); setBusy(true)
    const result = await sendRequest(prepared.body, key)
    if (mine !== seq.current) return
    setOutcome(result); setBusy(false)
  }

  async function copy() {
    if (!prepared) return
    try { await navigator.clipboard.writeText(prepared.plain); setCopied('yes') } catch { setCopied('no') }
  }

  return (
    <section className="coach">
      <h1>AI coach</h1>
      <p>
        An optional extra: you can put a question about your money to DeepSeek, an outside AI service. Everything else in this app works without it,
        and it stays off until you add a key of your own.
      </p>
      <div className="notice" role="note">
        <p>
          <strong>This is the one place where something can leave this device.</strong> It happens only when you press the send button, and the exact
          text is shown to you first. What is sent is your question, exactly as you typed it, and the totals of up to {COACH_MONTHS} completed months:
          income, spending, saving and what was left over. The app adds no transaction, description, shop, person, account number or note to it.
        </p>
      </div>

      <h2>Your DeepSeek key</h2>
      {hasKey ? (
        <>
          <p>A key is saved in this browser. It is not part of any backup file.</p>
          <div className="actions"><button type="button" className="btn" onClick={forgetKey}>Remove the key</button></div>
        </>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); saveKey() }}>
          <div className="notice notice-warn" role="note">
            <p>
              The key is kept in this browser&rsquo;s storage, which is not encrypted: anything with access to this device or this browser profile can read it.
              Use a key made only for this app, with a spending limit set at DeepSeek. The key is not written into any backup file.
            </p>
          </div>
          <p><label htmlFor={keyId}>DeepSeek key</label></p>
          <input id={keyId} ref={keyRef} type="password" autoComplete="off" spellCheck={false} />
          <div className="actions"><button type="submit" className="btn">Save the key</button></div>
          {keyProblem && <div role="alert" className="notice notice-refusal"><p>{keyProblem}</p></div>}
        </form>
      )}

      <h2>Your question</h2>
      <form onSubmit={(e) => { e.preventDefault(); void prepare() }}>
        <p><label htmlFor={questionId}>What would you like to ask? It is sent as you type it, so leave out anything you would not want to share.</label></p>
        <textarea
          id={questionId} rows={4} maxLength={QUESTION_MAX_CHARS} value={question}
          readOnly={busy}
          onChange={(e) => { if (busy) return; setQuestion(e.target.value); discard() }}
        />
        <div className="actions">
          <button type="submit" className="btn btn-primary" aria-disabled={busy || question.trim() === ''}>Show what would be sent</button>
        </div>
      </form>

      {prepared && (
        <div className="preview">
          <h2>Exactly what would be sent</h2>
          <p>
            This is the complete text, with nothing added afterwards. It holds your question and the totals of {prepared.months} {prepared.months === 1 ? 'month' : 'months'}.
            Nothing has been sent yet.
          </p>
          <pre className="coach-payload" tabIndex={0} aria-label="The exact text that would be sent">{prepared.body}</pre>
          <div className="actions">
            {hasKey && (
              <button type="button" className="btn btn-primary" aria-disabled={busy} onClick={() => { void send() }}>
                {busy ? 'Sending…' : 'Send this to DeepSeek'}
              </button>
            )}
            <button type="button" className="btn" onClick={() => { void copy() }}>Copy my question and totals</button>
            {!busy && <button type="button" className="btn" onClick={discard}>Discard</button>}
          </div>
          {!hasKey && <p>Sending from here needs a key, which you have not added. You can still copy your question and totals and paste them into DeepSeek&rsquo;s own chat.</p>}
          {copied === 'yes' && <p role="status">Copied. Paste it into DeepSeek&rsquo;s own chat. Nothing was sent from this app.</p>}
          {copied === 'no' && (
            <div role="alert" className="notice notice-refusal">
              <p>This browser did not allow copying. You can select the text below by hand.</p>
            </div>
          )}
          <details>
            <summary>The same content as plain text</summary>
            <pre className="coach-payload">{prepared.plain}</pre>
          </details>
        </div>
      )}

      {outcome && !outcome.ok && <div role="alert" className="notice notice-refusal"><p>{failureText(outcome)}</p></div>}

      {outcome && outcome.ok && (
        <>
          <h2>DeepSeek&rsquo;s reply</h2>
          <p>
            The text below was written by DeepSeek, not by this app, and it can be wrong. Check any figure in it against your own screens,
            and treat it as a suggestion to think about, not as financial advice.
          </p>
          <div className="coach-reply">{outcome.reply}</div>
        </>
      )}
    </section>
  )
}
