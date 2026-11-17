import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'

/** Parses the real stylesheet, so a palette edit that breaks contrast fails here. */
const css = readFileSync(resolve(import.meta.dirname, 'app.css'), 'utf8')

function palette(selector: string): Record<string, string> {
  const block = css.split(selector)[1]?.split('}')[0] ?? ''
  return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)].map(m => [m[1]!, m[2]!]))
}
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map(i => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

describe.each([[':root {', 'light'], [":root[data-theme='dark'] {", 'dark']])('%s palette', (selector, name) => {
  const p = palette(selector)
  it(`${name}: defines every token`, () => {
    expect(Object.keys(p).sort()).toEqual(['accent', 'bg', 'border', 'muted', 'on-accent', 'surface', 'text'])
  })
  it.each([['text', 'bg'], ['text', 'surface'], ['muted', 'bg'], ['muted', 'surface'], ['accent', 'bg'], ['accent', 'surface'], ['on-accent', 'accent']])(
    `${name}: %s on %s meets AA text contrast (4.5:1)`, (fg, bg) => {
      expect(ratio(p[fg]!, p[bg]!)).toBeGreaterThanOrEqual(4.5)
    })
  it.each([['border', 'bg'], ['border', 'surface'], ['accent', 'bg']])(
    `${name}: %s against %s meets the non-text contrast minimum (3:1)`, (fg, bg) => {
      expect(ratio(p[fg]!, p[bg]!)).toBeGreaterThanOrEqual(3)
    })
})
