// Timezone-independent date primitives. Dates are 'YYYY-MM-DD' strings; all
// arithmetic goes through Date.UTC and the UTC accessors, so the machine's
// timezone can never shift a day.

const MS_PER_DAY = 86_400_000

// Supported domain: Excel serials 61 (1900-03-01) up to the year 9999. Excel
// wrongly treats 1900 as a leap year, so serials 1 to 59 come out one day
// earlier here than Excel displays them (60 is Excel's fictitious 1900-02-29).
// Real statements are far past that; no floor is imposed and behaviour is
// deliberately not adjusted.

// Excel serial number of 1970-01-01.
const EXCEL_EPOCH_OFFSET = 25569

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const SPANISH_RE = /^(\d{2})\/(\d{2})\/(\d{4})$/

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0')
}

function toIso(ms: number): string {
  const d = new Date(ms)
  const year = d.getUTCFullYear()
  if (!Number.isFinite(ms) || !Number.isFinite(year) || year < 1000 || year > 9999) {
    throw new Error(`Date out of supported range: ${ms}`)
  }
  return `${pad(year, 4)}-${pad(d.getUTCMonth() + 1, 2)}-${pad(d.getUTCDate(), 2)}`
}

// Builds UTC midnight for a calendar date, or throws if the date does not exist
// (the round trip catches 31 February, which Date.UTC would silently roll over).
function utcMs(year: number, month: number, day: number, original: string): number {
  const ms = Date.UTC(year, month - 1, day)
  const d = new Date(ms)
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    throw new Error(`Invalid calendar date: ${original}`)
  }
  return ms
}

function isoToMs(iso: string): number {
  const m = ISO_RE.exec(iso)
  if (!m) throw new Error(`Invalid ISO date: ${iso}`)
  return utcMs(Number(m[1]), Number(m[2]), Number(m[3]), iso)
}

export function excelSerialToIso(serial: number): string {
  if (!Number.isInteger(serial) || serial < 1) {
    throw new Error(`Invalid Excel serial: ${serial}`)
  }
  return toIso((serial - EXCEL_EPOCH_OFFSET) * MS_PER_DAY)
}

export function isoToExcelSerial(iso: string): number {
  return isoToMs(iso) / MS_PER_DAY + EXCEL_EPOCH_OFFSET
}

export function parseSpanishDate(raw: string): string {
  const m = SPANISH_RE.exec(raw)
  if (!m) throw new Error(`Invalid dd/mm/yyyy date: ${raw}`)
  return toIso(utcMs(Number(m[3]), Number(m[2]), Number(m[1]), raw))
}

export function monthKeyOf(iso: string): string {
  return toIso(isoToMs(iso)).slice(0, 7)
}

export function daysBetween(isoA: string, isoB: string): number {
  return (isoToMs(isoB) - isoToMs(isoA)) / MS_PER_DAY
}

export function addDays(iso: string, n: number): string {
  if (!Number.isInteger(n)) throw new Error(`Invalid day count: ${n}`)
  return toIso(isoToMs(iso) + n * MS_PER_DAY)
}

/** The UTC calendar date of an epoch-millisecond instant. Used to name the day an import happened. */
export function epochMsToIso(ms: number): string {
  return toIso(ms)
}

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/

/** The month `n` months after (negative: before) a 'YYYY-MM' month. Throws on a malformed month or a count that is not a whole number. */
export function addMonths(month: string, n: number): string {
  const m = MONTH_RE.exec(month)
  if (!m) throw new Error(`Invalid month, expected YYYY-MM: ${month}`)
  if (!Number.isInteger(n)) throw new Error(`Invalid month count: ${n}`)
  const index = Number(m[1]) * 12 + (Number(m[2]) - 1) + n
  const year = Math.floor(index / 12)
  return `${String(year).padStart(4, '0')}-${String(index - year * 12 + 1).padStart(2, '0')}`
}

// ===========================================================================
// DISPLAY ONLY - everything above this line is for computation; the two
// functions below are for the owner's eyes and nothing else.
//
// The 'YYYY-MM-DD' string is the one form that is stored, compared, sorted,
// hashed into a dedupKey, prefixed into a month key and passed to the functions
// above. A dd/MM/yyyy string sorts wrongly, cannot be compared, and is not
// accepted by any of them. So: format at the last moment, in the JSX or the
// sentence that reaches a person, and never feed the result back into anything
// that reasons about a date. If you are about to call one of these from code
// that stores, compares, keys or computes, you want the ISO string you already
// have. (parseSpanishDate above is the matching INPUT direction; it returns ISO.)
// ===========================================================================

/** 'YYYY-MM-DD' as dd/MM/yyyy, for display (spec section 13 and ruling P3-R18). Throws on anything that is not a real calendar date. */
export function formatSpanishDate(iso: string): string {
  isoToMs(iso) // rejects both a malformed string and a day that does not exist, such as 31 February
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** 'YYYY-MM' as "November 2026", for display. Anything that is not a month key comes back unchanged rather than guessed at. */
export function formatMonthTitle(month: string): string {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return month
  return `${MONTH_NAMES[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`
}

/**
 * ISO weekday of 'YYYY-MM-DD': 1 = Monday ... 7 = Sunday. Pure arithmetic on the UTC day count (1970-01-01 was a
 * Thursday), so no Date accessor and no timezone is involved. This is computation, not display.
 */
export function isoWeekday(iso: string): number {
  const days = Math.floor(isoToMs(iso) / MS_PER_DAY)
  return (((days + 3) % 7) + 7) % 7 + 1
}

const SPANISH_WEEKDAYS = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo']

/** An ISO weekday number (1 = Monday ... 7 = Sunday) as Spanish text, for display. Anything else comes back as its own string. */
export function spanishWeekdayName(weekday: number): string {
  return SPANISH_WEEKDAYS[weekday - 1] ?? String(weekday)
}
