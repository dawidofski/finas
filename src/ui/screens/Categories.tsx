import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { db } from '../../db/db'
import type { CategoryKind, CategoryRow, CategoryRule } from '../../db/schema'
import { addCategory, addRule, listRules, removeCategory, removeRule, type OwnerKind } from '../../categories/store'
import './categories.css'

const KIND_WORDS: Record<CategoryKind, string> = {
  essential: 'Essentials',
  discretionary: 'Wants',
  savings: 'Savings and investments',
  internal: 'Moves between your accounts',
  income: 'Income',
}

const OWNER_KINDS: ReadonlyArray<OwnerKind> = ['essential', 'discretionary', 'savings']

interface Loaded { leaves: CategoryRow[]; rules: CategoryRule[] }

async function load(): Promise<Loaded> {
  const [all, rules] = await Promise.all([db.categories.toArray(), listRules()])
  const leaves = all.filter((c) => c.parentId !== null).sort((a, b) => a.name.localeCompare(b.name))
  return { leaves, rules }
}

const messageOf = (err: unknown): string => (err instanceof Error && err.message !== '' ? err.message : 'That could not be saved. Nothing was changed.')

export default function Categories(): ReactNode {
  const [data, setData] = useState<Loaded | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [ruleText, setRuleText] = useState('')
  const [ruleTarget, setRuleTarget] = useState('')
  const [name, setName] = useState('')
  const [kind, setKind] = useState<OwnerKind>('discretionary')

  const reload = useCallback(async () => {
    try { setData(await load()) } catch (err) { setError(messageOf(err)) }
  }, [])
  useEffect(() => { void reload() }, [reload])

  /** Runs one change, shows a refusal in words, and reloads both lists afterwards. */
  const act = async (change: () => Promise<void>, after?: () => void): Promise<void> => {
    setBusy(true); setError(null)
    try { await change(); after?.() } catch (err) { setError(messageOf(err)) }
    await reload()
    setBusy(false)
  }

  if (data === null) {
    return (
      <section className="categories">
        <h1>Categories</h1>
        {error !== null ? <div role="alert" className="notice notice-refusal"><p>{error}</p></div> : <p className="muted">Loading your categories…</p>}
      </section>
    )
  }

  const nameOf = (id: string): string => data.leaves.find((c) => c.id === id)?.name ?? 'a category that was removed'
  const target = ruleTarget !== '' ? ruleTarget : (data.leaves[0]?.id ?? '')

  const submitRule = (e: FormEvent) => {
    e.preventDefault()
    void act(() => addRule(ruleText, target), () => setRuleText(''))
  }
  const submitCategory = (e: FormEvent) => {
    e.preventDefault()
    void act(async () => { await addCategory(name, kind) }, () => setName(''))
  }

  return (
    <section className="categories">
      <h1>Categories</h1>
      {error !== null && <div role="alert" className="notice notice-refusal"><p>{error}</p></div>}

      <div className="card cat-card">
        <h2>Your rules</h2>
        <details className="tip">
          <summary>How rules work</summary>
          <p>Rules apply to everything already imported and everything imported later, and a category you set by hand on a transaction always wins.</p>
        </details>
        {data.rules.length === 0
          ? <p className="muted">You have no rules yet.</p>
          : (
            <ul className="cat-list" aria-label="Your rules">
              {data.rules.map((r) => (
                <li key={r.id} className="cat-row">
                  <span className="cat-text"><q>{r.contains}</q> → {nameOf(r.categoryId)}</span>
                  <button type="button" className="btn" disabled={busy} aria-label={`Remove rule: ${r.contains}`}
                          onClick={() => void act(() => removeRule(r.id))}>Remove</button>
                </li>
              ))}
            </ul>
          )}
        <form onSubmit={submitRule} aria-label="Add a rule">
          <label>When the description contains
            <input type="text" value={ruleText} onChange={(e) => setRuleText(e.target.value)} />
          </label>
          <label>File it under
            <select value={target} onChange={(e) => setRuleTarget(e.target.value)}>
              {data.leaves.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <div className="actions">
            <button type="submit" className="btn btn-primary" disabled={busy}>Add rule</button>
          </div>
        </form>
      </div>

      <div className="card cat-card">
        <h2>Categories</h2>
        <ul className="cat-list" aria-label="All categories">
          {data.leaves.map((c) => (
            <li key={c.id} className="cat-row">
              <span className="cat-text">
                {c.isUserCreated ? <q>{c.name}</q> : c.name}
                <span className="muted cat-kind"> {c.kind === null ? '' : KIND_WORDS[c.kind]}</span>
              </span>
              {c.isUserCreated && confirming !== c.id && (
                <button type="button" className="btn" disabled={busy} aria-label={`Remove category: ${c.name}`}
                        onClick={() => setConfirming(c.id)}>Remove</button>
              )}
              {c.isUserCreated && confirming === c.id && (
                <div className="cat-confirm">
                  <p>Purchases filed under <q>{c.name}</q> go back to the bank&apos;s own category. Rules and budget lines for it are removed too.</p>
                  <div className="actions">
                    <button type="button" className="btn btn-primary" disabled={busy}
                            onClick={() => void act(() => removeCategory(c.id), () => setConfirming(null))}>Yes, remove it</button>
                    <button type="button" className="btn" disabled={busy} onClick={() => setConfirming(null)}>Keep it</button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
        <form onSubmit={submitCategory} aria-label="Add a category">
          <label>Name
            <input type="text" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>Kind
            <select value={kind} onChange={(e) => setKind(e.target.value as OwnerKind)}>
              {OWNER_KINDS.map((k) => <option key={k} value={k}>{KIND_WORDS[k]}</option>)}
            </select>
          </label>
          <div className="actions">
            <button type="submit" className="btn btn-primary" disabled={busy}>Add category</button>
          </div>
        </form>
      </div>
    </section>
  )
}
