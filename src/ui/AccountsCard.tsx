import { useEffect, useState, type ReactNode } from 'react'
import { accountBalances, type AccountBalance } from '../accounts/balances'
import { formatSpanishDate } from '../lib/dates'
import { formatEur } from '../lib/money'

/**
 * What is in each account, on the Dashboard: one row per imported account with the bank's own latest balance, and the sum.
 * A savings account appears here as soon as a statement of it has been imported. Shows nothing at all until there is at
 * least one account with movements, and nothing if the balances cannot be read (the Dashboard has its own messages).
 */
export function AccountsCard(): ReactNode {
  const [rows, setRows] = useState<AccountBalance[] | null>(null)

  useEffect(() => {
    let live = true
    accountBalances().then((r) => { if (live) setRows(r) }, () => { if (live) setRows([]) })
    return () => { live = false }
  }, [])

  if (rows === null || rows.length === 0) return null
  const total = rows.reduce((sum, r) => sum + r.balanceCents, 0)
  return (
    <section className="card accounts-card" aria-labelledby="accounts-card-title">
      <h2 id="accounts-card-title">Your accounts</h2>
      <ul className="accounts-list">
        {rows.map((r) => (
          <li key={r.accountId} className="row-between">
            <span className="accounts-name">
              {r.label}
              <span className="tx-meta">Balance on {formatSpanishDate(r.asOf)}</span>
            </span>
            <strong>{formatEur(r.balanceCents).replace(/ €/g, ' €')}</strong>
          </li>
        ))}
      </ul>
      {rows.length > 1 && (
        <p className="row-between accounts-total"><span>Together</span><strong>{formatEur(total).replace(/ €/g, ' €')}</strong></p>
      )}
      <details className="tip">
        <summary>About these balances</summary>
        <p>
          Each figure is the balance your bank printed beside the newest movement you have imported for that account, on the date shown.
          It is not updated until you import a newer statement. To see a savings account here, import its statement in Settings, the same way as your main account;
          you can rename an account in Settings.
        </p>
      </details>
    </section>
  )
}
