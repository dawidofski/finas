import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MonthPoint } from '../analytics/series'
import * as series from '../analytics/series'
import { COACH_MONTHS, coachContext, monthLine, type CoachMonth } from './context'
import { COACH_KEY, readCoachKey, removeCoachKey, saveCoachKey } from './key'
import { DEEPSEEK_MODEL, DEEPSEEK_URL, buildRequest, questionText, sendRequest } from './request'
import { db } from '../db/db'
import { seedDatabase } from '../db/seed'
import { exportBundle } from '../db/backup'

const point = (month: string, over: Partial<MonthPoint> = {}): MonthPoint => ({
  month, incomeCents: 200000, spentCents: 150000, savedCents: 20000, essentialCents: 90000, discretionaryCents: 50000,
  uncategorisedCents: 10000, netCents: 30000, provisional: false, incomeBasis: 'actual', transactions: 12, hasData: true, ...over,
})
const MONTH: CoachMonth = {
  month: '2026-10', incomeCents: 200000, incomeIsEstimate: false, spentCents: 150000, savedCents: 20000,
  essentialCents: 90000, discretionaryCents: 50000, otherSpendingCents: 10000, leftOverCents: 30000,
}

beforeEach(() => { localStorage.clear() })
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('what the coach is told', () => {
  it('asks for the six completed months before the running one, and never the running month', async () => {
    const spy = vi.spyOn(series, 'monthSeries').mockResolvedValue([])
    await coachContext('2026-11-19', 5)
    expect(COACH_MONTHS).toBe(6)
    expect(spy).toHaveBeenCalledWith('2026-05', '2026-10', '2026-11-19', 5)
  })

  it('leaves out months with no data and carries totals only', async () => {
    vi.spyOn(series, 'monthSeries').mockResolvedValue([point('2026-09', { hasData: false, transactions: 0 }), point('2026-10')])
    const months = await coachContext('2026-11-19', 5)
    expect(months).toEqual([MONTH])
    // The shape is the guarantee: these are all the fields there are, and none can name a purchase, a shop or a person.
    expect(Object.keys(months[0]!).sort()).toEqual([
      'discretionaryCents', 'essentialCents', 'incomeCents', 'incomeIsEstimate', 'leftOverCents', 'month', 'otherSpendingCents', 'savedCents', 'spentCents',
    ])
  })

  it('says an income is not known, or is an estimate, instead of sending a confident figure', async () => {
    vi.spyOn(series, 'monthSeries').mockResolvedValue([
      point('2026-09', { incomeBasis: 'none', incomeCents: 0, netCents: -170000, provisional: true }),
      point('2026-10', { incomeBasis: 'trailing-average', provisional: true }),
    ])
    const [unknown, estimate] = await coachContext('2026-11-19', 5)
    expect(unknown).toMatchObject({ incomeCents: null, leftOverCents: null, incomeIsEstimate: false })
    expect(estimate).toMatchObject({ incomeCents: 200000, incomeIsEstimate: true })
    expect(monthLine(unknown!)).toMatch(/^September 2026: income not known, spent /)
    expect(monthLine(unknown!)).not.toMatch(/left over/)
    expect(monthLine(estimate!)).toMatch(/\(an estimate\)/)
  })
})

describe('the request', () => {
  it('holds the question and one line per month, and nothing else from the device', () => {
    const body = buildRequest('  How am I doing?  ', [MONTH])
    const parsed = JSON.parse(body) as { model: string; stream: boolean; messages: Array<{ role: string; content: string }> }
    expect(Object.keys(parsed).sort()).toEqual(['messages', 'model', 'stream'])
    expect(parsed.model).toBe(DEEPSEEK_MODEL)
    expect(parsed.stream).toBe(false)
    expect(parsed.messages.map((m) => m.role)).toEqual(['system', 'user'])
    expect(parsed.messages[1]!.content).toBe(questionText('How am I doing?', [MONTH]))
    expect(parsed.messages[1]!.content).toBe(`How am I doing?\n\nMy monthly totals:\n${monthLine(MONTH)}`)
  })

  it('sends exactly the text it was given, to the one address, with the key only in the header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: 'A reply.' } }] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const body = buildRequest('Question', [MONTH])
    expect(await sendRequest(body, 'test-key-not-real')).toEqual({ ok: true, reply: 'A reply.' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(DEEPSEEK_URL)
    expect(url).toBe('https://api.deepseek.com/chat/completions')
    expect(init.body).toBe(body)
    expect(init.method).toBe('POST')
    expect(init.credentials).toBe('omit')
    expect(init.referrerPolicy).toBe('no-referrer')
    expect(init.redirect).toBe('error')
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer test-key-not-real')
    expect(body).not.toContain('test-key-not-real')
    expect(url).not.toContain('test-key-not-real')
  })

  it('reports a request that never completed as blocked, an error status as refused, and an empty answer as unreadable, without throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    expect(await sendRequest('{}', 'k')).toEqual({ ok: false, kind: 'blocked' })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('no', { status: 401 })))
    expect(await sendRequest('{}', 'k')).toEqual({ ok: false, kind: 'refused', status: 401 })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not json', { status: 200 })))
    expect(await sendRequest('{}', 'k')).toEqual({ ok: false, kind: 'unreadable' })
    for (const shape of [{}, { choices: [] }, { choices: [{ message: { content: '  ' } }] }, { choices: [{ message: { content: 5 } }] }, null]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(shape), { status: 200 })))
      expect(await sendRequest('{}', 'k')).toEqual({ ok: false, kind: 'unreadable' })
    }
  })
})

describe('the key', () => {
  it('is kept, read back and removed, and a blank one is not a key', () => {
    expect(readCoachKey()).toBeNull()
    expect(saveCoachKey('   ')).toBe(false)
    expect(readCoachKey()).toBeNull()
    expect(saveCoachKey('  test-key-not-real ')).toBe(true)
    expect(readCoachKey()).toBe('test-key-not-real')
    removeCoachKey()
    expect(readCoachKey()).toBeNull()
  })

  it('reports a browser that will not keep it, and treats unreadable storage as no key', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    expect(saveCoachKey('test-key-not-real')).toBe(false)
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    expect(readCoachKey()).toBeNull()
  })

  it('is in no backup: the exported database does not contain it', async () => {
    await db.delete(); await db.open(); await seedDatabase()
    saveCoachKey('test-key-not-real')
    const text = JSON.stringify(await exportBundle())
    expect(text).not.toContain('test-key-not-real')
    expect(text).not.toContain(COACH_KEY)
  })
})
