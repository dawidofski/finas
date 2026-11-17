/** round(n / d), halves away from zero, integer-only. d > 0. Same rule as divRound in analysis/income.ts. */
export function divRound(n: number, d: number): number {
  const q = Math.floor(Math.abs(n) / d)
  const r = Math.abs(n) - q * d
  const rounded = r * 2 >= d ? q + 1 : q
  return n < 0 ? -rounded : rounded
}

export interface ChartPoint { label: string; cents: number }

/** The drawing is 320 user units wide, the narrowest phone this app targets. CSS scales it down, and caps it, never past 320 wide of intrinsic detail. */
export const VIEW_W = 320
