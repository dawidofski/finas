import { readFileSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import MoodRow from './MoodRow'
import ReasonChips from './ReasonChips'
import WorthwhileButtons from './WorthwhileButtons'
import { visibleOptions } from './vocabulary'
import Transactions from '../screens/Transactions'
import { db } from '../../db/db'
import { seedDatabase } from '../../db/seed'
import type { TransactionRow } from '../../db/schema'

beforeEach(async () => {
  await db.delete()
  await db.open()
  await seedDatabase()
})
afterEach(() => { vi.restoreAllMocks() })

/** Holds the value the way a parent screen would, so a tap shows up in what the control renders. */
function Harness<T>({ Control, initial, spy }: {
  Control: (p: { value: T; onChange: (v: T) => void }) => React.ReactNode; initial: T; spy?: (v: T) => void
}) {
  const [value, setValue] = useState<T>(initial)
  return <Control value={value} onChange={(v) => { spy?.(v); setValue(v) }} />
}

const pressed = (el: HTMLElement) => el.getAttribute('aria-pressed')

describe('MoodRow', () => {
  it('renders the seeded moods as a one-tap row with their emoji', async () => {
    const onChange = vi.fn()
    render(<MoodRow value={null} onChange={onChange} />)
    const group = await screen.findByRole('group', { name: /How did it feel/ })
    const buttons = await within(group).findAllByRole('button')
    expect(buttons).toHaveLength(12)
    const seeded = await db.moods.orderBy('order').toArray()
    expect(buttons.map((b) => b.textContent)).toEqual(seeded.map((m) => `${m.emoji}${m.label}`))
    // One tap, no confirmation step: the choice is reported straight away.
    fireEvent.click(within(group).getByRole('button', { name: /Stressed/ }))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('mood.stressed')
    expect(buttons.every((b) => b.getAttribute('aria-pressed') === 'false')).toBe(true)
  })

  it('offers Other, whose valence is null, like any other mood', async () => {
    const onChange = vi.fn()
    render(<MoodRow value={null} onChange={onChange} />)
    expect((await db.moods.get('mood.other'))?.valence).toBeNull()
    fireEvent.click(await screen.findByRole('button', { name: /Other/ }))
    expect(onChange).toHaveBeenCalledWith('mood.other')
  })

  it('marks the chosen mood with a tick as well as aria-pressed, so colour is never the only signal', async () => {
    render(<MoodRow value="mood.happy" onChange={() => {}} />)
    const happy = await screen.findByRole('button', { name: /Happy/ })
    expect(pressed(happy)).toBe('true')
    expect(happy.textContent).toContain('✓')
    expect(screen.getByRole('button', { name: /Sad/ }).textContent).not.toContain('✓')
  })

  it('hides an archived mood from the picker when the transaction does not use it', async () => {
    await db.moods.update('mood.bored', { archived: true })
    render(<MoodRow value="mood.happy" onChange={() => {}} />)
    await screen.findByRole('button', { name: /Happy/ })
    expect(screen.queryByRole('button', { name: /Bored/ })).toBeNull()
    // 11 live moods plus "Clear mood" (the transaction has one set): Bored is the one missing.
    expect(screen.getAllByRole('button')).toHaveLength(11 + 1)
  })

  it('still renders an archived mood, by label, on a transaction that uses it', async () => {
    await db.moods.update('mood.bored', { archived: true })
    render(<MoodRow value="mood.bored" onChange={() => {}} />)
    const bored = await screen.findByRole('button', { name: /Bored/ })
    expect(bored.textContent).toContain('🥱')
    expect(bored.textContent).toContain('Bored')
    expect(pressed(bored)).toBe('true')
    // It is shown, not offered: with the transaction on a different mood it is gone again.
    expect(visibleOptions([{ id: 'a', archived: true }, { id: 'b', archived: false }], 'b').map((o) => o.id)).toEqual(['b'])
    expect(visibleOptions([{ id: 'a', archived: true }, { id: 'b', archived: false }], 'a').map((o) => o.id)).toEqual(['a', 'b'])
  })

  it('shows an id the vocabulary no longer holds as a clearable placeholder, never as the raw id', async () => {
    const onChange = vi.fn()
    render(<MoodRow value="mood.gone-for-good" onChange={onChange} />)
    const placeholder = await screen.findByRole('button', { name: /Earlier mood/ })
    expect(document.body.textContent).not.toContain('mood.gone-for-good')
    fireEvent.click(placeholder)
    expect(onChange).toHaveBeenCalledWith(null)
  })

  it('clears a mood back to none, by tapping it again or with Clear mood', async () => {
    const seen: (string | null)[] = []
    render(<Harness Control={MoodRow} initial={'mood.happy' as string | null} spy={(v) => seen.push(v)} />)
    const happy = await screen.findByRole('button', { name: /Happy/ })
    fireEvent.click(happy)
    expect(seen).toEqual([null])
    expect(pressed(screen.getByRole('button', { name: /Happy/ }))).toBe('false')
    expect(screen.queryByRole('button', { name: 'Clear mood' })).toBeNull() // nothing to clear

    fireEvent.click(screen.getByRole('button', { name: /Sad/ }))
    expect(seen).toEqual([null, 'mood.sad'])
    fireEvent.click(screen.getByRole('button', { name: 'Clear mood' }))
    expect(seen).toEqual([null, 'mood.sad', null])
  })

  it('says it is optional', async () => {
    render(<MoodRow value={null} onChange={() => {}} />)
    expect(await screen.findByRole('group', { name: /Optional/ })).toBeTruthy()
  })
})

describe('a failed vocabulary read', () => {
  const failingRead = (table: 'moods' | 'purchaseReasons') =>
    vi.spyOn(db[table], 'orderBy').mockReturnValue({ toArray: () => Promise.reject(new Error('read failed')) } as never)

  it('leaves a set mood alone: says so, offers nothing that could clear it', async () => {
    failingRead('moods')
    const onChange = vi.fn()
    render(<MoodRow value="mood.happy" onChange={onChange} />)
    expect(await screen.findByRole('note')).toHaveTextContent('could not be loaded')
    expect(screen.queryAllByRole('button')).toHaveLength(0)
    expect(document.body.textContent).not.toContain('Earlier mood')
    expect(onChange).not.toHaveBeenCalled()
    const marker = screen.getByText('Mood recorded')
    expect(marker.tagName).toBe('SPAN') // not a button
    expect(marker.textContent).toContain('✓')
    fireEvent.click(marker)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('shows no marker when nothing is set', async () => {
    failingRead('moods')
    render(<MoodRow value={null} onChange={() => {}} />)
    await screen.findByRole('note')
    expect(screen.queryByText('Mood recorded')).toBeNull()
  })

  it('offers no Clear, but shows the marker, while the vocabulary is still loading', () => {
    vi.spyOn(db.moods, 'orderBy').mockReturnValue({ toArray: () => new Promise(() => {}) } as never)
    render(<MoodRow value="mood.happy" onChange={() => {}} />)
    expect(screen.getByText('Mood recorded')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Clear mood' })).toBeNull()
  })

  it('does the same for a set reason', async () => {
    failingRead('purchaseReasons')
    const onChange = vi.fn()
    render(<ReasonChips value="reason.planned" onChange={onChange} />)
    expect(await screen.findByRole('note')).toHaveTextContent('could not be loaded')
    expect(screen.queryAllByRole('button')).toHaveLength(0)
    const marker = screen.getByText('Reason recorded')
    expect(marker.textContent).toContain('✓')
    expect(marker.tagName).toBe('SPAN') // not a button
    fireEvent.click(marker)
    expect(onChange).not.toHaveBeenCalled() // clicking the marker clears nothing
  })

  it('shows no reason marker when nothing is set', async () => {
    failingRead('purchaseReasons')
    render(<ReasonChips value={null} onChange={() => {}} />)
    await screen.findByRole('note')
    expect(screen.queryByText('Reason recorded')).toBeNull()
  })

  it('offers no Clear, but shows the reason marker, while the vocabulary is still loading', () => {
    vi.spyOn(db.purchaseReasons, 'orderBy').mockReturnValue({ toArray: () => new Promise(() => {}) } as never)
    render(<ReasonChips value="reason.planned" onChange={() => {}} />)
    expect(screen.getByText('Reason recorded')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Clear reason' })).toBeNull()
  })
})

describe('ReasonChips', () => {
  it('renders purchase reasons as chips in seeded order', async () => {
    render(<ReasonChips value={null} onChange={() => {}} />)
    const group = await screen.findByRole('group', { name: /reason for buying it/ })
    const chips = await within(group).findAllByRole('button')
    const seeded = await db.purchaseReasons.orderBy('order').toArray()
    expect(chips.map((c) => c.textContent)).toEqual(seeded.map((r) => r.label))
    expect(chips).toHaveLength(8)
  })

  it('selects, ticks and clears a reason', async () => {
    const seen: (string | null)[] = []
    render(<Harness Control={ReasonChips} initial={null as string | null} spy={(v) => seen.push(v)} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Impulse' }))
    const chosen = screen.getByRole('button', { name: /Impulse/ })
    expect(pressed(chosen)).toBe('true')
    expect(chosen.textContent).toContain('✓')
    fireEvent.click(screen.getByRole('button', { name: 'Clear reason' }))
    expect(seen).toEqual(['reason.impulse', null])
    expect(pressed(screen.getByRole('button', { name: 'Impulse' }))).toBe('false')
  })

  it('hides an archived reason unless the transaction uses it, then renders it by label', async () => {
    await db.purchaseReasons.update('reason.reward', { archived: true })
    const { unmount } = render(<ReasonChips value="reason.planned" onChange={() => {}} />)
    await screen.findByRole('button', { name: /Planned/ })
    expect(screen.queryByRole('button', { name: /Reward/ })).toBeNull()
    unmount()
    render(<ReasonChips value="reason.reward" onChange={() => {}} />)
    expect(pressed(await screen.findByRole('button', { name: /Reward/ }))).toBe('true')
  })
})

describe('WorthwhileButtons', () => {
  it('renders three buttons and reports true, false and null', async () => {
    const seen: (boolean | null)[] = []
    render(<Harness Control={WorthwhileButtons} initial={null as boolean | null} spy={(v) => seen.push(v)} />)
    const group = screen.getByRole('group', { name: /Worth it\?/ })
    expect(within(group).getAllByRole('button').map((b) => b.textContent?.replace('✓', ''))).toEqual(['Worth it', 'Not worth it', 'Not rated'])
    fireEvent.click(within(group).getByRole('button', { name: 'Worth it' }))
    fireEvent.click(within(group).getByRole('button', { name: /Not worth it/ }))
    fireEvent.click(within(group).getByRole('button', { name: /Not rated/ }))
    expect(seen).toEqual([true, false, null])
  })

  it('shows null as Not rated, selected, so an unanswered purchase reads as unanswered', () => {
    render(<WorthwhileButtons value={null} onChange={() => {}} />)
    expect(pressed(screen.getByRole('button', { name: /Not rated/ }))).toBe('true')
    expect(pressed(screen.getByRole('button', { name: 'Worth it' }))).toBe('false')
    expect(pressed(screen.getByRole('button', { name: 'Not worth it' }))).toBe('false')
  })

  it('draws the selected answer with a tick as well as aria-pressed', () => {
    render(<WorthwhileButtons value={false} onChange={() => {}} />)
    const no = screen.getByRole('button', { name: /Not worth it/ })
    expect(pressed(no)).toBe('true')
    expect(no.textContent).toContain('✓')
  })
})

describe('keyboard', () => {
  it('keeps every control reachable: native buttons, in the tab order, focusable, never disabled by default', async () => {
    render(<><MoodRow value={null} onChange={() => {}} /><ReasonChips value={null} onChange={() => {}} /><WorthwhileButtons value={null} onChange={() => {}} /></>)
    await screen.findByRole('button', { name: /Happy/ })
    await screen.findByRole('button', { name: 'Impulse' })
    const all = screen.getAllByRole('button')
    expect(all).toHaveLength(12 + 8 + 3)
    for (const b of all) {
      expect(b.tagName).toBe('BUTTON') // Enter and Space activate a native button
      expect(b.getAttribute('type')).toBe('button') // never submits the editor form
      expect(b.tabIndex).toBe(0)
      expect((b as HTMLButtonElement).disabled).toBe(false)
      b.focus()
      expect(document.activeElement).toBe(b)
    }
  })

  it('has a visible focus state and 48px targets in the stylesheet', () => {
    const css = readFileSync(resolvePath(__dirname, '../app.css'), 'utf8')
    expect(css).toMatch(/:focus-visible\s*\{[^}]*outline:\s*3px/)
    expect(css).toMatch(/\.choice\s*\{[^}]*min-height:\s*48px[^}]*min-width:\s*48px/)
  })

  it('disables every tap while a save is running', async () => {
    render(<MoodRow value={null} onChange={() => {}} disabled />)
    const buttons = await screen.findAllByRole('button')
    expect(buttons.every((b) => (b as HTMLButtonElement).disabled)).toBe(true)
  })
})

describe('the transaction editor', () => {
  const account = { id: 'acc1', fingerprint: 'acc1'.padEnd(64, '0'), label: 'Cuenta 0001', last4: null, currency: 'EUR', createdAt: 1, archived: false }
  const tx = (over: Partial<TransactionRow> = {}): TransactionRow => ({
    id: 'tx1', accountId: 'acc1', valueDate: '2026-11-10', amountCents: -1250, balanceCents: 100000,
    description: 'Invented cafe', comment: null, ingCategory: null, ingSubcategory: null, kind: 'spend',
    dedupKey: 'k1', importId: 'imp1', fileSeq: 1, roundupParentId: null, createdAt: 1, deletedAt: null, ...over,
  })
  async function open(text: string) {
    render(<Transactions />)
    const table = await screen.findByRole('table', { name: 'Transactions' })
    const row = within(table).getAllByRole('row').find((r) => r.textContent?.includes(text))!
    fireEvent.click(within(row).getByRole('button'))
    return screen.findByRole('dialog')
  }

  beforeEach(async () => { await db.accounts.add(account); await db.transactions.add(tx()) })

  it('has no mood control: the mood is noted once for the day, not on every payment', async () => {
    const dialog = await open('Invented cafe')
    await within(dialog).findByRole('button', { name: 'Impulse' })
    expect(within(dialog).queryByRole('button', { name: /Stressed/ })).toBeNull()
    expect(within(dialog).queryByText(/How did it feel/)).toBeNull()
    expect(dialog.querySelector('.mood-row')).toBeNull()
  })

  it('writes reason and worthwhile through writeAnnotation in one patch', async () => {
    const put = vi.spyOn(db.annotations, 'put')
    const dialog = await open('Invented cafe')
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Impulse' }))
    fireEvent.click(within(dialog).getByRole('button', { name: /Not worth it/ }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    expect(put).toHaveBeenCalledTimes(1) // one write for both fields, not one per control
    expect(await db.annotations.get('tx1')).toMatchObject({ moodId: null, purchaseReasonId: 'reason.impulse', worthwhile: false })
    // Reason and worthwhile are deliberately not learning-event fields yet (NOT_YET_TRACKED): the row holds the value.
    expect(await db.learningEvents.count()).toBe(0)
  })

  it('sends nothing for a control the owner did not touch', async () => {
    await db.annotations.put({
      transactionId: 'tx1', categoryId: null, subcategoryId: null, merchantId: null, typeOverride: null, paymentMethod: null,
      note: null, moodId: 'mood.happy', purchaseReasonId: 'reason.planned', worthwhile: true, reviewed: false,
      dateOverride: null, amountCentsOverride: null, descriptionOverride: null, updatedAt: 1,
    })
    const dialog = await open('Invented cafe')
    fireEvent.click(await within(dialog).findByRole('button', { name: /Planned/ })) // clears the reason only
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(await db.annotations.get('tx1')).toMatchObject({ moodId: 'mood.happy', purchaseReasonId: null, worthwhile: true })
    expect(await db.learningEvents.count()).toBe(0)
  })

  it('keeps a purchase\'s own older mood when something else is saved', async () => {
    await db.annotations.put({
      transactionId: 'tx1', categoryId: null, subcategoryId: null, merchantId: null, typeOverride: null, paymentMethod: null,
      note: null, moodId: 'mood.happy', purchaseReasonId: null, worthwhile: null, reviewed: false,
      dateOverride: null, amountCentsOverride: null, descriptionOverride: null, updatedAt: 1,
    })
    const dialog = await open('Invented cafe')
    expect(within(dialog).queryByRole('button', { name: 'Clear mood' })).toBeNull()
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Impulse' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(await db.annotations.get('tx1')).toMatchObject({ moodId: 'mood.happy', purchaseReasonId: 'reason.impulse' })
  })

  it('leaves an archived own mood in the data when the transaction is saved', async () => {
    await db.moods.update('mood.guilty', { archived: true })
    await db.annotations.put({
      transactionId: 'tx1', categoryId: null, subcategoryId: null, merchantId: null, typeOverride: null, paymentMethod: null,
      note: null, moodId: 'mood.guilty', purchaseReasonId: null, worthwhile: null, reviewed: false,
      dateOverride: null, amountCentsOverride: null, descriptionOverride: null, updatedAt: 1,
    })
    const dialog = await open('Invented cafe')
    await within(dialog).findByRole('button', { name: 'Impulse' })
    expect(within(dialog).queryByRole('button', { name: /Guilty/ })).toBeNull()
    // Saving must not drop it.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Impulse' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect((await db.annotations.get('tx1'))?.moodId).toBe('mood.guilty')
    expect(await db.learningEvents.count()).toBe(0)
  })

  it('keeps the note collapsed by default', async () => {
    const dialog = await open('Invented cafe')
    const details = dialog.querySelector('details')!
    expect(details.open).toBe(false)
    expect(within(dialog).getByText('Add a note')).toBeTruthy()
  })
})

describe('source rules', () => {
  it('writes nothing to the database from the controls: they only read their vocabulary', () => {
    for (const f of ['MoodRow.tsx', 'ReasonChips.tsx', 'WorthwhileButtons.tsx', 'vocabulary.tsx']) {
      const src = readFileSync(resolvePath(__dirname, f), 'utf8')
      expect(src).not.toMatch(/writeAnnotation|\.(put|add|update|bulkAdd|bulkPut|delete)\(/)
    }
  })
})
