// Reduces an ING description to the merchant it names, so that the same shop seen on
// different days (different locality, terminal number, case) is one thing to learn about.
// Input is already scrubbed of personal names (src/import/scrub.ts); this only strips the
// bank's own scaffolding. The empty string is a real answer, "no merchant here", and callers
// must keep it apart from a merchant: never return a bare prefix as if it were a name.

// Transaction prefixes, lowercase, longest first so 'pago bizum en' wins over any shorter one.
const PREFIXES: readonly (readonly string[])[] = [
  ['traspaso', 'recibido', 'de'],
  ['traspaso', 'emitido', 'a'],
  ['pago', 'bizum', 'en'],
  ['recibo', 'de'],
  ['pago', 'en'],
  ['compra', 'en'],
  ['recibo'],
]

const COUNTRY_CODE = /^[A-Z]{2}$/
// A terminal / card reference: a bare run of digits. A digit inside a name ("24H") is not one.
const TERMINAL_NUMBER = /^\d{4,}$/
// A locality is only dropped when at least this many name tokens remain; otherwise the
// last word is part of the name ("Tienda Uno ES" has no locality).
const MIN_NAME_TOKENS = 2

function startsWithPrefix(lower: string[], prefix: readonly string[]): boolean {
  return prefix.every((word, i) => lower[i] === word)
}

function titleCase(token: string): string {
  // A token with a digit ("24H") is a code, not a word: keep it upper-case.
  if (/\d/.test(token)) return token.toUpperCase()
  const lower = token.toLowerCase()
  return lower.charAt(0).toUpperCase() + lower.slice(1)
}

/** The surviving tokens of a description, title-cased, in order. Empty when no merchant is left. */
export function merchantTokens(description: string): string[] {
  let tokens = description
    .normalize('NFC')
    .split(/\s+/)
    .map((t) => t.replace(/^,+|,+$/g, ''))
    .filter((t) => t !== '')

  const lower = tokens.map((t) => t.toLowerCase())
  const prefix = PREFIXES.find((p) => startsWithPrefix(lower, p))
  if (prefix) tokens = tokens.slice(prefix.length)

  while (tokens.length > 0 && TERMINAL_NUMBER.test(tokens[tokens.length - 1] ?? '')) {
    tokens = tokens.slice(0, -1)
  }

  const last = tokens[tokens.length - 1]
  if (last !== undefined && COUNTRY_CODE.test(last)) {
    tokens = tokens.slice(0, -1)
    if (tokens.length > MIN_NAME_TOKENS) tokens = tokens.slice(0, -1)
  }

  return tokens.map(titleCase)
}

/** The canonical merchant name, or '' when nothing survives. */
export function canonicaliseMerchant(description: string): string {
  return merchantTokens(description).join(' ')
}
