import { useId, type ReactNode } from 'react'
import { ChartReading } from './ChartReading'
import { divRound, VIEW_W } from './scale'
import type { ChartProps } from './Bars'

const PAD_X = 8 // keeps the end markers inside the drawing
const PLOT_TOP = 8
const PLOT_H = 100
const HEIGHT = 144

/**
 * A line over evenly spaced points. The vertical scale always includes zero, so the baseline is drawn and a negative point
 * sits below it: y = PLOT_TOP + round((max - cents) * PLOT_H / span), span = max(0, ...) - min(0, ...). A point's distance
 * from the baseline is therefore proportional to its value. Zero is a marker on the baseline, never a gap. The x axis labels
 * only the first and last points (the rest would collide at 320px); every figure is in the reading table.
 */
export function Line({ points, title }: ChartProps): ReactNode {
  const readingId = useId()
  if (points.length === 0) return <p className="chart-empty">{title}: nothing to show yet.</p>

  const max = Math.max(0, ...points.map((p) => p.cents))
  const min = Math.min(0, ...points.map((p) => p.cents))
  const span = Math.max(1, max - min)
  const yOf = (cents: number) => PLOT_TOP + divRound((max - cents) * PLOT_H, span)
  const xOf = (i: number) => (points.length === 1 ? VIEW_W / 2 : PAD_X + divRound(i * (VIEW_W - 2 * PAD_X), points.length - 1))
  const baseY = yOf(0)
  const first = points[0]
  const last = points[points.length - 1]

  return (
    <figure className="chart">
      <figcaption className="chart-title">{title}</figcaption>
      <svg className="chart-svg" viewBox={`0 0 ${VIEW_W} ${HEIGHT}`} role="img" aria-label={title} aria-describedby={readingId}>
        <line className="chart-baseline" x1={0} x2={VIEW_W} y1={baseY} y2={baseY} />
        {points.length > 1 && (
          <polyline className="chart-line" fill="none" points={points.map((p, i) => `${xOf(i)},${yOf(p.cents)}`).join(' ')} />
        )}
        {points.map((p, i) => (
          <circle key={i} className="chart-dot" data-label={p.label} data-cents={p.cents} cx={xOf(i)} cy={yOf(p.cents)} r={4} />
        ))}
        {first && <text className="chart-text" x={0} y={HEIGHT - 8}>{first.label}</text>}
        {last && points.length > 1 && <text className="chart-text" x={VIEW_W} y={HEIGHT - 8} textAnchor="end">{last.label}</text>}
      </svg>
      <ChartReading id={readingId} title={title} points={points} />
    </figure>
  )
}
