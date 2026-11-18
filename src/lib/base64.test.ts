import { describe, expect, it } from 'vitest'
import { base64ToBytes, bytesToBase64 } from './base64'

const bytes = (...n: number[]) => Uint8Array.from(n)

describe('base64', () => {
  it('round-trips every byte value, and a buffer large enough to overflow a naive fromCharCode', () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i)
    expect(Array.from(base64ToBytes(bytesToBase64(all)) ?? [])).toEqual(Array.from(all))
    // every length remainder (padding of none, one and two)
    for (let n = 0; n < 12; n++) {
      const b = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 200) % 256)
      expect(Array.from(base64ToBytes(bytesToBase64(b)) ?? [-1])).toEqual(Array.from(b))
    }
    // 300 000 bytes: spreading that many into String.fromCharCode throws a RangeError
    const big = Uint8Array.from({ length: 300000 }, (_, i) => (i * 31 + (i >> 8)) % 256)
    const back = base64ToBytes(bytesToBase64(big))
    expect(back).not.toBeNull()
    expect(back?.length).toBe(big.length)
    expect(back?.every((v, i) => v === big[i])).toBe(true)
    // known vectors (RFC 4648)
    expect(bytesToBase64(new Uint8Array(0))).toBe('')
    expect(bytesToBase64(bytes(102))).toBe('Zg==')
    expect(bytesToBase64(bytes(102, 111))).toBe('Zm8=')
    expect(bytesToBase64(bytes(102, 111, 111))).toBe('Zm9v')
    expect(bytesToBase64(bytes(251, 255, 254))).toBe('+//+')
    expect(Array.from(base64ToBytes('+//+') ?? [])).toEqual([251, 255, 254])
    expect(Array.from(base64ToBytes('') ?? [-1])).toEqual([])
  })

  it('rejects base64 with a bad character, bad padding or a cut-short length instead of decoding part of it', () => {
    // wrong length
    expect(base64ToBytes('Zm9')).toBeNull()
    expect(base64ToBytes('Zm9vY')).toBeNull()
    expect(base64ToBytes('Zg=')).toBeNull()
    expect(base64ToBytes('Zm9vYg')).toBeNull()
    // characters outside the standard alphabet
    expect(base64ToBytes('Zm9*')).toBeNull()
    expect(base64ToBytes('Zm9-')).toBeNull() // url-safe alphabet is not accepted
    expect(base64ToBytes('Zm9_')).toBeNull()
    expect(base64ToBytes('Zm9é')).toBeNull()
    expect(base64ToBytes('Zm9\u0000')).toBeNull()
    // whitespace anywhere
    for (const w of [' Zm9v', 'Zm9v ', 'Zm9v\n', 'Zm\n9v', 'Zm 9v', 'Zm9v\r\n', '\tZm9v']) expect(base64ToBytes(w)).toBeNull()
    // padding in the wrong place or the wrong amount
    expect(base64ToBytes('=Zm9')).toBeNull()
    expect(base64ToBytes('Z=m9')).toBeNull()
    expect(base64ToBytes('Zm=9')).toBeNull()
    expect(base64ToBytes('Z===')).toBeNull()
    expect(base64ToBytes('====')).toBeNull()
    expect(base64ToBytes('Zg=A')).toBeNull()
    expect(base64ToBytes('Zm9v====')).toBeNull()
    expect(base64ToBytes('Zg==Zm9v')).toBeNull() // padding in the middle of two joined blocks
    // not canonical: the leftover bits of the last character must be zero, or two texts would mean the same bytes
    expect(base64ToBytes('Zh==')).toBeNull()
    expect(base64ToBytes('Zm9=')).toBeNull()
    expect(Array.from(base64ToBytes('Zg==') ?? [])).toEqual([102])
    expect(Array.from(base64ToBytes('Zm8=') ?? [])).toEqual([102, 111])
    // not text at all
    expect(base64ToBytes(undefined as unknown as string)).toBeNull()
  })
})
