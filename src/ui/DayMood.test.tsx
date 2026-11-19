import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import DayMood from './DayMood'
import { db } from '../db/db'
import { seedDatabase } from '../db/seed'
import { dayMoodOf, setDayMood } from '../mood/day'
import { guardWording } from '../test/wording'

const TODAY = '2026-11-16'
const YESTERDAY = '2026-11-15'

beforeEach(async () => { await db.delete(); await db.open(); await seedDatabase() })
afterEach(() => { cleanup(); vi.restoreAllMocks() })
guardWording(3, '.mood-label')

const todayRow = async () => {
  render(<DayMood today={TODAY} />)
  await screen.findByRole('heading', { name: 'How was today?' })
  return (await screen.findAllByRole('group'))[0]!
}

describe('the mood of today', () => {
  it('is a card asking how today was, with the mood picker', async () => {
    const row = await todayRow()
    expect(document.querySelector('section.card.day-mood')).not.toBeNull()
    expect(await within(row).findByRole('button', { name: /Happy/ })).toBeTruthy()
  })

  it('is stored for today\'s date the moment a mood is tapped, and shown as chosen', async () => {
    const row = await todayRow()
    fireEvent.click(await within(row).findByRole('button', { name: /Happy/ }))
    await waitFor(async () => expect(await dayMoodOf(TODAY)).toBe('mood.happy'))
    await waitFor(() => expect(within(row).getByRole('button', { name: /Happy/ })).toHaveAttribute('aria-pressed', 'true'))
    expect(await dayMoodOf(YESTERDAY)).toBeNull()
  })

  it('shows a mood already recorded as chosen', async () => {
    await setDayMood(TODAY, 'mood.sad')
    const row = await todayRow()
    await waitFor(() => expect(within(row).getByRole('button', { name: /Sad/ })).toHaveAttribute('aria-pressed', 'true'))
  })

  it('is removed by tapping the chosen mood again, or by Clear', async () => {
    await setDayMood(TODAY, 'mood.happy')
    const row = await todayRow()
    const happy = await within(row).findByRole('button', { name: /Happy/ })
    await waitFor(() => expect(happy).toHaveAttribute('aria-pressed', 'true'))
    fireEvent.click(happy)
    await waitFor(async () => expect(await dayMoodOf(TODAY)).toBeNull())
    fireEvent.click(await within(row).findByRole('button', { name: /Sad/ }))
    await waitFor(async () => expect(await dayMoodOf(TODAY)).toBe('mood.sad'))
    fireEvent.click(await within(row).findByRole('button', { name: 'Clear mood' }))
    await waitFor(async () => expect(await dayMoodOf(TODAY)).toBeNull())
  })
})

describe('the mood of yesterday', () => {
  it('has its own row while yesterday has none, and setting it stores yesterday\'s date only', async () => {
    await todayRow()
    const yesterday = await screen.findByRole('region', { name: 'Yesterday' })
    expect(within(yesterday).getByRole('heading', { name: 'And yesterday?' })).toBeTruthy()
    fireEvent.click(await within(yesterday).findByRole('button', { name: /Excited/ }))
    await waitFor(async () => expect(await dayMoodOf(YESTERDAY)).toBe('mood.excited'))
    expect(await dayMoodOf(TODAY)).toBeNull()
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Yesterday' })).toBeNull())
  })

  it('is not offered when yesterday already has a mood', async () => {
    await setDayMood(YESTERDAY, 'mood.happy')
    await todayRow()
    await waitFor(() => expect(screen.getAllByRole('button').length).toBeGreaterThan(3))
    expect(screen.queryByRole('region', { name: 'Yesterday' })).toBeNull()
    expect(screen.queryByText('And yesterday?')).toBeNull()
  })
})

describe('when saving fails', () => {
  it('says so in an alert and changes nothing on screen', async () => {
    vi.spyOn(db.settings, 'update').mockRejectedValue(new Error('disk full'))
    const row = await todayRow()
    fireEvent.click(await within(row).findByRole('button', { name: /Happy/ }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/could not be saved/)
    expect(within(row).getByRole('button', { name: /Happy/ })).toHaveAttribute('aria-pressed', 'false')
    expect(await dayMoodOf(TODAY)).toBeNull()
  })
})
