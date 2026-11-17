import type { ReactNode } from 'react'
import { formatEur } from '../../lib/money'
import type { ChartPoint } from './scale'

/**
 * The figures as text. Geometry alone is unreadable to a screen reader (and to anyone who cannot judge a length to the
 * cent), so every chart is followed by this real <table>: a table, not a list or aria-labels, because label/amount pairs
 * are exactly what a table is and assistive tech lets the reader walk it row by row. It is visually hidden (.sr-only)
 * so the chart stays the one visual on the screen and this is its reading (design 13.1: one chart plus its reading).
 * The svg is role="img", so its children are not exposed; this table is the only route to the numbers for a screen reader.
 * Money goes through formatEur, never by hand.
 */
export function ChartReading({ id, title, points }: { id: string; title: string; points: ChartPoint[] }): ReactNode {
  return (
    <table id={id} className="sr-only">
      <caption>{title}</caption>
      <thead><tr><th scope="col">Item</th><th scope="col">Amount</th></tr></thead>
      <tbody>
        {points.map((p, i) => (
          <tr key={i}><th scope="row">{p.label}</th><td>{formatEur(p.cents)}</td></tr>
        ))}
      </tbody>
    </table>
  )
}
