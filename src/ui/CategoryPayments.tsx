import { useState, type ReactNode } from 'react'
import { liveTransactionsBetween } from '../analysis/transactionsInRange'
import { spendsOf } from '../battery/rank'
import { resolveMany, writeAnnotation, type ResolvedTransaction } from '../db/annotations'
import type { CategoryRow } from '../db/schema'
import { formatSpanishDate } from '../lib/dates'
import { formatEur } from '../lib/money'

/**
 * The purchases of one month filed under one category, opened from a budget line, each with a control to file it somewhere
 * else. `categoryId` '' means purchases with no category at all. Nothing is read until the owner opens it. A purchase is
 * what the rest of the app calls one (spendsOf): money out that counts as spending, never a transfer between own accounts.
 *
 * Re-filing writes the owner's category on that purchase (it then wins over any rule and over the bank's category) and
 * tells the screen above to work its figures out again.
 */
export function CategoryPayments({ categoryId, label, month, categories, onChanged }: {
  categoryId: string; label: string; month: string; categories: readonly CategoryRow[]; onChanged: () => void
}): ReactNode {
  const [rows, setRows] = useState<ResolvedTransaction[] | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const leaves = categories.filter((c) => c.parentId !== null).sort((a, b) => a.name.localeCompare(b.name))

  async function load() {
    try {
      const bank = await liveTransactionsBetween(month, month)
      const spendIds = new Set((await spendsOf(bank)).map((s) => s.id))
      const resolved = await resolveMany(bank.filter((t) => spendIds.has(t.id)))
      setRows(resolved.filter((t) => (t.categoryId ?? '') === categoryId).sort((a, b) => (a.valueDate < b.valueDate ? 1 : a.valueDate > b.valueDate ? -1 : a.amountCents - b.amountCents)))
      setProblem(null)
    } catch {
      setProblem('These payments could not be read just now. Nothing was changed.')
    }
  }

  async function refile(id: string, to: string) {
    if (busy || to === categoryId) return
    setBusy(true)
    try {
      await writeAnnotation(id, { categoryId: to === '' ? null : to }, 'owner')
      setRows((r) => (r === null ? r : r.filter((t) => t.id !== id)))
      onChanged()
    } catch {
      setProblem('That could not be saved, so nothing was changed. You can try again.')
    } finally { setBusy(false) }
  }

  return (
    <details className="tip category-payments" onToggle={(e) => { if (e.currentTarget.open && rows === null) void load() }}>
      <summary>Show the payments</summary>
      {problem && <div role="alert" className="notice notice-refusal"><p>{problem}</p></div>}
      {rows === null && !problem && <p role="status">Loading…</p>}
      {rows !== null && rows.length === 0 && <p>No payments are filed here now.</p>}
      {rows !== null && rows.length > 0 && (
        <ul className="payments-list" aria-label={`Payments in ${label}`}>
          {rows.map((t) => (
            <li key={t.id}>
              <div className="row-between">
                <span className="payment-name">{t.description}<span className="tx-meta">{formatSpanishDate(t.valueDate)}</span></span>
                <strong>{formatEur(t.amountCents).replace(/ €/g, ' €')}</strong>
              </div>
              <label className="payment-refile">
                File under
                <select value={categoryId} disabled={busy} aria-label={`Category for ${t.description}`} onChange={(e) => { void refile(t.id, e.target.value) }}>
                  {categoryId === '' && <option value="">No category</option>}
                  {leaves.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </label>
            </li>
          ))}
        </ul>
      )}
    </details>
  )
}
