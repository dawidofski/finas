// All money is signed integer cents. No floating-point arithmetic touches a
// stored figure; the single `cents / 100` division lives in formatEur (display only).

function assertCents(value: number, name = 'cents'): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new TypeError(`${name} must be an integer number of cents, got ${String(value)}`)
  }
}

// Noise around a two-decimal value shows up as a long run of 0s or 9s.
const NOISE_RUN = /^(0{9,}|9{9,})/

/**
 * Parses a decimal string (as exported, possibly carrying IEEE-754 noise such
 * as `-12.449999999999999`) into integer cents. Works on the string only.
 */
export function parseAmountToCents(raw: string): number {
  if (typeof raw !== 'string' || !/^-?\d+(\.\d+)?$/.test(raw)) {
    throw new TypeError(`Not a decimal amount: ${String(raw)}`)
  }
  const negative = raw.startsWith('-')
  const [intPart = '', frac = ''] = (negative ? raw.slice(1) : raw).split('.')
  let cents = Number(intPart) * 100 + Number(frac.slice(0, 2).padEnd(2, '0'))
  if (frac.length > 2) {
    const tail = frac.slice(2)
    if (/^0+$/.test(tail)) {
      // Trailing zeros (e.g. CSV "0.950"): exact, nothing to round.
    } else if (NOISE_RUN.test(tail)) {
      if (tail.startsWith('9')) cents += 1
    } else {
      throw new TypeError(`Amount has sub-cent precision: ${raw}`)
    }
  }
  if (!Number.isSafeInteger(cents)) throw new RangeError(`Amount out of range: ${raw}`)
  return negative && cents !== 0 ? -cents : cents
}

/**
 * Parses an amount a HUMAN typed in the edit field, in the notation the app displays: "12,50", "-23,20", "1.850,00"
 * and the grouped integer "1.200" (one thousand two hundred). A dot followed by exactly three digits is a thousands
 * group, never a decimal, which is how "1.200" must not become 1,20 EUR. "1.20" and "1.5" are still dot decimals.
 * Anything that is neither a valid grouped form nor a valid plain form throws a TypeError rather than being guessed:
 * "1,200", "0.500", "1.2.3", "12,505".
 *
 * This is deliberately NOT parseAmountToCents, which reads the bank's own exported values and stays exactly as strict
 * as it was: in an ING export "1.200" cannot mean a thousand, so the two parsers must not share a reading.
 */
export function parseTypedAmount(raw: string): number {
  const s = raw.trim().replace(/[\s€]/g, '').replace(/^\+/, '')
  let canonical: string
  if (/^-?[1-9]\d{0,2}(\.\d{3})+(,\d{1,2})?$/.test(s)) {
    // Grouped: dots are thousands separators; an optional comma carries the cents.
    canonical = s.replace(/\./g, '').replace(',', '.')
  } else if (/^-?\d+(,\d{1,2})?$/.test(s)) {
    canonical = s.replace(',', '.')
  } else if (/^-?\d+\.\d{1,2}$/.test(s)) {
    canonical = s
  } else {
    throw new TypeError(`Not an amount: ${raw}`)
  }
  return parseAmountToCents(canonical)
}

/** Integer cents as the edit field shows it, in the app's own locale and without grouping: -2320 -> "-23,20". */
export function centsToTypedString(cents: number): string {
  return centsToString(cents).replace('.', ',')
}

/** Integer cents to a plain decimal string, e.g. -1245 -> "-12.45". */
export function centsToString(cents: number): string {
  assertCents(cents)
  const abs = Math.abs(cents)
  const body = `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
  return cents < 0 ? `-${body}` : body
}

// useGrouping true: CLDR's Spanish minimumGroupingDigits is 2, so by default 1850,00 would print without its
// separator, but `true` resolves to "always", which groups from four digits as the owner's bank does (1.850,00) and as
// amounts read in columns need. An engine that ignores the option falls back to its default.
const EUR = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR', useGrouping: true })

/** Display only: e.g. -1245 -> "-12,45 €" (plain space, ASCII minus). */
export function formatEur(cents: number): string {
  assertCents(cents)
  // "+ 0" turns -0 into 0 so ICU never prints "-0,00".
  return EUR.format(cents / 100 + 0)
    .replace(/[\u00A0\u202F]/g, ' ')
    .replace(/\u2212/g, '-')
}

export function sumCents(values: number[]): number {
  let total = 0
  for (const v of values) {
    assertCents(v)
    total += v
    if (!Number.isSafeInteger(total)) throw new RangeError('Sum out of range')
  }
  return total
}

/** round(numerator / denominator), halves away from zero, integer-only. */
function divRound(numerator: number, denominator: number): number {
  const sign = numerator < 0 === denominator < 0 ? 1 : -1
  const n = Math.abs(numerator)
  const d = Math.abs(denominator)
  const q = Math.floor(n / d)
  const r = n - q * d
  return sign * (r * 2 >= d ? q + 1 : q) || 0
}

/** cents * bp / 10000, rounded half away from zero. 1 bp = 0.01%. */
export function applyPercentBp(cents: number, bp: number): number {
  assertCents(cents)
  assertCents(bp, 'bp')
  const product = cents * bp
  if (!Number.isSafeInteger(product)) throw new RangeError('Amount out of range')
  return divRound(product, 10000)
}

/** part / whole as basis points, rounded half away from zero; 0 when whole is 0. */
export function percentBpOf(part: number, whole: number): number {
  assertCents(part, 'part')
  assertCents(whole, 'whole')
  if (whole === 0) return 0
  const scaled = part * 10000
  if (!Number.isSafeInteger(scaled)) throw new RangeError('Amount out of range')
  return divRound(scaled, whole)
}
