/**
 * Strict standard base64 (RFC 4648 section 4), written with plain integer arithmetic so it behaves the same in every
 * environment: no btoa/atob (atob forgives whitespace and missing padding, which is the opposite of what a damaged
 * backup header needs) and no String.fromCharCode over a whole buffer (that throws on a large one).
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

const VALUE_OF: Record<string, number> = {}
for (let i = 0; i < ALPHABET.length; i++) VALUE_OF[ALPHABET.charAt(i)] = i

export function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = []
  const n = bytes.length
  for (let i = 0; i < n; i += 3) {
    const b0 = bytes[i] ?? 0
    const b1 = bytes[i + 1] ?? 0
    const b2 = bytes[i + 2] ?? 0
    const have = n - i // 1, 2 or more bytes left in this group
    const word = (b0 << 16) | (b1 << 8) | b2
    parts.push(
      ALPHABET.charAt((word >> 18) & 63),
      ALPHABET.charAt((word >> 12) & 63),
      have > 1 ? ALPHABET.charAt((word >> 6) & 63) : '=',
      have > 2 ? ALPHABET.charAt(word & 63) : '=',
    )
  }
  return parts.join('')
}

/** Strict: standard alphabet, padded, length a multiple of 4. Anything else is null, never a partial decode. */
export function base64ToBytes(text: string): Uint8Array | null {
  if (typeof text !== 'string' || text.length % 4 !== 0) return null
  const groups = text.length / 4
  // Padding is allowed only at the very end of the text: one or two '=' closing the last group.
  let pad = 0
  if (text.endsWith('==')) pad = 2
  else if (text.endsWith('=')) pad = 1
  const out = new Uint8Array(groups * 3 - pad)
  let o = 0
  for (let g = 0; g < groups; g++) {
    const last = g === groups - 1
    const quad = text.slice(g * 4, g * 4 + 4)
    const sextets: number[] = []
    for (let k = 0; k < 4; k++) {
      const ch = quad.charAt(k)
      const stripped = last && k >= 4 - pad // these positions must be '=' and nothing else
      if (stripped) {
        if (ch !== '=') return null
        sextets.push(0)
        continue
      }
      const v = VALUE_OF[ch]
      if (v === undefined) return null // outside the alphabet, whitespace, or a '=' in the wrong place
      sextets.push(v)
    }
    const word = ((sextets[0] ?? 0) << 18) | ((sextets[1] ?? 0) << 12) | ((sextets[2] ?? 0) << 6) | (sextets[3] ?? 0)
    // Canonical only: the bits that padding throws away must be zero, or two different texts would mean the same bytes.
    if (last && pad === 2 && (word & 0xffff) !== 0) return null
    if (last && pad === 1 && (word & 0xff) !== 0) return null
    out[o++] = (word >> 16) & 255
    if (!(last && pad === 2)) out[o++] = (word >> 8) & 255
    if (!(last && pad >= 1)) out[o++] = word & 255
  }
  return out
}
