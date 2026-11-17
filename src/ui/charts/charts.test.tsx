import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { render, within } from '@testing-library/react'
import { Bars } from './Bars'
import { Line } from './Line'
import { formatEur } from '../../lib/money'

const num = (el: Element | null | undefined, attr: string): number => {
  expect(el).toBeTruthy()
  const v = el?.getAttribute(attr)
  expect(v).not.toBeNull()
  return Number(v)
}
const group = (c: HTMLElement, label: string) => c.querySelector(`g[data-label="${label}"]`)
const dot = (c: HTMLElement, label: string) => c.querySelector(`circle[data-label="${label}"]`)
const baselineX = (c: HTMLElement) => num(c.querySelector('line.chart-baseline'), 'x1')
const baselineY = (c: HTMLElement) => num(c.querySelector('line.chart-baseline'), 'y1')

describe('Bars', () => {
  it('draws a bar proportional to its value', () => {
    // max 4000 over a 320-unit scale: 1000 -> 80, 2000 -> 160, 4000 -> 320. Exact, so a clamp, a sqrt or a per-bar scale shows.
    const { container } = render(<Bars title="Spending" points={[
      { label: 'A', cents: 1000 }, { label: 'B', cents: 2000 }, { label: 'C', cents: 4000 },
    ]} />)
    const w = (l: string) => num(group(container, l)?.querySelector('rect'), 'width')
    expect([w('A'), w('B'), w('C')]).toEqual([80, 160, 320])
    // All bars start at the same baseline, so length is the only thing that differs.
    const xs = ['A', 'B', 'C'].map((l) => num(group(container, l)?.querySelector('rect'), 'x'))
    expect(xs).toEqual([0, 0, 0])
  })

  it('keeps one scale across the chart when the maximum is not the last point', () => {
    const { container } = render(<Bars title="Spending" points={[{ label: 'A', cents: 4000 }, { label: 'B', cents: 1000 }]} />)
    expect(num(group(container, 'A')?.querySelector('rect'), 'width')).toBe(4 * num(group(container, 'B')?.querySelector('rect'), 'width'))
  })

  it('states the same figures in text, so the chart is not the only way to read them', () => {
    const points = [{ label: 'Food', cents: 12345 }, { label: 'Rent', cents: -50000 }, { label: 'Zero', cents: 0 }]
    const { container, getByRole } = render(<Bars title="By category" points={points} />)
    const table = getByRole('table', { name: 'By category', hidden: true })
    for (const p of points) {
      const row = within(table).getByRole('row', { name: new RegExp(p.label), hidden: true })
      expect(row.textContent).toContain(formatEur(p.cents))
    }
    const svg = container.querySelector('svg')
    expect(svg?.getAttribute('role')).toBe('img')
    expect(svg?.getAttribute('aria-label')).toBe('By category')
    // The svg is described by the very table, so a screen reader is pointed at the numbers.
    expect(svg?.getAttribute('aria-describedby')).toBe(table.id)
    expect(table.className).toBe('sr-only')
  })

  it('shows a zero as zero and a negative below the baseline', () => {
    const { container } = render(<Bars title="Change" points={[
      { label: 'Up', cents: 3000 }, { label: 'Flat', cents: 0 }, { label: 'Down', cents: -1000 },
    ]} />)
    const base = baselineX(container)
    expect(base).toBe(80) // negatives get 1000 of the 4000 span, i.e. 80 of 320
    const up = group(container, 'Up')?.querySelector('rect')
    const down = group(container, 'Down')?.querySelector('rect')
    expect(num(up, 'x')).toBe(base) // positive grows right of the baseline
    expect(num(up, 'width')).toBe(240)
    expect(num(down, 'x') + num(down, 'width')).toBe(base) // negative ends at the baseline and extends left of it
    expect(num(down, 'width')).toBe(80)
    expect(num(down, 'x')).toBeLessThan(base)
    // Zero: a visible mark on the baseline (not a missing bar), labelled "0,00 €", and not a bar at all.
    const flat = group(container, 'Flat')
    expect(flat?.querySelector('rect')).toBeNull()
    const tick = flat?.querySelector('line.chart-zero')
    expect(num(tick, 'x1')).toBe(base)
    expect(num(tick, 'y2') - num(tick, 'y1')).toBeGreaterThan(0)
    expect(flat?.textContent).toContain(formatEur(0))
    expect(group(container, 'Down')?.textContent).toContain(formatEur(-1000))
  })

  it('draws a tiny non-zero amount as a mark rather than as nothing', () => {
    const { container } = render(<Bars title="T" points={[{ label: 'Big', cents: 10_000_000 }, { label: 'Tiny', cents: 1 }]} />)
    expect(num(group(container, 'Tiny')?.querySelector('rect'), 'width')).toBe(1)
  })

  it('renders an all-zero series without dividing by zero', () => {
    const { container } = render(<Bars title="T" points={[{ label: 'A', cents: 0 }, { label: 'B', cents: 0 }]} />)
    expect(container.querySelectorAll('line.chart-zero')).toHaveLength(2)
    expect(container.innerHTML).not.toMatch(/NaN|Infinity/)
  })

  it('renders an empty state for an empty series', () => {
    const { container, getByText } = render(<Bars title="Spending" points={[]} />)
    expect(getByText(/nothing to show yet/)).toBeTruthy()
    expect(container.querySelector('svg')).toBeNull()
    expect(container.querySelector('table')).toBeNull()
  })
})

describe('Line', () => {
  it('places points at heights proportional to their value above the baseline', () => {
    // span 4000 over a plot 100 high: 1000 -> 25, 2000 -> 50, 4000 -> 100 above the baseline.
    const { container } = render(<Line title="Trend" points={[
      { label: 'A', cents: 1000 }, { label: 'B', cents: 2000 }, { label: 'C', cents: 4000 },
    ]} />)
    const base = baselineY(container)
    const rise = (l: string) => base - num(dot(container, l), 'cy')
    expect([rise('A'), rise('B'), rise('C')]).toEqual([25, 50, 100])
    // Spread left to right in order, inside the drawing.
    const xs = ['A', 'B', 'C'].map((l) => num(dot(container, l), 'cx'))
    expect(xs).toEqual([8, 160, 312])
    expect(container.querySelector('polyline')?.getAttribute('points')).toBe(
      ['A', 'B', 'C'].map((l, i) => `${xs[i]},${num(dot(container, l), 'cy')}`).join(' '),
    )
  })

  it('shows a zero on the baseline and a negative below it', () => {
    const { container } = render(<Line title="Change" points={[
      { label: 'Up', cents: 3000 }, { label: 'Flat', cents: 0 }, { label: 'Down', cents: -1000 },
    ]} />)
    const base = baselineY(container)
    expect(num(dot(container, 'Flat'), 'cy')).toBe(base) // visible, on the baseline, not absent
    expect(num(dot(container, 'Up'), 'cy')).toBeLessThan(base) // SVG y grows downward
    expect(base - num(dot(container, 'Up'), 'cy')).toBe(75)
    expect(num(dot(container, 'Down'), 'cy') - base).toBe(25)
  })

  it('states the same figures in text', () => {
    const points = [{ label: 'Oct', cents: 100050 }, { label: 'Nov', cents: -2500 }]
    const { getByRole } = render(<Line title="Net" points={points} />)
    const table = getByRole('table', { name: 'Net', hidden: true })
    for (const p of points) {
      expect(within(table).getByRole('row', { name: new RegExp(p.label), hidden: true }).textContent).toContain(formatEur(p.cents))
    }
  })

  it('draws a single point as a dot, not an empty line', () => {
    const { container } = render(<Line title="One" points={[{ label: 'Only', cents: 500 }]} />)
    expect(container.querySelectorAll('circle')).toHaveLength(1)
    expect(container.querySelector('polyline')).toBeNull()
    expect(container.innerHTML).not.toMatch(/NaN|Infinity/)
  })

  it('renders an empty state for an empty series', () => {
    const { container, getByText } = render(<Line title="Trend" points={[]} />)
    expect(getByText(/nothing to show yet/)).toBeTruthy()
    expect(container.querySelector('svg')).toBeNull()
  })
})

describe('layout at 320px', () => {
  // jsdom does no layout, so overflow cannot be measured. What decides it can be: the drawing is at most 320 units wide,
  // every mark lies inside it, and the stylesheet sizes the svg relatively so it cannot be wider than its container.
  const long = Array.from({ length: 12 }, (_, i) => ({ label: `Month ${i + 1}`, cents: (i % 2 === 0 ? 1 : -1) * 123456 * (i + 1) }))

  for (const [name, ui] of [
    ['Bars', <Bars key="b" title="T" points={long} />],
    ['Line', <Line key="l" title="T" points={long} />],
  ] as const) {
    it(`${name}: viewBox is no wider than 320 and no mark leaves it`, () => {
      const { container } = render(ui)
      const svg = container.querySelector('svg')
      const [minX, , w] = (svg?.getAttribute('viewBox') ?? '').split(' ').map(Number)
      expect(minX).toBe(0)
      expect(w).toBeLessThanOrEqual(320)
      expect(svg?.hasAttribute('width')).toBe(false) // a fixed width attribute would not shrink
      for (const el of Array.from(container.querySelectorAll('rect'))) {
        expect(num(el, 'x')).toBeGreaterThanOrEqual(0)
        expect(num(el, 'x') + num(el, 'width')).toBeLessThanOrEqual(320)
      }
      for (const el of Array.from(container.querySelectorAll('circle'))) {
        expect(num(el, 'cx') - num(el, 'r')).toBeGreaterThanOrEqual(0)
        expect(num(el, 'cx') + num(el, 'r')).toBeLessThanOrEqual(320)
      }
      for (const el of Array.from(container.querySelectorAll('text'))) {
        expect(num(el, 'x')).toBeGreaterThanOrEqual(0)
        expect(num(el, 'x')).toBeLessThanOrEqual(320)
      }
    })
  }

  it('the stylesheet makes the svg fluid and tokenised', () => {
    const css = readFileSync(join(import.meta.dirname, '..', 'app.css'), 'utf8')
    const rule = (sel: string) => new RegExp(`${sel.replace('.', '\\.')}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? ''
    expect(rule('.chart-svg')).toMatch(/width:\s*100%/)
    expect(rule('.chart-svg')).toMatch(/max-width:\s*100%/)
    expect(rule('.chart')).toMatch(/max-width:\s*100%/)
    // Colour comes from the theme tokens, never a literal, so dark mode works.
    for (const sel of ['.chart-text', '.chart-line', '.chart-baseline']) expect(rule(sel)).toMatch(/var\(--/)
    expect(css.slice(css.indexOf('/* Charts'))).not.toMatch(/#[0-9a-fA-F]{3,6}\b/)
  })
})
