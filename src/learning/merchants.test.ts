import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../db/db'
import { seedDatabase } from '../db/seed'
import type { MerchantRow } from '../db/schema'
import { matchMerchant, rememberMerchantName } from './merchants'

const merchant = (id: string, canonicalName: string, matchPatterns: string[], createdAt = 1): MerchantRow => ({
  id, canonicalName, kind: 'merchant', matchPatterns, defaultCategoryId: null, isSubscription: false, createdAt,
})

let uid = 0
const tx = async (id: string, description: string): Promise<void> => {
  await db.transactions.add({
    id, accountId: 'acc.1', valueDate: '2026-11-01', amountCents: -500, balanceCents: 0, description, comment: null,
    ingCategory: null, ingSubcategory: null, kind: 'spend', dedupKey: `k.${++uid}`, importId: 'imp.1', fileSeq: uid,
    roundupParentId: null, createdAt: 1, deletedAt: null,
  })
}

beforeEach(async () => {
  uid = 0
  await db.delete(); await db.open(); await seedDatabase()
})

describe('matchMerchant', () => {
  it('matches on a stored pattern before falling back to canonicalisation', () => {
    const byName = merchant('a', 'Panaderia Sol', [])
    const byPattern = merchant('b', 'Bakery Owner Name', ['panaderia sol'])
    // The canonical name of the description equals A's, but B holds a pattern for it: the pattern wins.
    expect(matchMerchant('Compra en PANADERIA SOL', [byName, byPattern])?.id).toBe('b')
    // With no pattern anywhere, canonicalisation still finds the merchant by name.
    expect(matchMerchant('Compra en PANADERIA SOL', [byName])?.id).toBe('a')
    expect(matchMerchant('Compra en OTRA COSA', [byName, byPattern])).toBeNull()
  })

  it('prefers the longest matching pattern, so a specific pattern beats a general one', () => {
    const general = merchant('g', 'Mercadona', ['mercadona'], 1)
    const specific = merchant('s', 'Mercadona Online', ['mercadona online'], 2)
    const d = 'Compra en MERCADONA ONLINE'
    expect(matchMerchant(d, [general, specific])?.id).toBe('s')
    expect(matchMerchant(d, [specific, general])?.id).toBe('s')
    // Equal lengths: older createdAt wins, whatever the array order (ids chosen to disagree with createdAt).
    const older = merchant('z', 'Older', ['kiosco'], 1)
    const newer = merchant('a', 'Newer', ['kiosco'], 2)
    expect(matchMerchant('Compra en KIOSCO', [newer, older])?.id).toBe('z')
    expect(matchMerchant('Compra en KIOSCO', [older, newer])?.id).toBe('z')
    // Equal length and createdAt: the smaller id wins.
    const idB = merchant('b', 'B', ['kiosco'], 5)
    const idA = merchant('a', 'A', ['kiosco'], 5)
    expect(matchMerchant('Compra en KIOSCO', [idB, idA])?.id).toBe('a')
    expect(matchMerchant('Compra en KIOSCO', [idA, idB])?.id).toBe('a')
  })

  it('never matches a merchant whose pattern is empty, and never stores an empty pattern', async () => {
    const blank = merchant('e', 'Blank', ['', '   ', '--'])
    expect(matchMerchant('Compra en CUALQUIER SITIO', [blank])).toBeNull()
    expect(matchMerchant('', [blank])).toBeNull()
    expect(matchMerchant('Recibo', [merchant('x', '', [])])).toBeNull() // canonical '' is not a merchant
    await tx('t1', 'Recibo')
    await rememberMerchantName('t1', 'Some Name', 10)
    for (const m of await db.merchants.toArray()) {
      expect(m.matchPatterns.length).toBeGreaterThan(0)
      expect(m.matchPatterns.every((p) => p.trim() !== '')).toBe(true)
    }
    await tx('t2', '   ')
    await expect(rememberMerchantName('t2', 'Nothing', 11)).rejects.toThrow()
    await expect(rememberMerchantName('t1', '   ', 12)).rejects.toThrow()
    expect(await db.merchants.count()).toBe(1)
    // A blank pattern already on a reused merchant is dropped, not carried forward.
    await db.merchants.add(merchant('legacy', 'Legacy', ['', '  ']))
    await tx('t3', 'Compra en LEGACY SHOP')
    expect((await rememberMerchantName('t3', 'Legacy', 13)).matchPatterns).toEqual(['Legacy'])
  })

  it('is case- and accent-insensitive when matching, and keeps the owner spelling when storing', async () => {
    const m = merchant('c', 'Café Ñandú', ['café ñandú'])
    expect(matchMerchant('COMPRA EN CAFE NANDU MADRID', [m])?.id).toBe('c')
    expect(matchMerchant('compra en cafe nandu', [merchant('d', 'Other', ['CAFÉ ÑANDÚ'])])?.id).toBe('d')
    expect(matchMerchant('Compra en BANANA', [merchant('n', 'Ana', ['ana'])])).toBeNull() // whole tokens only
    await tx('t1', 'Compra en CAFE NANDU ES')
    const saved = await rememberMerchantName('t1', 'Café Ñandú', 10)
    expect(saved.canonicalName).toBe('Café Ñandú')
    expect(saved.matchPatterns).toEqual(['Café Ñandú'])
  })
})

describe('rememberMerchantName', () => {
  it('an owner-named merchant wins over the canonical name thereafter', async () => {
    // The canonical guess keeps the locality here ("Tienda Uno Madrid"); the owner says it is just "Tienda Uno".
    await tx('t1', 'Compra en TIENDA UNO MADRID')
    expect(matchMerchant('Compra en TIENDA UNO MADRID', await db.merchants.toArray())).toBeNull() // from zero
    const saved = await rememberMerchantName('t1', 'Tienda Uno', 10)
    const merchants = await db.merchants.toArray()
    expect(matchMerchant('Compra en TIENDA UNO MADRID', merchants)?.id).toBe(saved.id)
    expect(matchMerchant('compra en tienda uno madrid 123456', merchants)?.canonicalName).toBe('Tienda Uno')
    expect((await db.annotations.get('t1'))?.merchantId).toBe(saved.id)
    // A merchant that merely shares the canonical guess does not take it back.
    const rival = merchant('rival', 'Tienda Uno Madrid', [], 1)
    expect(matchMerchant('Compra en TIENDA UNO MADRID', [rival, ...merchants])?.id).toBe(saved.id)
  })

  it('takes a pattern the owner now claims from another merchant', async () => {
    await tx('t1', 'Compra en TIENDA UNO MADRID')
    const first = await rememberMerchantName('t1', 'Wrong Name', 10)
    const second = await rememberMerchantName('t1', 'Right Name', 20)
    expect(second.id).not.toBe(first.id)
    expect((await db.merchants.get(first.id))?.matchPatterns).toEqual([])
    expect(matchMerchant('Compra en TIENDA UNO MADRID', await db.merchants.toArray())?.id).toBe(second.id)
  })

  it('reuses an existing merchant rather than creating a second with the same canonical name', async () => {
    await tx('t1', 'Compra en TIENDA UNO MADRID')
    await tx('t2', 'Compra en TIENDA UNO BARCELONA')
    const a = await rememberMerchantName('t1', 'Tienda Uno', 10)
    const b = await rememberMerchantName('t2', '  tienda   UNO ', 20)
    expect(b.id).toBe(a.id)
    expect(await db.merchants.count()).toBe(1)
    expect((await db.merchants.get(a.id))?.matchPatterns).toEqual(['Tienda Uno'])
    // Repeating the same call adds nothing.
    await rememberMerchantName('t1', 'Tienda Uno', 30)
    expect((await db.merchants.get(a.id))?.matchPatterns).toHaveLength(1)
  })

  it('two quick taps create one merchant', async () => {
    await tx('t1', 'Compra en TIENDA UNO MADRID')
    await tx('t2', 'Compra en TIENDA UNO BARCELONA')
    const [a, b] = await Promise.all([rememberMerchantName('t1', 'Tienda Uno', 10), rememberMerchantName('t2', 'Tienda Uno', 11)])
    expect(a.id).toBe(b.id)
    expect(await db.merchants.count()).toBe(1)
    expect((await db.merchants.toArray())[0]?.matchPatterns).toEqual(['Tienda Uno'])
  })

  it('a typed name found in the description covers the next branch', async () => {
    await tx('t1', 'Pago en TIENDA UNO MADRID ES')
    await tx('t2', 'Pago en TIENDA UNO BARCELONA ES')
    const saved = await rememberMerchantName('t1', 'Tienda Uno', 10)
    expect(saved.matchPatterns).toEqual(['Tienda Uno'])
    expect(matchMerchant('Pago en TIENDA UNO BARCELONA ES', await db.merchants.toArray())?.id).toBe(saved.id)
  })

  // No country code follows, so canonicalisation keeps the locality (its documented limit): the description-derived pattern is 'Tienda Uno Madrid'.
  it('a typed name also covers the next branch when canonicalisation kept the locality', async () => {
    await tx('t1', 'Pago en TIENDA UNO MADRID')
    const saved = await rememberMerchantName('t1', 'Tienda Uno', 10)
    expect(saved.matchPatterns).toEqual(['Tienda Uno'])
    expect(matchMerchant('Pago en TIENDA UNO BARCELONA', await db.merchants.toArray())?.id).toBe(saved.id)
  })

  it('a typed name absent from the description falls back to the description and matches only it', async () => {
    await tx('t1', 'Pago en TIENDA UNO MADRID')
    const saved = await rememberMerchantName('t1', 'Supermercado', 10)
    expect(saved.matchPatterns).toEqual(['Tienda Uno Madrid'])
    const all = await db.merchants.toArray()
    expect(matchMerchant('Pago en TIENDA UNO MADRID', all)?.id).toBe(saved.id)
    expect(matchMerchant('Pago en TIENDA UNO BARCELONA', all)).toBeNull()
    expect(matchMerchant('Pago en OTRO SITIO ES', all)).toBeNull()
  })

  it('a broader pattern does not take a narrower one from another merchant', async () => {
    await tx('t1', 'Pago en TIENDA UNO MADRID')
    const narrow = await rememberMerchantName('t1', 'Wrong Name', 10)
    const broad = await rememberMerchantName('t1', 'Tienda Uno', 20)
    expect((await db.merchants.get(narrow.id))?.matchPatterns).toEqual(['Tienda Uno Madrid'])
    // The longer, earlier correction still wins for its own description; the broad one covers the rest.
    const all = await db.merchants.toArray()
    expect(matchMerchant('Pago en TIENDA UNO MADRID', all)?.id).toBe(narrow.id)
    expect(matchMerchant('Pago en TIENDA UNO BARCELONA', all)?.id).toBe(broad.id)
  })

  it('refuses a missing transaction and saves nothing', async () => {
    await expect(rememberMerchantName('nope', 'X', 1)).rejects.toThrow()
    expect(await db.merchants.count()).toBe(0)
  })
})
