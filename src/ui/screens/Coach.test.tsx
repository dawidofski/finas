import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import Coach from './Coach'
import { CoachKey } from '../CoachKey'
import * as context from '../../coach/context'
import type { CoachMonth } from '../../coach/context'
import { COACH_KEY, readCoachKey, saveCoachKey } from '../../coach/key'
import { DEEPSEEK_URL, buildRequest, questionText } from '../../coach/request'
import { guardWording } from '../../test/wording'

const TODAY = '2026-11-19'
const AT = 1_700_000_000_000
const KEY = 'test-key-not-real'
const MONTHS: CoachMonth[] = [{
  month: '2026-10', incomeCents: 200000, incomeIsEstimate: false, spentCents: 150000, savedCents: 20000,
  essentialCents: 90000, discretionaryCents: 50000, otherSpendingCents: 10000, leftOverCents: 30000,
}]

let fetchMock: ReturnType<typeof vi.fn>
const reply = (text: string) => new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { status: 200 })

beforeEach(() => {
  localStorage.clear()
  fetchMock = vi.fn().mockResolvedValue(reply('Here is one small step to consider.'))
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(context, 'coachContext').mockResolvedValue(MONTHS)
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
// Registered after the cleanup above so it runs before it. The text to be sent and DeepSeek's reply are left out of the scan:
// the first is the request itself, shown character for character (its field names are DeepSeek's, not this app's wording),
// and the second is DeepSeek's words, which the screen labels as such.
guardWording(8, '.coach-payload, .coach-reply')

const ask = (text: string) => fireEvent.change(screen.getByRole('textbox', { name: /What would you like to ask/ }), { target: { value: text } })
const press = (name: RegExp) => fireEvent.click(screen.getByRole('button', { name }))
const shown = () => document.querySelector('pre.coach-payload')?.textContent ?? null

async function prepare(question = 'How am I doing?') {
  ask(question)
  press(/Show what would be sent/)
  await screen.findByRole('heading', { name: 'Exactly what would be sent' })
}

describe('AI coach', () => {
  it('is off until a key is added, says what can leave the device, and sends nothing on its own', async () => {
    render(<Coach today={TODAY} computedAt={AT} />)
    expect(screen.getByRole('heading', { level: 1, name: 'AI coach' })).toBeInTheDocument()
    expect(document.body.textContent).toMatch(/stays off until you add a key of your own/)
    expect(document.body.textContent).toMatch(/The app adds no transaction, description, shop, person, account number or note to it/)
    expect(screen.getByRole('link', { name: /add your DeepSeek key in Settings/ })).toHaveAttribute('href', '#/settings')
    await prepare()
    // Preparing reads the totals and shows the text. It does not send, and without a key there is no send button at all.
    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /Send this to DeepSeek/ })).toBeNull()
    expect(document.body.textContent).toMatch(/Nothing has been sent yet/)
  })

  it('keeps the key out of the page and out of the field once saved, and removes it on request (the key section, shown in Settings)', () => {
    render(<CoachKey />)
    // What a key in browser storage means is said beside the field, before it is saved.
    expect(document.body.textContent).toMatch(/anything with access to this device or this browser profile can read it/)
    expect(document.body.textContent).toMatch(/spending limit/)
    const field = screen.getByLabelText('DeepSeek key') as HTMLInputElement
    expect(field.type).toBe('password')
    expect(field.name).toBe('')
    fireEvent.change(field, { target: { value: KEY } })
    press(/Save the key/)
    expect(readCoachKey()).toBe(KEY)
    expect(screen.queryByLabelText('DeepSeek key')).toBeNull()
    expect(document.body.innerHTML).not.toContain(KEY)
    expect(window.location.href).not.toContain(KEY)
    expect(document.body.textContent).toMatch(/It is not part of any backup file/)
    press(/Remove the key/)
    expect(localStorage.getItem(COACH_KEY)).toBeNull()
    expect(screen.getByLabelText('DeepSeek key')).toBeInTheDocument()
  })

  it('refuses an empty key and says so', () => {
    render(<CoachKey />)
    press(/Save the key/)
    expect(screen.getByRole('alert').textContent).toMatch(/Type or paste your key first/)
    expect(readCoachKey()).toBeNull()
  })

  it('shows the exact text first, and sends that text and no other, only when send is pressed', async () => {
    saveCoachKey(KEY)
    render(<Coach today={TODAY} computedAt={AT} />)
    await prepare('How am I doing?')
    const expected = buildRequest('How am I doing?', MONTHS)
    expect(shown()).toBe(expected)
    expect(fetchMock).not.toHaveBeenCalled()
    press(/Send this to DeepSeek/)
    await screen.findByRole('heading', { name: /DeepSeek.s reply/ })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(DEEPSEEK_URL)
    expect(init.body).toBe(expected)
    expect(init.body).toBe(shown())
    expect(document.querySelector('.coach-reply')?.textContent).toBe('Here is one small step to consider.')
    expect(document.body.textContent).toMatch(/written by DeepSeek, not by this app, and it can be wrong/)
    expect(document.body.innerHTML).not.toContain(KEY)
  })

  it('discards what was prepared when the question is edited, so an approved text is never sent with another question', async () => {
    saveCoachKey(KEY)
    render(<Coach today={TODAY} computedAt={AT} />)
    await prepare('First question')
    ask('A different question')
    expect(shown()).toBeNull()
    expect(screen.queryByRole('button', { name: /Send this to DeepSeek/ })).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not let the question change while the text is being prepared, so the text shown is never an older question', async () => {
    let release: (months: CoachMonth[]) => void = () => {}
    vi.spyOn(context, 'coachContext').mockImplementation(() => new Promise((resolve) => { release = resolve }))
    saveCoachKey(KEY)
    render(<Coach today={TODAY} computedAt={AT} />)
    ask('A question that names Tienda Ejemplo')
    press(/Show what would be sent/)
    const field = screen.getByRole('textbox', { name: /What would you like to ask/ }) as HTMLTextAreaElement
    await waitFor(() => expect(field.readOnly).toBe(true))
    // An edit attempted meanwhile is not taken, so the field and the prepared text cannot come apart.
    ask('A question with the shop taken out')
    expect(field.value).toBe('A question that names Tienda Ejemplo')
    release(MONTHS)
    await screen.findByRole('heading', { name: 'Exactly what would be sent' })
    expect(shown()).toBe(buildRequest(field.value, MONTHS))
    // Once it is shown the field is editable again, and editing discards what was prepared.
    expect(field.readOnly).toBe(false)
    ask('A question with the shop taken out')
    expect(shown()).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('offers no discard while a send is under way, and keeps the question fixed until the reply', async () => {
    let answer: (r: Response) => void = () => {}
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => { answer = resolve }))
    saveCoachKey(KEY)
    render(<Coach today={TODAY} computedAt={AT} />)
    await prepare()
    press(/Send this to DeepSeek/)
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Discard' })).toBeNull())
    expect((screen.getByRole('textbox', { name: /What would you like to ask/ }) as HTMLTextAreaElement).readOnly).toBe(true)
    press(/Sending/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    answer(reply('Done.'))
    await screen.findByRole('heading', { name: /DeepSeek.s reply/ })
    expect(screen.getByRole('button', { name: 'Discard' })).toBeInTheDocument()
  })

  it('shows a reply as text, never as markup', async () => {
    fetchMock.mockResolvedValue(reply('<img src=x onerror="window.__hit = 1"><b>bold</b>'))
    saveCoachKey(KEY)
    render(<Coach today={TODAY} computedAt={AT} />)
    await prepare()
    press(/Send this to DeepSeek/)
    await screen.findByRole('heading', { name: /DeepSeek.s reply/ })
    const box = document.querySelector('.coach-reply')!
    expect(box.querySelector('img, b')).toBeNull()
    expect(box.textContent).toContain('<b>bold</b>')
  })

  it('says precisely what is and is not known when the request does not get through, and offers the copy route', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    saveCoachKey(KEY)
    render(<Coach today={TODAY} computedAt={AT} />)
    await prepare('How am I doing?')
    press(/Send this to DeepSeek/)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/did not get through, and nothing was received/)
    expect(alert.textContent).toMatch(/The app cannot tell what stopped it: for example/)
    // The prepared text is still there, and copying takes the plain question and totals, not the request wrapper.
    press(/Copy my question and totals/)
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(questionText('How am I doing?', MONTHS)))
    expect((await screen.findByRole('status')).textContent).toMatch(/Nothing was sent from this app/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('names the error DeepSeek gave, and says so when a copy is not allowed', async () => {
    fetchMock.mockResolvedValue(new Response('no', { status: 401 }))
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } })
    saveCoachKey(KEY)
    render(<Coach today={TODAY} computedAt={AT} />)
    await prepare()
    press(/Send this to DeepSeek/)
    expect((await screen.findByRole('alert')).textContent).toMatch(/answered with an error \(number 401\)/)
    press(/Copy my question and totals/)
    await waitFor(() => expect(document.body.textContent).toMatch(/did not allow copying/))
  })

  it('prepares nothing and sends nothing when there is no completed month, or the totals cannot be read', async () => {
    saveCoachKey(KEY)
    vi.spyOn(context, 'coachContext').mockResolvedValue([])
    const view = render(<Coach today={TODAY} computedAt={AT} />)
    ask('How am I doing?')
    press(/Show what would be sent/)
    expect((await screen.findByRole('alert')).textContent).toMatch(/no completed month with records yet/)
    expect(shown()).toBeNull()
    view.unmount()
    vi.spyOn(context, 'coachContext').mockRejectedValue(new Error('boom'))
    render(<Coach today={TODAY} computedAt={AT} />)
    ask('How am I doing?')
    press(/Show what would be sent/)
    expect((await screen.findByRole('alert')).textContent).toMatch(/could not be read, so nothing was prepared and nothing was sent/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does nothing for an empty question', () => {
    render(<Coach today={TODAY} computedAt={AT} />)
    press(/Show what would be sent/)
    expect(context.coachContext).not.toHaveBeenCalled()
    expect(shown()).toBeNull()
  })
})
