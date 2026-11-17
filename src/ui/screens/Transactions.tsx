import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { db } from '../../db/db'
import { buildCategoryIndex, resolve, resolveMany, writeAnnotation, type ResolvedTransaction } from '../../db/annotations'
import { transfersTouching } from '../../db/transfers'
import { deletedTransactions, newestFirst, oldestFirst, totalTransactions, transactionsPage, type BrowseOrder, type Visibility } from '../../analysis/transactionsPage'
import type { AccountRow, AnnotationRow, CategoryRow, MerchantRow, TransactionKind, TransactionRow } from '../../db/schema'
import { formatMonthTitle, formatSpanishDate } from '../../lib/dates'
import { formatEur } from '../../lib/money'
import { fold } from '../../lib/text'
import { refundSubtractions } from '../../analysis/income'
import { chooseRoundupParent, parseRoundupParent, roundupContext, unmatchedTransferCount, type RoundupContext } from '../../import/pairing'
import { linkRefund, refundContext, unconfirmedPositives, unlinkRefund, type RefundContext } from '../../import/refunds'
import { rememberMerchantName } from '../../learning/merchants'
import TransactionEditor, { KIND_LABEL } from '../TransactionEditor'
import { readFiltersOpen, writeFiltersOpen } from '../viewPrefs'

/** Rows on screen at once. The list is paged, so the DOM holds at most this many rows however many match. */
export const PAGE_SIZE = 50

type SortKey = 'newest' | 'oldest' | 'spend' | 'income'

interface Filters {
  search: string
  accountId: string
  categoryId: string
  kind: '' | TransactionKind
  from: string
  to: string
  visibility: Visibility
  sort: SortKey
}

const NO_FILTERS: Filters = { search: '', accountId: '', categoryId: '', kind: '', from: '', to: '', visibility: 'active', sort: 'newest' }

interface Loaded {
  /** What this was loaded for (`loadKeyOf`). Anything else on screen is stale until a load for the current key arrives. */
  key: string
  /** 'page': `rows` is the one page asked for, ordered by the database. 'all': `rows` is every transaction and the screen filters it. */
  mode: 'page' | 'all'
  /** In 'page' mode, how many transactions match in all (counted, not read). Unused in 'all' mode. */
  matching: number
  /** Every transaction, deleted or not, and how many are deleted: counted, so the screen can say whether there is anything and whether anything is deleted. */
  total: number
  deletedCount: number
  rows: ResolvedTransaction[]
  banks: ReadonlyMap<string, TransactionRow>
  accounts: AccountRow[]
  categories: CategoryRow[]
  merchants: MerchantRow[]
  /** Transactions whose category is the owner's own choice rather than the one inferred from ING's pair. */
  ownerCategory: ReadonlySet<string>
  /** Internal movements, over every account, with no matching leg in another account yet (§9.2). */
  unmatched: number
  /** Ids on either side of a refund link, so a row can say it is part of one. */
  refundLegs: ReadonlySet<string>
  /** The newest month holding a live transaction, and the money received in it that still counts as income and is not linked to anything. */
  latestMonth: string | null
  unconfirmed: ResolvedTransaction[]
}

/** An outflow round-up whose description names a purchase but which is linked to none: the bank's facts say what it is, the resolved link says whether it has a parent. */
const unmatchedRoundup = (r: ResolvedTransaction, bank: TransactionRow | undefined): boolean =>
  bank !== undefined && bank.kind === 'roundup' && bank.amountCents < 0 && r.deletedAt === null && r.roundupParentId === null && parseRoundupParent(bank.description) !== null

/** Lower-case and accent-free, so "cafeteria" finds "Cafetería". */
const searchable = (s: string) => fold(s).toLowerCase()

/**
 * The screen orders by the BANK's date, like the pager (spec 42.1), through the pager's own comparator. A row's resolved
 * `valueDate` is the owner's corrected one and is what it SHOWS; ordering by it would put a re-dated row where the pager
 * never placed it. `bank` gives each row's bank values; a row with none (it cannot happen for a listed row) uses its own.
 */
const compareFor = (bank: ReadonlyMap<string, TransactionRow>): Record<SortKey, (a: ResolvedTransaction, b: ResolvedTransaction) => number> => {
  const at = (r: ResolvedTransaction): TransactionRow | ResolvedTransaction => bank.get(r.id) ?? r
  const newest = (a: ResolvedTransaction, b: ResolvedTransaction) => newestFirst(at(a), at(b))
  return {
    newest,
    oldest: (a, b) => oldestFirst(at(a), at(b)),
    spend: (a, b) => a.amountCents - b.amountCents || newest(a, b),
    income: (a, b) => b.amountCents - a.amountCents || newest(a, b),
  }
}

/**
 * Which questions the database is asked, and so when a load must run again (spec 39.4).
 *
 * "Browse" is what the owner sees every day: the bank's own facts only (which account, deleted or not, newest or oldest
 * first). The database answers that with indexes, so the screen reads ONE page of rows. Search, category, kind, a date
 * range and ordering by amount look at resolved values, which no index holds, so those read every row, as before, and
 * filter in memory. In that case typing a filter must not reload (the key stays 'all'); in browse mode changing the page
 * or an index-answered filter must (the key changes). See `transactionsPage` for what browse mode costs.
 */
const isBrowse = (f: Filters) =>
  f.search.trim() === '' && f.categoryId === '' && f.kind === '' && f.from === '' && f.to === '' && (f.sort === 'newest' || f.sort === 'oldest')
const loadKeyOf = (f: Filters, page: number) => (isBrowse(f) ? JSON.stringify(['page', f.visibility, f.accountId, f.sort, page]) : 'all')

/** The small reference tables, whole: a few accounts, about sixty categories, the owner's merchants. They do not grow with the ledger. */
const loadReference = () => Promise.all([db.accounts.toArray(), db.categories.toArray(), db.merchants.toArray()])

const bySpelling = {
  categories: (a: CategoryRow, b: CategoryRow) => a.name.localeCompare(b.name),
  merchants: (a: MerchantRow, b: MerchantRow) => a.canonicalName.localeCompare(b.canonicalName),
}

/** Everything the screen needs, for the one page `f`/`page` ask for. Reads one page of transactions and what hangs off those rows. */
async function loadPage(f: Filters, page: number, key: string): Promise<Loaded> {
  const [{ rows: txs, matching }, total, deletedCount, [accounts, categories, merchants], index, unmatched, newest] = await Promise.all([
    transactionsPage({ visibility: f.visibility, accountId: f.accountId, order: f.sort as BrowseOrder, page, pageSize: PAGE_SIZE }),
    totalTransactions(),
    deletedTransactions(f.accountId),
    loadReference(),
    buildCategoryIndex(),
    unmatchedTransferCount(),
    // The newest live row, from the top of the date index: one row read, plus any deleted rows above it.
    db.transactions.orderBy('valueDate').reverse().filter((t) => t.deletedAt === null).first(),
  ])
  const ids = txs.map((t) => t.id)
  const annotations = await db.annotations.bulkGet(ids)
  const rows = txs.map((t, i) => resolve(t, annotations[i], index))

  // Badge only links that move money, by the rule the figures use (refundSubtraction): a paused or inert link's money
  // is still income. Only the links touching these rows, and only the other leg of each, are read.
  const links = (await transfersTouching(ids)).filter((t) => t.linkKind === 'refund')
  const legs = new Map(txs.map((t) => [t.id, t]))
  const missing = [...new Set(links.flatMap((t) => [t.outTransactionId, t.inTransactionId]))].filter((id) => !legs.has(id))
  for (const t of await db.transactions.bulkGet(missing)) if (t) legs.set(t.id, t)
  const refundLegs = new Set((await refundSubtractions(links, legs)).flatMap((s) => [s.refundId, s.originalId]))

  const latestMonth = newest ? newest.valueDate.slice(0, 7) : null
  return {
    key, mode: 'page', matching, total, deletedCount,
    rows, banks: new Map(txs.map((t) => [t.id, t])), accounts,
    categories: categories.sort(bySpelling.categories), merchants: merchants.sort(bySpelling.merchants),
    ownerCategory: new Set(ids.filter((_, i) => annotations[i]?.categoryId != null)),
    unmatched, refundLegs, latestMonth,
    unconfirmed: latestMonth ? await unconfirmedPositives(latestMonth) : [],
  }
}

/** Every transaction, for the views that filter or order by resolved values. This is the original, unbounded read, kept only for those. */
async function loadAll(f: Filters, key: string): Promise<Loaded> {
  const txs = await db.transactions.toArray()
  const [rows, [accounts, categories, merchants], annotations, unmatched] = await Promise.all([
    resolveMany(txs), loadReference(), db.annotations.toArray(), unmatchedTransferCount(),
  ])
  const live = txs.filter((t) => t.deletedAt === null).map((t) => t.valueDate).sort()
  const latestMonth = live.length > 0 ? (live[live.length - 1] as string).slice(0, 7) : null
  // Badge only links that move money, by the rule the figures use (refundSubtraction): a paused or inert link's money
  // is still income.
  const byId = new Map(txs.map((t) => [t.id, t]))
  const refundLegs = new Set((await refundSubtractions(await db.transfers.toArray(), byId)).flatMap((s) => [s.refundId, s.originalId]))
  return {
    key, mode: 'all', matching: 0, total: txs.length, deletedCount: txs.filter((t) => t.deletedAt !== null && (f.accountId === '' || t.accountId === f.accountId)).length,
    rows,
    banks: byId,
    accounts,
    categories: categories.sort(bySpelling.categories),
    merchants: merchants.sort(bySpelling.merchants),
    ownerCategory: new Set(annotations.filter((a: AnnotationRow) => a.categoryId !== null).map((a) => a.transactionId)),
    unmatched, refundLegs, latestMonth,
    unconfirmed: latestMonth ? await unconfirmedPositives(latestMonth) : [],
  }
}

const loadData = (f: Filters, page: number): Promise<Loaded> => {
  const key = loadKeyOf(f, page)
  return isBrowse(f) ? loadPage(f, page, key) : loadAll(f, key)
}

export default function Transactions(): ReactNode {
  const [data, setData] = useState<Loaded | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [filters, setFilters] = useState<Filters>(NO_FILTERS)
  const [page, setPage] = useState(0)
  const [openId, setOpenId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [refund, setRefund] = useState<RefundContext | null>(null)
  const [roundup, setRoundup] = useState<RoundupContext | null>(null)
  // A transaction opened from "Money that arrived" may not be on the page that was loaded; it is read on its own.
  const [extra, setExtra] = useState<{ bank: TransactionRow; shown: ResolvedTransaction; ownerCategory: boolean } | null>(null)
  const [filtersOpen, setFiltersOpen] = useState(readFiltersOpen)
  const [status, setStatus] = useState<{ text: string; undoId: string | null } | null>(null)
  // Said inside the editor, which stays open after a naming: the screen's own status notice is behind the dialog.
  const [merchantNotice, setMerchantNotice] = useState<string | null>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const returnTo = useRef<string | null>(null)

  // What the database is currently being asked for. A save re-runs the same question, not a wider one.
  const loadKey = loadKeyOf(filters, page)
  const asked = useRef({ filters, page })
  asked.current = { filters, page }
  const loadSeq = useRef(0) // a slow load for an earlier question must not overwrite the answer to a later one

  const reload = useCallback(async () => {
    const seq = ++loadSeq.current
    try {
      const next = await loadData(asked.current.filters, asked.current.page)
      if (seq === loadSeq.current) { setData(next); setLoadError(null) }
    } catch (e) {
      if (seq === loadSeq.current) setLoadError(`Your transactions could not be read${e instanceof Error && e.message ? ` (${e.message})` : ''}. Nothing was changed.`)
    }
  }, [])
  useEffect(() => { void reload() }, [reload, loadKey])
  // The editor's refund section is read fresh each time a transaction opens (and after every change, since `data` is reloaded).
  useEffect(() => {
    let stale = false
    setRefund(null)
    if (openId) void refundContext(openId).then((c) => { if (!stale) setRefund(c) }).catch(() => { if (!stale) setRefund(null) })
    return () => { stale = true }
  }, [openId, data])
  // Same for a round-up's parent: null for anything that is not an outflow round-up naming a purchase.
  useEffect(() => {
    let stale = false
    setRoundup(null)
    if (openId) void roundupContext(openId).then((c) => { if (!stale) setRoundup(c) }).catch(() => { if (!stale) setRoundup(null) })
    return () => { stale = true }
  }, [openId, data])
  useEffect(() => {
    let stale = false
    if (!openId || !data || data.rows.some((r) => r.id === openId)) { setExtra(null); return }
    void (async () => {
      const bank = await db.transactions.get(openId)
      if (!bank) return
      const [[annotation], index] = await Promise.all([db.annotations.bulkGet([openId]), buildCategoryIndex()])
      if (!stale) setExtra({ bank, shown: resolve(bank, annotation, index), ownerCategory: annotation?.categoryId != null })
    })().catch(() => { if (!stale) setExtra(null) })
    return () => { stale = true }
  }, [openId, data])

  // Every filter except which of deleted / not deleted to show, so the same rule scopes the list and the "Deleted (n)" count.
  const passes = useMemo(() => {
    const q = searchable(filters.search.trim())
    const merchantName = new Map((data?.merchants ?? []).map((m) => [m.id, searchable(m.canonicalName)]))
    return (r: ResolvedTransaction): boolean => {
      if (filters.accountId && r.accountId !== filters.accountId) return false
      if (filters.categoryId && r.categoryId !== filters.categoryId) return false
      if (filters.kind && r.kind !== filters.kind) return false
      if (filters.from && r.valueDate < filters.from) return false
      if (filters.to && r.valueDate > filters.to) return false
      if (q) {
        const merchant = r.merchantId ? merchantName.get(r.merchantId) ?? '' : ''
        if (!searchable(r.description).includes(q) && !merchant.includes(q)) return false
      }
      return true
    }
  }, [data, filters])
  const matching = useMemo(() => {
    if (!data) return []
    return data.rows.filter((r) => {
      const deleted = r.deletedAt !== null
      if (filters.visibility === 'active' && deleted) return false
      if (filters.visibility === 'deleted' && !deleted) return false
      return passes(r)
    }).sort(compareFor(data.banks)[filters.sort])
  }, [data, filters, passes])

  // In page mode the rows loaded ARE the page (the database already counted and skipped), so they are shown whole.
  const paged = data?.mode === 'page'
  const matchCount = paged ? data.matching : matching.length
  const pages = Math.max(1, Math.ceil(matchCount / PAGE_SIZE))
  const current = Math.min(page, pages - 1)
  const visible = paged ? matching : matching.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE)
  // The last row of the last page was deleted or moved: ask for the page that exists.
  useEffect(() => { if (data && data.key === loadKey && page > pages - 1) setPage(pages - 1) }, [data, loadKey, page, pages])
  const loading = data !== null && data.key !== loadKey

  const change = (patch: Partial<Filters>) => { setFilters((f) => ({ ...f, ...patch })); setPage(0) }

  const open = (id: string) => { returnTo.current = id; setSaveError(null); setMerchantNotice(null); setOpenId(id) }
  const close = () => {
    const id = returnTo.current
    setOpenId(null); setSaveError(null); setMerchantNotice(null)
    // Hand focus back to the row that opened the editor, or to the heading if that row is no longer listed.
    queueMicrotask(() => {
      const trigger = id
        ? Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-tx-open]') ?? []).find((el) => el.dataset.txOpen === id)
        : undefined
      ;(trigger ?? headingRef.current)?.focus()
    })
  }

  async function run(work: () => Promise<void>, failure: string): Promise<boolean> {
    setBusy(true); setSaveError(null)
    try { await work(); await reload(); return true } catch (e) {
      setSaveError(`${failure}${e instanceof Error && e.message ? ` (${e.message})` : ''}. Your records are as they were.`)
      return false
    } finally { setBusy(false) }
  }

  const save = async (id: string, patch: Partial<AnnotationRow>) => {
    // One patch, one write: one transaction, one learning event per changed field.
    if (await run(() => writeAnnotation(id, patch, 'owner'), 'The change could not be saved')) {
      setStatus({ text: 'Saved.', undoId: null }); close()
    }
  }
  // Delete and restore touch deletedAt and nothing else (§8.1). The bank's values stay exactly as imported.
  const setDeleted = async (id: string, at: number | null) => {
    if (await run(async () => { await db.transactions.update(id, { deletedAt: at }) }, at === null ? 'It could not be restored' : 'It could not be deleted')) {
      setStatus(at === null
        ? { text: 'Restored. It is back in your list.', undoId: null }
        : { text: 'Deleted. It is out of your list, and you can restore it from "Deleted" above the list.', undoId: id })
      close()
    }
  }

  const refundAction = async (work: () => Promise<unknown>, text: string, failure: string) => {
    if (await run(async () => { await work() }, failure)) { setStatus({ text, undoId: null }); close() }
  }

  /**
   * The owner names the merchant behind a transaction. rememberMerchantName does all of it — creating or reusing the
   * merchant, storing the pattern that wins thereafter, and setting the annotation's merchantId through writeAnnotation,
   * which emits the learning event. Its own refusal wording is what the owner is shown (`run` keeps the message).
   * `createdAt` is passed in because the clock is read only where sourceRules.test.ts sanctions it; this screen is one of
   * those places (it already stamps deletedAt). The editor stays open: naming the merchant and correcting its category
   * are one errand, and the control the owner pressed keeps focus.
   */
  const nameMerchant = async (id: string, name: string) => {
    setMerchantNotice(null)
    if (await run(async () => { await rememberMerchantName(id, name, Date.now()) }, 'The merchant could not be saved')) {
      setMerchantNotice(`Saved. This transaction is now ${name}. Transactions your bank describes the same way are recognised as ${name} too.`)
    }
  }

  const here = extra && extra.shown.id === openId ? extra : undefined
  const openRow = openId && data ? data.rows.find((r) => r.id === openId) ?? here?.shown : undefined
  const openBank = openId && data ? data.banks.get(openId) ?? here?.bank : undefined
  const accountLabel = (id: string) => data?.accounts.find((a) => a.id === id)?.label ?? 'Account'
  const categoryName = (id: string | null) => (id ? data?.categories.find((c) => c.id === id)?.name ?? null : null)
  const filtered = JSON.stringify({ ...filters, sort: '' }) !== JSON.stringify({ ...NO_FILTERS, sort: '' })

  if (loadError) return <section className="transactions"><h1>Transactions</h1><div role="alert" className="notice notice-refusal"><p>{loadError}</p></div></section>
  if (!data) return <section className="transactions"><h1>Transactions</h1><p role="status">Loading your transactions…</p></section>

  const leaves = data.categories.filter((c) => c.parentId !== null)
  const hasAny = data.total > 0
  // Scoped like the deleted view is. In page mode the only filter is the account, which the load already counted for; in 'all'
  // mode every filter is applied here without a reload, so the count is what the deleted view would list under them.
  const deletedShown = paged ? data.deletedCount : data.rows.filter((r) => r.deletedAt !== null && passes(r)).length
  const activeFilters = [filters.search.trim() !== '', filters.accountId !== '', filters.categoryId !== '', filters.kind !== '',
    filters.from !== '', filters.to !== '', filters.visibility !== 'active'].filter(Boolean).length
  const setFiltersShown = (open: boolean) => { setFiltersOpen(open); writeFiltersOpen(open) }
  const showingDeleted = filters.visibility === 'deleted'

  return (
    <section className="transactions">
      <h1 ref={headingRef} tabIndex={-1}>Transactions</h1>

      {status && (
        <div role="status" className="notice">
          <p>{status.text}</p>
          {status.undoId && (
            <div className="actions">
              <button type="button" className="btn" disabled={busy} onClick={() => { void setDeleted(status.undoId as string, null) }}>Undo</button>
            </div>
          )}
        </div>
      )}

      {data.unmatched > 0 && (
        <div role="note" className="notice">
          <p>
            {data.unmatched === 1 ? '1 movement between your accounts has' : `${data.unmatched} movements between your accounts have`}
            {' '}no matching entry in another account yet. This often means the other account has not been imported yet;
            once it is, matching entries are linked automatically.
          </p>
        </div>
      )}

      {data.unconfirmed.length > 0 && (
        <details className="notice">
          <summary>
            Money that arrived in {formatMonthTitle(data.latestMonth ?? '')} ({data.unconfirmed.length})
          </summary>
          <p>If any of this was a refund, open it and link it to the purchase it returned. Anything you do not link stays part of your income.</p>
          <ul>
            {data.unconfirmed.map((r) => (
              <li key={r.id}>
                <button type="button" className="btn" onClick={() => open(r.id)}>{formatSpanishDate(r.valueDate)} · {r.description} · {formatEur(r.amountCents)}</button>
              </li>
            ))}
          </ul>
        </details>
      )}

      {!hasAny ? (
        <p>No transactions yet. Import your ING file and they will appear here, ready to read and correct.</p>
      ) : (
        <>
          {(deletedShown > 0 || showingDeleted) && (
            // Restore is the only way back for a deleted row, so the owner is told they exist without having to open the filters.
            <p>
              <button type="button" className="btn" aria-pressed={showingDeleted} onClick={() => change({ visibility: showingDeleted ? 'active' : 'deleted' })}>
                {showingDeleted ? `Back to your transactions` : `Deleted (${deletedShown})`}
              </button>
            </p>
          )}

          {/* Shut by default so the day's first transaction is on the first screen (spec 39.3); remembered per device (viewPrefs.ts).
              The summary click is handled here rather than left to the browser, so the stored choice and the screen cannot disagree. */}
          <details className="tx-filter-panel" open={filtersOpen}>
            <summary onClick={(e) => { e.preventDefault(); setFiltersShown(!filtersOpen) }}>
              Filters{activeFilters > 0 ? ` (${activeFilters} on)` : ''}
            </summary>
          <div className="tx-filters" role="search">
            <label>Search
              <input type="search" value={filters.search} placeholder="Description or merchant" onChange={(e) => change({ search: e.target.value })} />
            </label>
            <label>Account
              <select value={filters.accountId} onChange={(e) => change({ accountId: e.target.value })}>
                <option value="">All accounts</option>
                {data.accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
              </select>
            </label>
            <label>Category
              <select value={filters.categoryId} onChange={(e) => change({ categoryId: e.target.value })}>
                <option value="">All categories</option>
                {leaves.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
            <label>Kind
              <select value={filters.kind} onChange={(e) => change({ kind: e.target.value as Filters['kind'] })}>
                <option value="">All kinds</option>
                {(Object.keys(KIND_LABEL) as TransactionKind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
              </select>
            </label>
            <label>From
              <input type="date" value={filters.from} onChange={(e) => change({ from: e.target.value })} />
            </label>
            <label>To
              <input type="date" value={filters.to} onChange={(e) => change({ to: e.target.value })} />
            </label>
            <label>Show
              <select value={filters.visibility} onChange={(e) => change({ visibility: e.target.value as Visibility })}>
                <option value="active">Your transactions</option>
                <option value="deleted">Deleted</option>
                <option value="all">Both</option>
              </select>
            </label>
            <label>Order
              <select value={filters.sort} onChange={(e) => change({ sort: e.target.value as SortKey })}>
                <option value="newest">Newest first</option>
                <option value="oldest">Oldest first</option>
                <option value="spend">Largest spending first</option>
                <option value="income">Largest income first</option>
              </select>
            </label>
            {filtered && <button type="button" className="btn" onClick={() => change({ ...NO_FILTERS, sort: filters.sort })}>Clear filters</button>}
          </div>
          </details>

          <p role="status" aria-live="polite">
            {loading ? 'Loading your transactions…'
              : matchCount === 0 ? 'No transactions to show.'
                : `Showing ${current * PAGE_SIZE + 1} to ${current * PAGE_SIZE + visible.length} of ${matchCount}.`}
          </p>

          {loading ? null : matchCount === 0 ? (
            <p>
              {filters.from && filters.to && filters.from > filters.to
                // Named, not left to the generic sentence: the filters themselves are the problem, and the owner can fix them in one tap.
                ? `The From date (${formatSpanishDate(filters.from)}) is after the To date (${formatSpanishDate(filters.to)}), so nothing can match. Swap them, or clear one.`
                : filters.visibility === 'deleted' && !filtered ? 'You have not deleted anything.'
                  : 'Nothing matches these filters. Clearing one or two will show more.'}
            </p>
          ) : (
            <div className="table-wrap" ref={listRef}>
              <table aria-label="Transactions">
                <thead>
                  <tr>
                    <th scope="col">Date</th>
                    <th scope="col">Description</th>
                    <th scope="col" className="num">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((r) => {
                    const deleted = r.deletedAt !== null
                    const category = categoryName(r.categoryId)
                    const merchant = r.merchantId ? data.merchants.find((m) => m.id === r.merchantId)?.canonicalName : undefined
                    return (
                      <tr key={r.id} className="tx-row" data-deleted={deleted} onClick={() => open(r.id)}>
                        <td className="nowrap">{formatSpanishDate(r.valueDate)}</td>
                        <td>
                          <button type="button" className="tx-open" data-tx-open={r.id}>{r.description}</button>
                          <small className="tx-meta">
                            {[merchant, category ? (data.ownerCategory.has(r.id) ? category : `${category} (from ING)`) : 'No category', KIND_LABEL[r.kind]]
                              .filter(Boolean).join(' · ')}
                            {r.hasOverrides && <span className="tx-badge"> Edited</span>}
                            {deleted && <span className="tx-badge"> Deleted</span>}
                            {/* Spec 42.1: the list is ordered by the bank's date and shows the owner's, so say when they differ. */}
                            {data.banks.get(r.id) && data.banks.get(r.id)?.valueDate !== r.valueDate && (
                              // Visible text, not a hover title: a phone has no hover, and a keyboard cannot reach a title.
                              <span className="tx-badge"> Date changed (bank: {formatSpanishDate(data.banks.get(r.id)?.valueDate ?? r.valueDate)})</span>
                            )}
                            {data.refundLegs.has(r.id) && <span className="tx-badge"> {r.amountCents > 0 ? 'Refund' : 'Refunded'}</span>}
                            {unmatchedRoundup(r, data.banks.get(r.id)) && <span className="tx-badge"> No purchase matched</span>}
                          </small>
                        </td>
                        <td className="num nowrap">{formatEur(r.amountCents)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}

          {pages > 1 && (
            // Always mounted, even while a page loads: unmounting the button that was just pressed would drop keyboard focus
            // to the document. They are aria-disabled with a guard in the handler, never `disabled`, at the ends of the range too:
            // `disabled` on the control the owner has just pressed (Next onto the last page) blurs it the same way.
            <div className="actions">
              <button type="button" className="btn" aria-disabled={loading || current === 0} onClick={() => { if (!loading && current > 0) setPage(current - 1) }}>Previous</button>
              <span aria-live="polite">Page {current + 1} of {pages}</span>
              <button type="button" className="btn" aria-disabled={loading || current >= pages - 1} onClick={() => { if (!loading && current < pages - 1) setPage(current + 1) }}>Next</button>
            </div>
          )}
        </>
      )}

      {openRow && openBank && (
        <TransactionEditor
          key={openRow.id}
          bank={openBank}
          shown={openRow}
          accountLabel={accountLabel(openRow.accountId)}
          categories={data.categories}
          merchants={data.merchants}
          categoryIsOwners={data.ownerCategory.has(openRow.id) || (here?.ownerCategory ?? false)}
          busy={busy}
          error={saveError}
          onSave={(patch) => { void save(openRow.id, patch) }}
          onDelete={() => { void setDeleted(openRow.id, Date.now()) }}
          onRestore={() => { void setDeleted(openRow.id, null) }}
          onClose={close}
          onNameMerchant={(name) => { void nameMerchant(openRow.id, name) }}
          merchantNotice={merchantNotice}
          refund={refund}
          roundup={roundup}
          onChooseRoundupParent={(parentId) => { void refundAction(() => chooseRoundupParent(openRow.id, parentId), 'Saved. That round-up now belongs to the purchase you chose.', 'The round-up could not be linked') }}
          onLinkRefund={(spendId) => { void refundAction(() => linkRefund(openRow.id, spendId), 'Linked as a refund. It is no longer counted as income.', 'The refund could not be linked') }}
          onUnlinkRefund={(transferId) => { void refundAction(() => unlinkRefund(transferId), 'Unlinked. That payment counts as income again.', 'The refund could not be unlinked') }}
        />
      )}
    </section>
  )
}
