import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { clearInvestments, importTrading212, investmentEvents, type ImportOutcome } from '../../investments/store'
import { formatShares, summarise, type InvestmentSummary } from '../../investments/trading212'
import { formatSpanishDate } from '../../lib/dates'
import { formatEur } from '../../lib/money'
import { Bars } from '../charts/Bars'

const readText = (file: File): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => resolve(String(reader.result ?? ''))
  reader.onerror = () => reject(new Error('The file could not be read.'))
  reader.readAsText(file)
})

const eur = (cents: number): string => formatEur(cents).replace(/ €/g, ' €')
const signed = (cents: number): string => (cents > 0 ? `+${eur(cents)}` : eur(cents))
/** An amount in another currency, written from its hundredths: "-0,26". No euro sign, since it is not euros. */
const plain = (cents: number): string => {
  const digits = String(Math.abs(cents)).padStart(3, '0')
  return `${cents < 0 ? '-' : ''}${digits.slice(0, -2)},${digits.slice(-2)}`
}

/**
 * What the imported Trading 212 files add up to: paid in, what the holdings left cost, the broker's own result on sales,
 * dividends and fees, and the holdings. Costs, never values: the files hold no current prices and the app fetches none,
 * and the screen says so. Nothing here is advice about what to buy or sell.
 */
export default function Investments(): ReactNode {
  const [summary, setSummary] = useState<InvestmentSummary | null>(null)
  const [rows, setRows] = useState(0)
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const fileId = useId()

  async function reload() {
    const events = await investmentEvents()
    setRows(events.length)
    setSummary(summarise(events))
  }
  useEffect(() => { reload().catch(() => setProblem('Your investment records could not be read. Nothing was changed.')) }, [])

  async function onPick(file: File | undefined) {
    if (!file || busy) return
    setBusy(true); setProblem(null); setOutcome(null)
    try {
      setOutcome(await importTrading212(await readText(file)))
      await reload()
    } catch (e) {
      setProblem(e instanceof Error && e.message ? e.message : 'The file could not be imported. Nothing was changed.')
    } finally {
      if (fileRef.current) fileRef.current.value = ''
      setBusy(false)
    }
  }

  async function removeAll() {
    setBusy(true); setProblem(null); setOutcome(null)
    try { await clearInvestments(); setConfirming(false); await reload() } catch { setProblem('The records could not be removed. Nothing was changed.') } finally { setBusy(false) }
  }

  const heading = <h1>Investments</h1>
  const picker = (
    <div className="card">
      <h2>Import a Trading 212 file</h2>
      <p><label htmlFor={fileId}>Trading 212 history file (.csv)</label></p>
      <input id={fileId} ref={fileRef} type="file" accept=".csv,text/csv" disabled={busy} onChange={(e) => { void onPick(e.target.files?.[0]) }} />
      <details className="tip">
        <summary>How to get the file, and what happens to it</summary>
        <p>
          In Trading 212, open History and export it as a CSV file for the dates you want. You can import a new file each month:
          files may overlap, and a row already imported is recognised and counted once. The file is read on this device and is not uploaded anywhere.
        </p>
      </details>
      {outcome && (
        <p role="status">
          {outcome.added === 0
            ? `Nothing new: all ${outcome.inFile} rows of that file were already here.`
            : `Added ${outcome.added} ${outcome.added === 1 ? 'row' : 'rows'}${outcome.already > 0 ? `; ${outcome.already} were already here` : ''}.`}
        </p>
      )}
      {problem && <div role="alert" className="notice notice-refusal"><p>{problem}</p></div>}
    </div>
  )

  if (summary === null) return <section className="investments">{heading}{problem ? picker : <p role="status">Loading your investments…</p>}</section>
  if (rows === 0) {
    return (
      <section className="investments">
        {heading}
        <p>Nothing imported yet. Import a Trading 212 history file to see what you have paid in and what you hold.</p>
        {picker}
      </section>
    )
  }

  const s = summary
  const top = s.holdings.slice(0, 8).map((h) => ({ label: h.ticker ?? h.name ?? h.isin, cents: h.costCents }))
  return (
    <section className="investments">
      {heading}
      {s.firstDate !== null && s.lastDate !== null && <p className="muted">From {formatSpanishDate(s.firstDate)} to {formatSpanishDate(s.lastDate)}, {rows} rows.</p>}
      <div className="stat-grid">
        <div className="stat"><span className="stat-label">Paid in</span><span className="stat-value">{eur(s.depositedCents)}</span></div>
        <div className="stat"><span className="stat-label">Cost of what you hold</span><span className="stat-value">{eur(s.investedCents)}</span></div>
        <div className="stat"><span className="stat-label">Result on sales</span><span className="stat-value">{signed(s.realisedCents)}</span></div>
        <div className="stat"><span className="stat-label">Dividends and interest</span><span className="stat-value">{eur(s.incomeCents)}</span></div>
        <div className="stat"><span className="stat-label">Fees</span><span className="stat-value">{eur(s.feesCents)}</span></div>
      </div>
      <details className="tip">
        <summary>What these figures are, and are not</summary>
        <p>
          These are costs, not today&rsquo;s values. &ldquo;Cost of what you hold&rdquo; is what you paid for the shares you still have; the files hold no current prices
          and this app does not look any up, so it cannot say what they are worth now. &ldquo;Result on sales&rdquo; adds up the result Trading 212 printed on each sale.
          Fees are the currency conversion fees and other fees charged in euros.
        </p>
      </details>

      {s.holdings.length > 0 && (
        <div className="card">
          <Bars points={top} title={s.holdings.length > top.length ? `What you hold, by cost (the ${top.length} largest)` : 'What you hold, by cost'} />
        </div>
      )}

      <h2>Holdings</h2>
      {s.holdings.length === 0
        ? <p>You hold nothing now: everything bought in these files has been sold.</p>
        : (
          <ul className="holdings-list" aria-label="Holdings">
            {s.holdings.map((h) => (
              <li key={h.isin} className="row-between">
                <span className="holding-name">
                  {h.name ?? h.ticker ?? h.isin}
                  <span className="tx-meta">{h.ticker !== null ? `${h.ticker} · ` : ''}{formatShares(h.sharesE10)} shares</span>
                </span>
                <strong>{eur(h.costCents)}</strong>
              </li>
            ))}
          </ul>
        )}

      {(s.otherCurrency.length > 0 || s.unknown > 0) && (
        <details className="tip">
          <summary>Rows left out of the figures</summary>
          {s.otherCurrency.length > 0 && (
            <>
              <p>These rows are not in euros, so they are counted in none of the figures above:</p>
              <ul>
                {s.otherCurrency.map((o, i) => <li key={i}>{formatSpanishDate(o.date)}: {o.action}, {plain(o.totalCents)} {o.currency}</li>)}
              </ul>
            </>
          )}
          {s.unknown > 0 && <p>{s.unknown} {s.unknown === 1 ? 'row is' : 'rows are'} of a kind this app does not know, and counted in none of the figures.</p>}
        </details>
      )}

      {picker}

      <div className="actions">
        {confirming
          ? (
            <>
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => { void removeAll() }}>Yes, remove them all</button>
              <button type="button" className="btn" disabled={busy} onClick={() => setConfirming(false)}>Keep them</button>
            </>
          )
          : <button type="button" className="btn" disabled={busy} onClick={() => setConfirming(true)}>Remove all investment records</button>}
      </div>
      {confirming && <p>This removes the imported Trading 212 rows from this device. Your bank transactions are not touched, and you can import the files again.</p>}
    </section>
  )
}
