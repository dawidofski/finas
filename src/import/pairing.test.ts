import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../db/db'
import { seedDatabase } from '../db/seed'
import type { TransferRow } from '../db/schema'
import type { CandidateRow } from './normalise'
import { transactionRowReads } from '../test/reads'
import { chooseRoundupParent, linkRoundups, pairAcrossAccounts, parseRoundupParent, roundupContext, unmatchedTransferCount, unmatchedTransfers } from './pairing'

let uid = 0

type Move = { date: string; cents: number; description?: string; kind?: CandidateRow['kind'] }

/**
 * A file the way ING writes it: newest first, balance chain derived from an opening balance.
 * `moves` are given oldest first, which is how a person thinks about them.
 */
const file = (accountId: string, opening: number, moves: Move[]): CandidateRow[] => {
  let balance = opening
  const rows = moves.map((m, i): CandidateRow => {
    balance += m.cents
    return {
      accountId, valueDate: m.date, amountCents: m.cents, balanceCents: balance,
      description: m.description ?? 'Pago en TIENDA INVENTADA', comment: null, ingCategory: null, ingSubcategory: null,
      kind: m.kind ?? 'spend', dedupKey: `key.${++uid}.${i}`, fileSeq: 0, roundupParentId: null,
    }
  })
  return rows.reverse().map((r, i) => ({ ...r, fileSeq: i + 1 }))
}

/** Stores rows as committed transactions and returns their ids in the same order. */
const commit = async (rows: CandidateRow[]): Promise<string[]> => {
  const ids: string[] = []
  for (const r of rows) {
    const id = `t.${++uid}`
    await db.transactions.add({ ...r, id, importId: 'imp.x', createdAt: 1, deletedAt: null })
    ids.push(id)
  }
  return ids
}

const roundupText = (parent: string): string => `Redondeo por tu compra de ${parent}`

const resetDb = async (): Promise<void> => {
  uid = 0
  await db.delete(); await db.open(); await seedDatabase()
  for (const id of ['acc.spend', 'acc.save']) {
    await db.accounts.add({ id, fingerprint: (id === 'acc.spend' ? 'a' : 'b').repeat(64), label: id, last4: null, currency: 'EUR', createdAt: 1, archived: false })
  }
}

beforeEach(resetDb)

/** One stored leg with a chosen id and fileSeq, for tests whose point is the tie-break order. */
const put = async (id: string, accountId: string, valueDate: string, amountCents: number, fileSeq: number,
  kind: CandidateRow['kind'] = 'internal', description = 'Traspaso inventado'): Promise<string> => {
  await db.transactions.add({
    id, accountId, valueDate, amountCents, balanceCents: 0, description, comment: null, ingCategory: null,
    ingSubcategory: null, kind, dedupKey: `dk.${id}`, importId: 'imp.x', fileSeq, roundupParentId: null,
    createdAt: 1, deletedAt: null,
  })
  return id
}

describe('parseRoundupParent', () => {
  it.each([
    ['tu compra de 34 EUR y 78 cts', 3478],
    ['tu recibo de 7 EUR y 99 cts', 799],
    ['Redondeo: tu compra de 23 EUR y 20 cts en TIENDA', 2320],
    ['no amount here', null],
  ])('parses %s', (text, expected) => {
    expect(parseRoundupParent(text)).toBe(expected)
  })
})

describe('linkRoundups', () => {
  it('links a round-up to its parent when the amount is unique that day', () => {
    const rows = file('acc.spend', 50000, [
      { date: '2026-11-03', cents: -2320 },
      { date: '2026-11-03', cents: -555 }, // sits between them, so adjacency is not what decides
      { date: '2026-11-03', cents: -160, description: roundupText('23 EUR y 20 cts'), kind: 'roundup' },
    ])
    // newest first: [round-up, -5,55, -23,20]
    expect(linkRoundups(rows)).toEqual([{ roundupIndex: 0, parentIndex: 2, basis: 'unique-amount' }])
  })

  it('resolves two identical same-day parents by balance-chain adjacency (§33.2)', () => {
    const phrase = roundupText('23 EUR y 20 cts')
    const rows = file('acc.spend', 20000, [
      { date: '2026-11-05', cents: -2320 },
      { date: '2026-11-05', cents: -160, description: phrase, kind: 'roundup' },
      { date: '2026-11-05', cents: -2320 },
      { date: '2026-11-05', cents: -160, description: phrase, kind: 'roundup' },
    ])
    // The chain reproduces the figures the rule rests on: 176,80 -> 175,20 and 152,00 -> 150,40.
    expect(rows.map((r) => r.balanceCents)).toEqual([15040, 15200, 17520, 17680])
    expect(linkRoundups(rows)).toEqual([
      { roundupIndex: 0, parentIndex: 1, basis: 'adjacency' },
      { roundupIndex: 2, parentIndex: 3, basis: 'adjacency' },
    ])
  })

  it('reports ambiguous only when adjacency also ties', () => {
    // Two identical parents and two round-ups, with an unrelated purchase between them: no round-up sits
    // directly after a parent, so the chain offers no evidence and the link must be null, not guessed.
    const phrase = roundupText('23 EUR y 20 cts')
    const rows = file('acc.spend', 20000, [
      { date: '2026-11-05', cents: -2320 },
      { date: '2026-11-05', cents: -2320 },
      { date: '2026-11-05', cents: -500 },
      { date: '2026-11-05', cents: -160, description: phrase, kind: 'roundup' },
      { date: '2026-11-05', cents: -160, description: phrase, kind: 'roundup' },
    ])
    const links = linkRoundups(rows)
    expect(links).toHaveLength(2)
    for (const l of links) expect(l).toMatchObject({ parentIndex: null, basis: 'ambiguous' })
  })

  it('does not report adjacency when the neighbour is next to it but the chain does not hold', () => {
    const phrase = roundupText('23 EUR y 20 cts')
    const rows = file('acc.spend', 20000, [
      { date: '2026-11-05', cents: -2320 },
      { date: '2026-11-05', cents: -2320 },
      { date: '2026-11-05', cents: -160, description: phrase, kind: 'roundup' },
    ])
    const broken = rows.map((r, i) => (i === 0 ? { ...r, balanceCents: r.balanceCents + 1 } : r))
    expect(linkRoundups(broken)).toEqual([{ roundupIndex: 0, parentIndex: null, basis: 'ambiguous' }])
  })

  it('leaves parentIndex null for a round-up whose parent is not in this file', () => {
    const rows = file('acc.spend', 20000, [
      { date: '2026-11-05', cents: -999 },
      { date: '2026-11-05', cents: -160, description: roundupText('23 EUR y 20 cts'), kind: 'roundup' },
    ])
    expect(linkRoundups(rows)).toEqual([{ roundupIndex: 0, parentIndex: null, basis: 'none' }])
  })
})

describe('pairAcrossAccounts', () => {
  const internalOut = (date: string, cents: number): Move => ({ date, cents, description: 'Traspaso inventado', kind: 'internal' })

  it('pairs an internal transfer with its opposite leg in another account', async () => {
    const [out] = await commit(file('acc.spend', 50000, [internalOut('2026-11-04', -2500)]))
    const [inn] = await commit(file('acc.save', 10000, [internalOut('2026-11-04', 2500)]))
    const pairs = await pairAcrossAccounts('acc.spend', [out ?? ''])
    expect(pairs).toHaveLength(1)
    expect(pairs[0]).toMatchObject({ outTransactionId: out, inTransactionId: inn, amountCents: 2500, matchScore: 100, confirmedByUser: false })
  })

  it('pairs a round-up outflow with the savings-account inflow', async () => {
    const phrase = roundupText('23 EUR y 20 cts')
    const [out] = await commit(file('acc.spend', 50000, [{ date: '2026-11-04', cents: -160, description: phrase, kind: 'roundup' }]))
    const [inn] = await commit(file('acc.save', 10000, [{ date: '2026-11-04', cents: 160, description: phrase, kind: 'roundup' }]))
    const pairs = await pairAcrossAccounts('acc.spend', [out ?? ''])
    expect(pairs).toHaveLength(1)
    expect(pairs[0]).toMatchObject({ outTransactionId: out, inTransactionId: inn, linkKind: 'roundup', matchScore: 100 })
  })

  it('does not pair two legs within the same account', async () => {
    const ids = await commit(file('acc.spend', 50000, [internalOut('2026-11-04', -2500), internalOut('2026-11-04', 2500)]))
    expect(await pairAcrossAccounts('acc.spend', ids)).toEqual([])
  })

  it('scores a same-day match above a windowed one, and a windowed one at 100 - 10 per day', async () => {
    const [a] = await commit(file('acc.spend', 50000, [internalOut('2026-11-10', -2500)]))
    await commit(file('acc.save', 10000, [internalOut('2026-11-13', 2500)])) // 3 days off
    const [b] = await commit(file('acc.spend', 40000, [internalOut('2026-11-20', -700)]))
    await commit(file('acc.save', 20000, [internalOut('2026-11-20', 700)]))
    const windowed = await pairAcrossAccounts('acc.spend', [a ?? ''])
    const sameDay = await pairAcrossAccounts('acc.spend', [b ?? ''])
    expect(windowed[0]?.matchScore).toBe(70)
    expect(sameDay[0]?.matchScore).toBe(100)
  })

  it('does not match beyond three days', async () => {
    const [a] = await commit(file('acc.spend', 50000, [internalOut('2026-11-10', -2500)]))
    await commit(file('acc.save', 10000, [internalOut('2026-11-14', 2500)]))
    expect(await pairAcrossAccounts('acc.spend', [a ?? ''])).toEqual([])
  })

  it('prefers the same-day leg over a windowed one, and uses each leg at most once', async () => {
    const [a] = await commit(file('acc.spend', 50000, [internalOut('2026-11-10', -2500)]))
    const [near, same] = [
      (await commit(file('acc.save', 10000, [internalOut('2026-11-11', 2500)])))[0],
      (await commit(file('acc.save', 20000, [internalOut('2026-11-10', 2500)])))[0],
    ]
    const pairs = await pairAcrossAccounts('acc.spend', [a ?? ''])
    expect(pairs).toHaveLength(1)
    expect(pairs[0]?.inTransactionId).toBe(same)
    expect(pairs[0]?.inTransactionId).not.toBe(near)
  })

  it('breaks equal scores deterministically by date, then fileSeq, then id', async () => {
    const [a] = await commit(file('acc.spend', 50000, [internalOut('2026-11-10', -2500)]))
    // Equal score (both one day away): the earlier valueDate wins.
    const [later] = await commit(file('acc.save', 10000, [internalOut('2026-11-11', 2500)]))
    const [earlier] = await commit(file('acc.save', 20000, [internalOut('2026-11-09', 2500)]))
    const first = await pairAcrossAccounts('acc.spend', [a ?? ''])
    const second = await pairAcrossAccounts('acc.spend', [a ?? ''])
    expect(first[0]?.inTransactionId).toBe(earlier)
    expect(first[0]?.inTransactionId).not.toBe(later)
    expect(second[0]?.inTransactionId).toBe(earlier)
  })

  it('does not re-pair a leg already named by a stored transfer', async () => {
    const [out] = await commit(file('acc.spend', 50000, [internalOut('2026-11-04', -2500)]))
    const [inn] = await commit(file('acc.save', 10000, [internalOut('2026-11-04', 2500)]))
    const stored: TransferRow = {
      id: 'tr.1', outTransactionId: out ?? '', inTransactionId: inn ?? '', amountCents: 2500, matchScore: 100,
      confirmedByUser: false, matchedAt: 1, linkKind: 'internal',
    }
    await db.transfers.add(stored)
    expect(await pairAcrossAccounts('acc.spend', [out ?? ''])).toEqual([])
  })

  it('leaves an unmatched internal movement unpaired and reportable', async () => {
    const [out] = await commit(file('acc.spend', 50000, [internalOut('2026-11-04', -2500)]))
    expect(await pairAcrossAccounts('acc.spend', [out ?? ''])).toEqual([])
    const unmatched = await unmatchedTransfers('acc.spend')
    expect(unmatched.map((t) => t.id)).toEqual([out])
  })

  it('sets linkKind to internal or roundup', async () => {
    const [t1] = await commit(file('acc.spend', 50000, [internalOut('2026-11-04', -2500)]))
    await commit(file('acc.save', 10000, [internalOut('2026-11-04', 2500)]))
    const phrase = roundupText('7 EUR y 99 cts')
    const [r1] = await commit(file('acc.spend', 40000, [{ date: '2026-11-08', cents: -100, description: phrase, kind: 'roundup' }]))
    await commit(file('acc.save', 20000, [{ date: '2026-11-08', cents: 100, description: phrase, kind: 'roundup' }]))
    const pairs = await pairAcrossAccounts('acc.spend', [t1 ?? '', r1 ?? ''])
    expect(pairs.map((p) => p.linkKind).sort()).toEqual(['internal', 'roundup'])
  })

  it('does not write: the transfers table stays empty', async () => {
    const [out] = await commit(file('acc.spend', 50000, [internalOut('2026-11-04', -2500)]))
    await commit(file('acc.save', 10000, [internalOut('2026-11-04', 2500)]))
    await pairAcrossAccounts('acc.spend', [out ?? ''])
    expect(await db.transfers.count()).toBe(0)
  })

  // Finding 1: a round-up is keyed on kind and parent phrase, not on amount and date alone.
  it('never pairs a round-up outflow with an internal inflow of the same amount and date', async () => {
    const out = await put('r.out', 'acc.spend', '2026-11-04', -160, 1, 'roundup', roundupText('23 EUR y 20 cts'))
    await put('i.in', 'acc.save', '2026-11-04', 160, 1, 'internal')
    expect(await pairAcrossAccounts('acc.spend', [out])).toEqual([])
  })

  it('never pairs a round-up outflow with a round-up inflow naming a different parent', async () => {
    // 23,20 EUR and 2,20 EUR both round up by 1,60 EUR under the x2 setting.
    const out = await put('r.out', 'acc.spend', '2026-11-04', -160, 1, 'roundup', roundupText('23 EUR y 20 cts'))
    await put('r.in', 'acc.save', '2026-11-04', 160, 1, 'roundup', roundupText('2 EUR y 20 cts'))
    expect(await pairAcrossAccounts('acc.spend', [out])).toEqual([])
  })

  // Finding 2: the window is for internal transfers only.
  it('gives a round-up no window: one day apart does not pair', async () => {
    const phrase = roundupText('23 EUR y 20 cts')
    const out = await put('r.out', 'acc.spend', '2026-11-04', -160, 1, 'roundup', phrase)
    await put('r.in', 'acc.save', '2026-11-05', 160, 1, 'roundup', phrase)
    expect(await pairAcrossAccounts('acc.spend', [out])).toEqual([])
  })

  // Finding 3.1
  it('lets exactly one of two committed legs claim a single pool leg (lowest fileSeq wins)', async () => {
    const a = await put('c.a', 'acc.spend', '2026-11-04', -2500, 2)
    const b = await put('c.b', 'acc.spend', '2026-11-04', -2500, 1)
    const target = await put('p.in', 'acc.save', '2026-11-04', 2500, 1)
    const pairs = await pairAcrossAccounts('acc.spend', [a, b])
    expect(pairs).toHaveLength(1)
    expect(pairs[0]).toMatchObject({ outTransactionId: b, inTransactionId: target })
  })

  // Finding 3.2
  it('gives the same pairing whatever order the rows were stored in', async () => {
    const legs: Array<[string, string, string, number, number]> = [
      ['c.1', 'acc.spend', '2026-11-04', -2500, 1], ['c.2', 'acc.spend', '2026-11-04', -2500, 2],
      ['p.1', 'acc.save', '2026-11-04', 2500, 1], ['p.2', 'acc.save', '2026-11-05', 2500, 2],
      ['p.3', 'acc.save', '2026-11-03', 2500, 3],
    ]
    const run = async (order: number[]): Promise<string[]> => {
      await resetDb()
      for (const i of order) { const l = legs[i]; if (l) await put(...l) }
      const pairs = await pairAcrossAccounts('acc.spend', ['c.1', 'c.2'])
      return pairs.map((p) => `${p.outTransactionId}>${p.inTransactionId}@${p.matchScore}`).sort()
    }
    const forward = await run([0, 1, 2, 3, 4])
    expect(forward).toHaveLength(2)
    expect(await run([4, 3, 2, 1, 0])).toEqual(forward)
    expect(await run([2, 4, 0, 3, 1])).toEqual(forward)
  })

  // Finding 3.4
  it('breaks an equal score and date by fileSeq, then by id', async () => {
    const c = await put('c.1', 'acc.spend', '2026-11-04', -2500, 1)
    await put('p.a', 'acc.save', '2026-11-04', 2500, 2) // lower id, higher fileSeq
    await put('p.z', 'acc.save', '2026-11-04', 2500, 1) // higher id, lower fileSeq: fileSeq decides
    expect((await pairAcrossAccounts('acc.spend', [c]))[0]?.inTransactionId).toBe('p.z')

    await resetDb()
    const c2 = await put('c.1', 'acc.spend', '2026-11-04', -2500, 1)
    await put('p.z', 'acc.save', '2026-11-04', 2500, 1)
    await put('p.a', 'acc.save', '2026-11-04', 2500, 1) // same fileSeq: id decides
    expect((await pairAcrossAccounts('acc.spend', [c2]))[0]?.inTransactionId).toBe('p.a')
  })

  // Finding 3.5
  it('unmatchedTransfers excludes a leg already named by a stored transfer', async () => {
    const paired = await put('i.paired', 'acc.spend', '2026-11-04', -2500, 1)
    const lone = await put('i.lone', 'acc.spend', '2026-11-06', -700, 2)
    const other = await put('i.other', 'acc.save', '2026-11-04', 2500, 1)
    await db.transfers.add({
      id: 'tr.1', outTransactionId: paired, inTransactionId: other, amountCents: 2500, matchScore: 100,
      confirmedByUser: false, matchedAt: 1, linkKind: 'internal',
    })
    expect((await unmatchedTransfers('acc.spend')).map((t) => t.id)).toEqual([lone])
  })
})

describe('unmatchedTransferCount', () => {
  it('counts exactly what unmatchedTransfers lists over every account, from keys alone', async () => {
    const paired = await put('i.paired', 'acc.spend', '2026-11-04', -2500, 1)
    await put('i.lone', 'acc.spend', '2026-11-06', -700, 2)
    await put('i.lone2', 'acc.save', '2026-11-07', 900, 1)
    const gone = await put('i.gone', 'acc.save', '2026-11-08', 400, 2)
    await db.transactions.update(gone, { deletedAt: 5 }) // a deleted leg is not waiting for anything
    await put('s.1', 'acc.spend', '2026-11-09', -300, 3, 'spend', 'Compra')
    const other = await put('i.other', 'acc.save', '2026-11-04', 2500, 1)
    await db.transfers.add({
      id: 'tr.1', outTransactionId: paired, inTransactionId: other, amountCents: 2500, matchScore: 100,
      confirmedByUser: false, matchedAt: 1, linkKind: 'internal',
    })
    const listed = (await unmatchedTransfers('acc.spend')).length + (await unmatchedTransfers('acc.save')).length
    expect(listed).toBe(2)
    const reads = await transactionRowReads(async () => { expect(await unmatchedTransferCount()).toBe(listed) })
    expect(reads).toBe(0)
  })
})

describe('round-up parent choice (spec 39.2)', () => {
  // The round-up names a 34,78 EUR purchase; two identical purchases that day make the balance chain unable to choose.
  const setup = async () => {
    await put('buy.a', 'acc.spend', '2026-11-04', -3478, 2, 'spend', 'Compra EN TIENDA A')
    await put('buy.b', 'acc.spend', '2026-11-04', -3478, 3, 'spend', 'Compra EN TIENDA B')
    await put('other.day', 'acc.spend', '2026-11-05', -3478, 1, 'spend', 'Compra otro dia')
    await put('other.amount', 'acc.spend', '2026-11-04', -2100, 4, 'spend', 'Compra otro importe')
    await put('other.acct', 'acc.save', '2026-11-04', -3478, 1, 'spend', 'Compra otra cuenta')
    // Same day, account and amount, but money moving between the owner's own accounts is not a purchase.
    await put('other.kind', 'acc.spend', '2026-11-04', -3478, 5, 'internal', 'Traspaso inventado')
    return put('ru', 'acc.spend', '2026-11-04', -22, 1, 'roundup', roundupText('34 EUR y 78 cts'))
  }

  it('offers exactly the purchases of that day and account for the named amount, and no parent yet', async () => {
    const ru = await setup()
    const context = await roundupContext(ru)
    expect(context?.parent).toBeNull()
    expect(context?.candidates.map((c) => c.id)).toEqual(['buy.a', 'buy.b'])
  })

  it('is null for anything that is not an outflow round-up naming a purchase', async () => {
    await setup()
    expect(await roundupContext('buy.a')).toBeNull()
    expect(await roundupContext('nope')).toBeNull()
    await put('ru.noname', 'acc.spend', '2026-11-04', -22, 5, 'roundup', 'Redondeo sin parent')
    expect(await roundupContext('ru.noname')).toBeNull()
    await put('ru.in', 'acc.save', '2026-11-04', 22, 2, 'roundup', roundupText('34 EUR y 78 cts'))
    expect(await roundupContext('ru.in')).toBeNull()
  })

  it('writes the owner override through writeAnnotation, so the choice leaves its learning event', async () => {
    const ru = await setup()
    await chooseRoundupParent(ru, 'buy.b')
    expect(await db.annotations.get(ru)).toMatchObject({ roundupParentIdOverride: 'buy.b' })
    expect((await db.transactions.get(ru))?.roundupParentId).toBeNull() // the bank's row is never touched
    const events = await db.learningEvents.toArray()
    expect(events.map((e) => e.type)).toEqual(['roundupParent'])
    expect((await roundupContext(ru))?.parent?.id).toBe('buy.b')
  })

  it('refuses a purchase the list would not have offered, and writes nothing', async () => {
    const ru = await setup()
    for (const wrong of ['other.day', 'other.amount', 'other.acct', 'other.kind', 'ru', 'missing']) {
      await expect(chooseRoundupParent(ru, wrong)).rejects.toThrow(/does not fit/)
    }
    await expect(chooseRoundupParent('buy.a', 'buy.b')).rejects.toThrow(/not a round-up/)
    expect(await db.annotations.count()).toBe(0)
    expect(await db.learningEvents.count()).toBe(0)
  })
})
