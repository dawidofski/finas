import { describe, expect, it } from 'vitest'
import { fold } from './text'
import { sha256Hex } from './hash'
import { dedupKeyFor } from '../import/normalise'
import { fingerprintAccount } from '../import/scrub'

describe('fold', () => {
  it('removes accents, precomposed or decomposed, and leaves case to the caller', () => {
    expect(fold('Cafetería')).toBe('Cafeteria')
    expect(fold('Téster')).toBe('Tester')
    expect(fold('ÑANDÚ')).toBe('NANDU')
  })
})

describe('sha256Hex', () => {
  it('is the SHA-256 of exactly the bytes given, as lowercase hex', async () => {
    expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  // The helper is shared by three hashes whose inputs are permanent. These literals were computed independently
  // (node:crypto) before the helper was extracted, so a change to what any of them hashes fails here.
  it('leaves the account fingerprint input exactly `${digits}|${salt}`', async () => {
    expect(await fingerprintAccount('1234567890', 'salt-one')).toBe('fdf160b82193af53e7298d51b90267c81765c7f9a9beefc082d35412a58afb27')
  })

  it('leaves the duplicate key input exactly accountId|valueDate|amountCents|balanceCents', async () => {
    const key = await dedupKeyFor({ accountId: 'acc.1', valueDate: '2026-11-15', amountCents: -2320, balanceCents: 50000 })
    expect(key).toBe('480ca7b9fa86e2b1251d45096c4e40aea431ef9280553f9296d41eb6d664458a')
  })
})
