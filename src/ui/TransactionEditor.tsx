import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { AnnotationRow, CategoryRow, MerchantRow, TransactionKind, TransactionRow } from '../db/schema'
import type { ResolvedTransaction } from '../db/annotations'
import { addDays, formatSpanishDate } from '../lib/dates'
import type { RefundContext } from '../import/refunds'
import type { RoundupContext } from '../import/pairing'
import { centsToTypedString, formatEur, parseTypedAmount } from '../lib/money'
// The threshold is imported, never retyped: the sentence beside a control is part of the behaviour (§45), so a
// hard-coded "twice" here would quietly lie to the owner if the rule changed, with the suite still green.
import { CORRECTIONS_NEEDED } from '../learning/memory'
import ReasonChips from './annotations/ReasonChips'
import WorthwhileButtons from './annotations/WorthwhileButtons'

export const KIND_LABEL: Record<TransactionKind, string> = {
  spend: 'Spending', income: 'Income', internal: 'Between your accounts', roundup: 'Round-up saving',
}

/** What the owner can type. Strings, because that is what the inputs hold; `buildPatch` turns them into one patch. */
export interface EditorForm {
  date: string
  description: string
  merchantId: string
  amount: string
  categoryId: string
  kind: TransactionKind
  paymentMethod: string
  note: string
  purchaseReasonId: string | null
  worthwhile: boolean | null
}

export function formFor(tx: ResolvedTransaction): EditorForm {
  return {
    date: tx.valueDate,
    description: tx.description,
    merchantId: tx.merchantId ?? '',
    amount: centsToTypedString(tx.amountCents),
    categoryId: tx.categoryId ?? '',
    kind: tx.kind,
    paymentMethod: tx.paymentMethod ?? '',
    note: tx.note ?? '',
    purchaseReasonId: tx.purchaseReasonId,
    worthwhile: tx.worthwhile,
  }
}

export type PatchResult = { ok: true; patch: Partial<AnnotationRow> } | { ok: false; error: string }

/**
 * The ONE patch for a save: every changed field and nothing else, so the write is one transaction that emits one
 * learning event per changed tracked field (§34.6). The editor has no mood control (the mood is noted once for the day, on the Dashboard); a purchase's own older mood is never in the patch, so a save leaves it as it is. Reason and worthwhile are deliberately NOT tracked yet (see
 * NOT_YET_TRACKED in db/annotations.ts): learningEvents is append-only, so their event shape waits for Plan 4's consumer. A date, amount, description or kind that is put back to the bank's own
 * value clears its override instead of storing a copy of the bank's value. `shown` is what the editor opened with.
 */
export function buildPatch(bank: TransactionRow, shown: ResolvedTransaction, form: EditorForm): PatchResult {
  const patch: Partial<AnnotationRow> = {}

  if (form.date !== shown.valueDate) {
    let valid = false
    try { valid = addDays(form.date, 0) === form.date } catch { valid = false }
    if (!valid) return { ok: false, error: 'Choose a valid date.' }
    patch.dateOverride = form.date === bank.valueDate ? null : form.date
  }

  const description = form.description.trim()
  if (description !== shown.description) {
    if (description === '') return { ok: false, error: 'The description cannot be empty.' }
    patch.descriptionOverride = description === bank.description ? null : description
  }

  if (form.amount.trim() !== centsToTypedString(shown.amountCents)) {
    let cents: number
    try { cents = parseTypedAmount(form.amount) } catch {
      return { ok: false, error: 'Type the amount as a number, for example -12,50 or -1.850,00 for money going out.' }
    }
    if (cents !== shown.amountCents) patch.amountCentsOverride = cents === bank.amountCents ? null : cents
  }

  if (form.kind !== shown.kind) patch.typeOverride = form.kind === bank.kind ? null : form.kind

  if (form.categoryId !== (shown.categoryId ?? '')) patch.categoryId = form.categoryId || null
  if (form.merchantId !== (shown.merchantId ?? '')) patch.merchantId = form.merchantId || null

  const method = form.paymentMethod.trim()
  if (method !== (shown.paymentMethod ?? '')) patch.paymentMethod = method || null
  const note = form.note.trim()
  if (note !== (shown.note ?? '')) patch.note = note || null
  if (form.purchaseReasonId !== shown.purchaseReasonId) patch.purchaseReasonId = form.purchaseReasonId
  if (form.worthwhile !== shown.worthwhile) patch.worthwhile = form.worthwhile

  return { ok: true, patch }
}

interface Props {
  bank: TransactionRow
  shown: ResolvedTransaction
  accountLabel: string
  categories: CategoryRow[]
  merchants: MerchantRow[]
  /** Whether the category on screen is the owner's own choice; otherwise it is what the app inferred from ING's pair. */
  categoryIsOwners: boolean
  busy: boolean
  error: string | null
  onSave: (patch: Partial<AnnotationRow>) => void
  onDelete: () => void
  onRestore: () => void
  onClose: () => void
  /** Refund links for this transaction; omitted (or null while loading) means the refund section is not shown. */
  refund?: RefundContext | null
  onLinkRefund?: (spendId: string) => void
  onUnlinkRefund?: (transferId: string) => void
  /** Set for an outflow round-up: which purchase it belongs to and which could. Omitted (or null) means the section is not shown. */
  roundup?: RoundupContext | null
  onChooseRoundupParent?: (parentId: string) => void
  /**
   * The owner names the merchant behind this transaction (the only way a merchant is ever created: the select above
   * offers the ones already named, so on a fresh install it offers nothing). Omitted means the control is not rendered
   * at all, because a control that does nothing must not look pressable (P3-R33).
   */
  onNameMerchant?: (name: string) => void
  /** What to say after a naming, said where the owner is standing: inside the dialog, which covers the screen. */
  merchantNotice?: string | null
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])'

export default function TransactionEditor(props: Props): ReactNode {
  const { bank, shown, categories, merchants, busy } = props
  const deleted = bank.deletedAt !== null
  const [form, setForm] = useState<EditorForm>(() => formFor(shown))
  const [problem, setProblem] = useState<string | null>(null)
  // The note is collapsed unless there is already one: most purchases need no words (§15).
  const [noteOpen, setNoteOpen] = useState(() => shown.note !== null)
  const [spendChoice, setSpendChoice] = useState('')
  const [parentChoice, setParentChoice] = useState('')
  const [merchantName, setMerchantName] = useState('')
  const panelRef = useRef<HTMLDivElement>(null)
  const id = useId()
  const set = <K extends keyof EditorForm>(key: K, value: EditorForm[K]) => setForm((f) => ({ ...f, [key]: value }))

  useEffect(() => { panelRef.current?.querySelector<HTMLElement>('input, button')?.focus() }, [])

  // A naming is written by the screen, which then reloads and hands this open editor a new `shown`. The merchant control
  // has to follow that, or the form would still hold the merchant the editor opened with and the next Save would send it
  // back, undoing the naming the owner just did. The typed name has done its work by then, so the field is cleared.
  useEffect(() => {
    setForm((f) => ({ ...f, merchantId: shown.merchantId ?? '' }))
    setMerchantName('')
  }, [shown.merchantId])

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape' && !e.defaultPrevented) { e.stopPropagation(); props.onClose(); return }
    if (e.key !== 'Tab') return
    // aria-modal: keep Tab inside the panel.
    const items = Array.from(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
    const first = items[0]
    const last = items[items.length - 1]
    if (!first || !last) return
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
  }

  function submit() {
    const result = buildPatch(bank, shown, form)
    if (!result.ok) { setProblem(result.error); return }
    setProblem(null)
    if (Object.keys(result.patch).length === 0) { props.onClose(); return }
    props.onSave(result.patch)
  }

  // Whitespace is not a name, so with nothing typed (or a save in flight) this does nothing and says so with
  // aria-disabled. The guard is what makes that true; `disabled` is deliberately not used, see the button below.
  function nameMerchant() {
    const name = merchantName.trim()
    if (busy || name === '') return
    props.onNameMerchant?.(name)
  }

  const parents = categories.filter((c) => c.parentId === null)
  // Choosing the empty option clears the owner's category, and the row falls back to the one derived from its ING pair
  // (§34.3). The label must say what will happen: "No category" is only true where there is no pair to fall back to.
  const ingPair = bank.ingCategory !== null && bank.ingSubcategory !== null ? `${bank.ingCategory} / ${bank.ingSubcategory}` : null
  const hasIngCategory = ingPair !== null && categories.some((c) => c.ingMappings.includes(ingPair))
  const field = (name: string) => `${id}-${name}`
  const shownError = problem ?? props.error

  return (
    <div className="tx-backdrop">
      <div ref={panelRef} className="tx-editor" role="dialog" aria-modal="true" aria-labelledby={field('title')} onKeyDown={onKeyDown}>
        <h2 id={field('title')}>{deleted ? 'Deleted transaction' : 'Edit transaction'}</h2>
        <p>
          {props.accountLabel}. The bank recorded {formatSpanishDate(bank.valueDate)}, {formatEur(bank.amountCents)}, {bank.description}.
          {' '}Your changes are kept beside it, and the bank's version is never overwritten.
        </p>
        {deleted && (
          <p role="note">This transaction is deleted, so it is left out of the list. Restore it to bring it back exactly as the bank recorded it.</p>
        )}
        {shownError && <div role="alert" className="notice notice-refusal"><p>{shownError}</p></div>}

        {!deleted && (
          <form onSubmit={(e) => { e.preventDefault(); submit() }}>
            <label htmlFor={field('date')}>Date</label>
            <input id={field('date')} type="date" value={form.date} onChange={(e) => set('date', e.target.value)} />

            <label htmlFor={field('description')}>Description</label>
            <input id={field('description')} type="text" value={form.description} onChange={(e) => set('description', e.target.value)} />

            <label htmlFor={field('merchant')}>Merchant</label>
            <select id={field('merchant')} value={form.merchantId} onChange={(e) => set('merchantId', e.target.value)}>
              <option value="">None</option>
              {merchants.map((m) => <option key={m.id} value={m.id}>{m.canonicalName}</option>)}
            </select>

            <label htmlFor={field('amount')}>Amount in euros</label>
            <input id={field('amount')} type="text" inputMode="decimal" value={form.amount} onChange={(e) => set('amount', e.target.value)}
                   aria-describedby={field('amount-hint')} />
            <small id={field('amount-hint')}>Use a minus sign for money going out, for example -12,50 or -1.850,00.</small>

            <label htmlFor={field('category')}>Category</label>
            {/* One control, writing categoryId only. There is deliberately no second "subcategory" field: parents group and
                never classify (§21.2) and categoryId already holds the leaf, so AnnotationRow.subcategoryId is vestigial.
                Do not restore it. */}
            <select id={field('category')} value={form.categoryId} onChange={(e) => set('categoryId', e.target.value)}>
              <option value="">{hasIngCategory ? "Back to ING's category" : 'No category'}</option>
              {parents.map((p) => {
                const leaves = categories.filter((c) => c.parentId === p.id)
                return leaves.length === 0 ? null : (
                  <optgroup key={p.id} label={p.name}>
                    {leaves.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </optgroup>
                )
              })}
            </select>
            {!props.categoryIsOwners && shown.categoryId !== null && (
              <small>This category is what the app worked out from ING's own category. Choose one to make it yours.</small>
            )}

            <label htmlFor={field('kind')}>Kind</label>
            <select id={field('kind')} value={form.kind} onChange={(e) => set('kind', e.target.value as TransactionKind)}>
              {(Object.keys(KIND_LABEL) as TransactionKind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
            </select>
            <small>The kind decides which figure this transaction counts in: spending, income, savings, or none of them.
              Changing it changes your budget, in the month the bank dated it. The amount, the sign and that month stay the bank's.</small>

            <label htmlFor={field('method')}>Payment method</label>
            <input id={field('method')} type="text" value={form.paymentMethod} onChange={(e) => set('paymentMethod', e.target.value)} />

            <ReasonChips value={form.purchaseReasonId} onChange={(v) => set('purchaseReasonId', v)} disabled={busy} />
            <WorthwhileButtons value={form.worthwhile} onChange={(v) => set('worthwhile', v)} disabled={busy} />

            <details open={noteOpen} onToggle={(e) => setNoteOpen(e.currentTarget.open)}>
              <summary>Add a note</summary>
              <label htmlFor={field('note')}>Note</label>
              <input id={field('note')} type="text" value={form.note} onChange={(e) => set('note', e.target.value)} />
            </details>

            <div className="actions">
              <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
              <button type="button" className="btn" disabled={busy} onClick={props.onClose}>Cancel</button>
              <button type="button" className="btn" disabled={busy} onClick={props.onDelete}>Delete</button>
            </div>
          </form>
        )}

        {!deleted && props.onNameMerchant && (
          // Outside the <form> on purpose: in it, Enter on this field would submit the whole editor and the typed name
          // would be dropped without a word. Here Enter names the merchant, which is what the owner meant by it.
          <section aria-labelledby={field('naming')} className="tx-refund">
            <h3 id={field('naming')}>Name this merchant</h3>
            <p>
              The Merchant list above holds the merchants you have already named. Name the shop behind this transaction and
              the app remembers your bank&apos;s wording for it, so the same shop is recognised on later statements too.
              Once you have corrected that merchant&apos;s category the same way {CORRECTIONS_NEEDED} times, it becomes the
              category assumed for it.
            </p>
            <label htmlFor={field('merchant-name')}>Merchant name</label>
            <input id={field('merchant-name')} type="text" value={merchantName}
                   onChange={(e) => setMerchantName(e.target.value)}
                   onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); nameMerchant() } }} />
            {/* aria-disabled with the guard in `nameMerchant`, never `disabled`: this is the control the owner is standing
                on, and `disabled` on a focused button drops focus to the body (P3-R32). */}
            <button type="button" className="btn" aria-disabled={busy || merchantName.trim() === ''} onClick={nameMerchant}>
              Name this merchant
            </button>
            {props.merchantNotice && <p role="status">{props.merchantNotice}</p>}
          </section>
        )}

        {!deleted && props.refund && (
          <section aria-labelledby={field('refund')} className="tx-refund">
            <h3 id={field('refund')}>Refund</h3>
            {props.refund.refundOf && (
              <>
                {props.refund.refundOf.spend.deletedAt === null ? (
                  <p>
                    This is a refund of {props.refund.refundOf.spend.description} ({formatSpanishDate(props.refund.refundOf.spend.valueDate)},
                    {' '}{formatEur(props.refund.refundOf.spend.amountCents)}). It is not counted as income, and it reduces that
                    purchase's category instead. If that purchase is not counted as spending (for example, it is filed under a
                    category for transfers, income or savings), the link changes nothing and this payment stays income.
                  </p>
                ) : (
                  <p>
                    This was linked as a refund of {props.refund.refundOf.spend.description}, which you have deleted. While that is
                    deleted the link is paused and this payment counts as income. Restoring the purchase brings the link back.
                  </p>
                )}
                <button type="button" className="btn" disabled={busy}
                        onClick={() => props.onUnlinkRefund?.(props.refund?.refundOf?.transferId ?? '')}>Unlink refund</button>
              </>
            )}
            {props.refund.refundedBy.map((r) => (
              <div key={r.transferId}>
                <p>
                  Refunded on {formatSpanishDate(r.refund.valueDate)}: {formatEur(r.refund.amountCents)}.
                  {r.refund.deletedAt !== null && ' That payment is deleted, so the link is paused until you restore it.'}
                </p>
                <button type="button" className="btn" disabled={busy} onClick={() => props.onUnlinkRefund?.(r.transferId)}>
                  Unlink the refund of {formatEur(r.refund.amountCents)}
                </button>
              </div>
            ))}
            {!props.refund.refundOf && shown.amountCents > 0 && (
              props.refund.candidates.length === 0 ? (
                <p>This payment counts as income. If it was a refund, there is no purchase from the 90 days before it to link it to.</p>
              ) : (
                <>
                  <p>This payment counts as income. If it was a refund, link it to the purchase it returned and it will not.</p>
                  <label htmlFor={field('spend')}>Purchase it refunds</label>
                  <select id={field('spend')} value={spendChoice} onChange={(e) => setSpendChoice(e.target.value)}>
                    <option value="">Choose a purchase</option>
                    {props.refund.candidates.map((c) => (
                      <option key={c.id} value={c.id}>{formatSpanishDate(c.valueDate)} · {c.description} · {formatEur(c.amountCents)}</option>
                    ))}
                  </select>
                  <button type="button" className="btn" disabled={busy || spendChoice === ''} onClick={() => props.onLinkRefund?.(spendChoice)}>
                    Link as refund
                  </button>
                </>
              )
            )}
          </section>
        )}

        {!deleted && props.roundup && (
          <section aria-labelledby={field('roundup')} className="tx-refund">
            <h3 id={field('roundup')}>Round-up</h3>
            {props.roundup.parent ? (
              <p>
                This round-up belongs to {props.roundup.parent.description} ({formatSpanishDate(props.roundup.parent.valueDate)},
                {' '}{formatEur(props.roundup.parent.amountCents)}).
              </p>
            ) : props.roundup.candidates.length === 0 ? (
              <p>
                This round-up could not be matched to a purchase. The purchase it names is not among your transactions for that day.
                It may be in a statement you have not imported yet; once it is, you can come back and choose it here.
              </p>
            ) : (
              <p>
                This round-up could not be matched to a purchase automatically.
                {props.roundup.candidates.length > 1
                  ? ' More than one purchase that day is for the amount it names, and the balances do not settle which. Choose the one it belongs to.'
                  : ' One purchase that day is for the amount it names. Choose it if that is the one.'}
              </p>
            )}
            {props.roundup.candidates.length > 0 && (props.roundup.parent === null || props.roundup.candidates.length > 1) && (
              <>
                <label htmlFor={field('parent')}>Purchase it belongs to</label>
                <select id={field('parent')} value={parentChoice} onChange={(e) => setParentChoice(e.target.value)}>
                  <option value="">Choose a purchase</option>
                  {props.roundup.candidates.map((c) => (
                    <option key={c.id} value={c.id}>{formatSpanishDate(c.valueDate)} · {c.description} · {formatEur(c.amountCents)}</option>
                  ))}
                </select>
                <button type="button" className="btn" disabled={busy || parentChoice === '' || parentChoice === props.roundup.parent?.id}
                        onClick={() => props.onChooseRoundupParent?.(parentChoice)}>
                  Use this purchase
                </button>
              </>
            )}
          </section>
        )}

        {deleted && (
          <div className="actions">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={props.onRestore}>Restore</button>
            <button type="button" className="btn" disabled={busy} onClick={props.onClose}>Close</button>
          </div>
        )}
      </div>
    </div>
  )
}
