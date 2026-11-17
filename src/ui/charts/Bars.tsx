import { useId, type ReactNode } from 'react'
import { formatEur } from '../../lib/money'
import { ChartReading } from './ChartReading'
import { divRound, VIEW_W, type ChartPoint } from './scale'

export interface ChartProps { points: ChartPoint[]; title: string }

const ROW_H = 40
const BAR_H = 14
const BAR_TOP = 20 // within a row; the label and the value share the line above

/**
 * Horizontal bars. One scale for the whole chart: a bar's length is round(|cents| * VIEW_W / span) units, where span is the
 * largest positive plus the largest negative magnitude, so a bar for twice the value is twice as long (exactly, up to the
 * one-unit rounding of integer geometry) and positives and negatives share the unit. The baseline sits at the x that leaves
 * room for the negatives; positives grow right of it, negatives left. A zero is a tick at the baseline (a bar of length 0
 * would vanish), drawn as a <line> so it cannot be mistaken for a short bar. A non-zero amount too small to reach one unit
 * is still drawn one unit long, since "nothing there" would be false. Horizontal, so labels read at 320px.
 */
export function Bars({ points, title }: ChartProps): ReactNode {
  const readingId = useId()
  if (points.length === 0) return <p className="chart-empty">{title}: nothing to show yet.</p>

  const maxPos = Math.max(0, ...points.map((p) => p.cents))
  const maxNeg = Math.max(0, ...points.map((p) => -p.cents))
  const span = Math.max(1, maxPos + maxNeg)
  const baseline = divRound(maxNeg * VIEW_W, span)
  const height = points.length * ROW_H

  return (
    <figure className="chart">
      <figcaption className="chart-title">{title}</figcaption>
      <svg className="chart-svg" viewBox={`0 0 ${VIEW_W} ${height}`} role="img" aria-label={title} aria-describedby={readingId}>
        {points.map((p, i) => {
          const top = i * ROW_H
          const len = p.cents === 0 ? 0 : Math.max(1, divRound(Math.abs(p.cents) * VIEW_W, span))
          return (
            <g key={i} data-label={p.label} data-cents={p.cents}>
              <text className="chart-text" x={0} y={top + 14}>{p.label}</text>
              <text className="chart-text" x={VIEW_W} y={top + 14} textAnchor="end">{formatEur(p.cents)}</text>
              {p.cents === 0
                ? <line className="chart-zero" x1={baseline} x2={baseline} y1={top + BAR_TOP} y2={top + BAR_TOP + BAR_H} />
                : <rect className="chart-bar" x={p.cents > 0 ? baseline : baseline - len} y={top + BAR_TOP} width={len} height={BAR_H} />}
            </g>
          )
        })}
        <line className="chart-baseline" x1={baseline} x2={baseline} y1={0} y2={height} />
      </svg>
      <ChartReading id={readingId} title={title} points={points} />
    </figure>
  )
}
