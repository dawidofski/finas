import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../db/db'
import { seedDatabase } from '../db/seed'
import type { AnnotationRow, BudgetAllocationRow, TransactionRow } from '../db/schema'
import { deleteAllocation, saveAllocation } from '../budget/allocations'
import { monthlyBudget } from '../budget/month'
import { linkRefund, unlinkRefund } from '../import/refunds'
import { ENGINE_VERSION, cached, inputsHash, rebuildAnalytics } from './cache'
import { monthSummary } from './monthly'

let uid = 0
const tx = async (id: string, deletedAt: number | null = null): Promise<void> => {
  await db.transactions.add({
    id, accountId: 'acc.1', valueDate: '2026-11-03', amountCents: -1000, balanceCents: 0, description: 'Movimiento inventado',
    comment: null, ingCategory: 'Otros', ingSubcategory: 'Otros', kind: 'spend', dedupKey: `k.${++uid}`, importId: 'imp.1',
    fileSeq: uid, roundupParentId: null, createdAt: 1, deletedAt,
  } satisfies TransactionRow)
}
const annotate = async (transactionId: string, updatedAt: number, note: string | null = null): Promise<void> => {
  await db.annotations.put({
    transactionId, categoryId: null, subcategoryId: null, merchantId: null, typeOverride: null, paymentMethod: null, note,
    moodId: null, purchaseReasonId: null, worthwhile: null, reviewed: false, dateOverride: null, amountCentsOverride: null,
    descriptionOverride: null, updatedAt,
  } satisfies AnnotationRow)
}

/** A bank row with the fields a test cares about; everything else is filler. */
const addTx = async (row: Partial<TransactionRow> & { id: string }): Promise<void> => {
  const seq = ++uid
  await db.transactions.add({
    accountId: 'acc.1', valueDate: '2026-11-03', amountCents: -1000, balanceCents: 0, description: 'Movimiento inventado',
    comment: null, ingCategory: null, ingSubcategory: null, kind: 'spend', dedupKey: `k.${seq}`, importId: 'imp.1',
    fileSeq: seq, roundupParentId: null, createdAt: 1, deletedAt: null, ...row,
  } satisfies TransactionRow)
}

/** The owner filing a purchase under a category, which is what decides which budget line owns its euros. */
const categorise = async (transactionId: string, categoryId: string, updatedAt: number): Promise<void> => {
  await annotate(transactionId, updatedAt)
  await db.annotations.update(transactionId, { categoryId })
}

const allocation = (over: Partial<Omit<BudgetAllocationRow, 'id'>>): Omit<BudgetAllocationRow, 'id'> => ({
  categoryId: null, savingsGoalId: null, percentBp: null, fixedCents: null, effectiveFrom: '2026-11-01', note: null, ...over,
})

/** A compute function that returns a different value on every call, so the value received says which computation made it. */
const counter = () => {
  let calls = 0
  return { compute: async () => `figure-${++calls}`, calls: () => calls }
}

beforeEach(async () => {
  uid = 0
  await db.delete(); await db.open(); await seedDatabase()
})

describe('cached', () => {
  it('computes on a miss and serves the stored payload on a hit', async () => {
    const c = counter()
    expect(await cached('k', c.compute, 100)).toBe('figure-1')
    expect(await cached('k', c.compute, 200)).toBe('figure-1')
    expect(c.calls()).toBe(1)
    const row = await db.analyticsCache.get('k')
    expect(row).toMatchObject({ key: 'k', engineVersion: ENGINE_VERSION, computedAt: 100, inputsHash: await inputsHash() })
  })

  it('recomputes when the engine version has moved on, and never serves the old payload', async () => {
    // A row that is valid in every respect except its version: same key, current inputs, a well-formed payload.
    await db.analyticsCache.put({
      key: 'k', engineVersion: ENGINE_VERSION - 1, inputsHash: await inputsHash(), computedAt: 1,
      payload: { shape: 1, value: 'OLD-FORMULA-NUMBER' },
    })
    const c = counter()
    const received = await cached('k', c.compute, 500)
    expect(received).toBe('figure-1')
    expect(received).not.toBe('OLD-FORMULA-NUMBER')
    expect(await db.analyticsCache.get('k')).toMatchObject({ engineVersion: ENGINE_VERSION, computedAt: 500 })
    expect(await cached('k', c.compute, 600)).toBe('figure-1') // and the new one is what is now served
  })

  it('treats a payload in an older shape as a miss', async () => {
    await db.analyticsCache.put({ key: 'k', engineVersion: ENGINE_VERSION, inputsHash: await inputsHash(), computedAt: 1, payload: 'bare-old-value' })
    const c = counter()
    expect(await cached('k', c.compute, 5)).toBe('figure-1')
    await db.analyticsCache.put({ key: 'k', engineVersion: ENGINE_VERSION, inputsHash: await inputsHash(), computedAt: 1, payload: null })
    expect(await cached('k', c.compute, 5)).toBe('figure-2')
  })

  it('recomputes when a transaction is added, soft-deleted, or restored', async () => {
    await tx('a')
    const c = counter()
    expect(await cached('k', c.compute, 1)).toBe('figure-1')
    await tx('b') // added
    expect(await cached('k', c.compute, 2)).toBe('figure-2')
    expect(await cached('k', c.compute, 3)).toBe('figure-2')
    await db.transactions.update('b', { deletedAt: 10 }) // soft-deleted
    expect(await cached('k', c.compute, 4)).toBe('figure-3')
    expect(await cached('k', c.compute, 5)).toBe('figure-3')
    await db.transactions.update('b', { deletedAt: null }) // restored
    expect(await cached('k', c.compute, 6)).toBe('figure-4')
  })

  it('recomputes after one transaction is soft-deleted and a different one restored', async () => {
    await tx('a'); await tx('b', 10)
    const c = counter()
    expect(await cached('k', c.compute, 1)).toBe('figure-1')
    await db.transactions.update('a', { deletedAt: 20 })
    await db.transactions.update('b', { deletedAt: null })
    expect(await cached('k', c.compute, 2)).toBe('figure-2')
  })

  it('recomputes when an annotation changes', async () => {
    await tx('a')
    const c = counter()
    expect(await cached('k', c.compute, 1)).toBe('figure-1')
    await annotate('a', 10) // created
    expect(await cached('k', c.compute, 2)).toBe('figure-2')
    expect(await cached('k', c.compute, 3)).toBe('figure-2')
    await annotate('a', 20, 'edited') // same count, later updatedAt
    expect(await cached('k', c.compute, 4)).toBe('figure-3')
  })

  it('keeps entries for other keys when one key recomputes', async () => {
    const a = counter(); const b = counter()
    await cached('a', a.compute, 1)
    await cached('b', b.compute, 1)
    await tx('x') // moves the inputs: both entries are now stale, but nothing has recomputed 'b' yet
    expect(await cached('a', a.compute, 2)).toBe('figure-2')
    expect(await db.analyticsCache.get('b')).toMatchObject({ computedAt: 1, payload: { value: 'figure-1' } })
    expect(await db.analyticsCache.count()).toBe(2)
  })

  it('does not store a failed computation', async () => {
    await expect(cached('k', async () => { throw new Error('boom') }, 1)).rejects.toThrow('boom')
    expect(await db.analyticsCache.count()).toBe(0)
  })
})

describe('inputsHash', () => {
  it('is 64 hex characters, stable while nothing changes, and moves with each of its four inputs', async () => {
    await tx('a'); await tx('b')
    const h0 = await inputsHash()
    expect(h0).toMatch(/^[0-9a-f]{64}$/)
    expect(await inputsHash()).toBe(h0)
    await tx('c')
    const h1 = await inputsHash(); expect(h1).not.toBe(h0)
    await db.transactions.update('c', { deletedAt: 5 })
    const h2 = await inputsHash(); expect([h0, h1]).not.toContain(h2)
    await annotate('a', 7)
    const h3 = await inputsHash(); expect([h0, h1, h2]).not.toContain(h3)
    await annotate('a', 9) // only the newest updatedAt moves
    expect([h0, h1, h2, h3]).not.toContain(await inputsHash())
  })

  it('moves when an annotation is added with an older updatedAt than the newest (only the count changes)', async () => {
    await tx('a'); await tx('b')
    await annotate('a', 20)
    const before = await inputsHash()
    await annotate('b', 5)
    expect(await inputsHash()).not.toBe(before)
  })

  it('moves on a soft delete plus a restore of a different row, though both counts are unchanged', async () => {
    await tx('a'); await tx('b', 10)
    const counts = async () => [await db.transactions.count(), await db.transactions.where('deletedAt').above(-Infinity).count()]
    expect(await counts()).toEqual([2, 1])
    const before = await inputsHash()
    await db.transactions.update('a', { deletedAt: 20 })
    await db.transactions.update('b', { deletedAt: null })
    expect(await counts()).toEqual([2, 1]) // the swap leaves the counts as they were, so only the newest deletedAt can see it
    expect(await inputsHash()).not.toBe(before)
  })

  it('returns to the original digest when a deleted row is restored, because the state is identical', async () => {
    await tx('a'); await tx('b', 10)
    const before = await inputsHash()
    await db.transactions.update('a', { deletedAt: 20 })
    expect(await inputsHash()).not.toBe(before)
    await db.transactions.update('a', { deletedAt: null })
    expect(await inputsHash()).toBe(before)
  })

  it('does not tell apart two edits that leave every count and the newest updatedAt equal (the stated limit)', async () => {
    await tx('a')
    await annotate('a', 10, 'first')
    const before = await inputsHash()
    await annotate('a', 10, 'second') // same millisecond, same counts
    expect(await inputsHash()).toBe(before)
  })
})

/**
 * The two owner actions that change every figure without writing a transaction or an annotation. Each is driven through the
 * real writer (linkRefund / saveAllocation) and read back through `cached`, not through `inputsHash` alone: a digest test
 * would not prove the owner gets the NEW number on the screen they open next.
 */
describe('figures that depend on tables other than transactions and annotations', () => {
  it('recomputes monthSummary when a refund is linked, so income really drops on the Dashboard', async () => {
    await addTx({ id: 'sp', valueDate: '2026-11-02', amountCents: -5000 })
    await addTx({ id: 'rf', valueDate: '2026-11-05', amountCents: 5000, kind: 'income' })

    const first = await monthSummary('2026-11', '2026-11-30', 1000)
    expect(first.incomeCents).toBe(5000)
    expect(first.spentCents).toBe(5000)
    // The entry really is live, so the assertion below is about invalidation and not about a cache that never hits.
    await monthSummary('2026-11', '2026-11-30', 1500)
    expect((await db.analyticsCache.get('monthSummary:2026-11'))?.computedAt).toBe(1000)

    await linkRefund('rf', 'sp') // writes one transfers row; no transaction, no annotation
    const after = await monthSummary('2026-11', '2026-11-30', 2000)
    expect(after.incomeCents).toBe(0) // the refund is no longer counted as income, as the owner was just told
    expect(after.spentCents).toBe(0) // and it has come off the purchase's category
    expect((await db.analyticsCache.get('monthSummary:2026-11'))?.computedAt).toBe(2000)
  })

  it('recomputes monthSummary when a refund is unlinked, so the income comes back', async () => {
    await addTx({ id: 'sp', valueDate: '2026-11-02', amountCents: -5000 })
    await addTx({ id: 'rf', valueDate: '2026-11-05', amountCents: 5000, kind: 'income' })
    const link = await linkRefund('rf', 'sp')
    expect((await monthSummary('2026-11', '2026-11-30', 1000)).incomeCents).toBe(0)
    await unlinkRefund(link.id)
    expect((await monthSummary('2026-11', '2026-11-30', 2000)).incomeCents).toBe(5000)
  })

  it('recomputes a figure built from budget lines when an allocation is saved, and again when it is deleted', async () => {
    await addTx({ id: 'sp', valueDate: '2026-11-02', amountCents: -5000 })
    await categorise('sp', 'cat.restaurants', 10)
    // Exactly what the Reports category panel is built from.
    const lines = async (): Promise<string[]> =>
      (await monthlyBudget('2026-11', '2026-11-30')).lines.map((l) => `${l.targetId}=${l.allocatedCents}/${l.spentCents}`)
    const figure = (computedAt: number): Promise<string[]> => cached('budget-lines', lines, computedAt)

    expect(await figure(1)).toEqual(['cat.restaurants=0/5000'])
    expect(await figure(2)).toEqual(['cat.restaurants=0/5000']) // a hit, so the next assertion is about invalidation
    expect((await db.analyticsCache.get('budget-lines'))?.computedAt).toBe(1)

    // Budgeting the PARENT moves the euro to the parent's line: most-specific-wins, decided by the allocation set alone.
    const saved = await saveAllocation(allocation({ categoryId: 'cat.group.ocio-viajes', fixedCents: 20000 }))
    expect(await figure(3)).toEqual(['cat.group.ocio-viajes=20000/5000'])

    await deleteAllocation(saved.id)
    expect(await figure(4)).toEqual(['cat.restaurants=0/5000'])
    expect((await db.analyticsCache.get('budget-lines'))?.computedAt).toBe(4)
  })

  it('moves the digest when an allocation is edited in place, though the row count and the id set are unchanged', async () => {
    const ids = async (): Promise<string[]> => (await db.budgetAllocations.toCollection().primaryKeys()).sort()
    const first = await saveAllocation(allocation({ categoryId: 'cat.restaurants', fixedCents: 20000 }))
    const before = await inputsHash()
    const countBefore = await db.budgetAllocations.count()
    const idsBefore = await ids()

    // Same target, same effectiveFrom: saveAllocation replaces the row and KEEPS its id (a `put`, not an add).
    const second = await saveAllocation(allocation({ categoryId: 'cat.restaurants', fixedCents: 30000 }))
    expect(second.id).toBe(first.id)
    expect(second.fixedCents).toBe(30000)
    // Neither a count nor an id set can see this change, which is why this table is digested by content.
    expect(await db.budgetAllocations.count()).toBe(countBefore)
    expect(await ids()).toEqual(idsBefore)
    expect(await inputsHash()).not.toBe(before)

    // And the owner sees the new figure, not the old one.
    const allocated = async (computedAt: number): Promise<number[]> =>
      cached('allocated', async () => (await monthlyBudget('2026-11', '2026-11-30')).lines.map((l) => l.allocatedCents), computedAt)
    expect(await allocated(1)).toEqual([30000])
    await saveAllocation(allocation({ categoryId: 'cat.restaurants', fixedCents: 40000 }))
    expect(await allocated(2)).toEqual([40000])
  })

  it('moves the digest when one refund link is swapped for another, though the transfer count is equal both times', async () => {
    await addTx({ id: 'sp1', valueDate: '2026-11-01', amountCents: -5000 })
    await addTx({ id: 'sp2', valueDate: '2026-11-02', amountCents: -5000 })
    await addTx({ id: 'rf', valueDate: '2026-11-05', amountCents: 5000, kind: 'income' })

    const first = await linkRefund('rf', 'sp1')
    expect(await db.transfers.count()).toBe(1)
    const before = await inputsHash()

    await unlinkRefund(first.id)
    const second = await linkRefund('rf', 'sp2')
    expect(second.id).not.toBe(first.id)
    expect(await db.transfers.count()).toBe(1) // equal both times, so only the key SET can see the swap
    expect(await inputsHash()).not.toBe(before)
  })

  it('returns to the original digest when a refund link is undone, because the state is identical', async () => {
    await addTx({ id: 'sp', valueDate: '2026-11-02', amountCents: -5000 })
    await addTx({ id: 'rf', valueDate: '2026-11-05', amountCents: 5000, kind: 'income' })
    const before = await inputsHash()
    const link = await linkRefund('rf', 'sp')
    expect(await inputsHash()).not.toBe(before)
    await unlinkRefund(link.id)
    expect(await inputsHash()).toBe(before)
  })

  it('digests an allocation note, which is free text and could otherwise forge a separator', async () => {
    const first = await saveAllocation(allocation({ categoryId: 'cat.restaurants', fixedCents: 20000, note: 'a' }))
    const before = await inputsHash()
    const second = await saveAllocation(allocation({ categoryId: 'cat.restaurants', fixedCents: 20000, note: '"|,];[' }))
    expect(second.id).toBe(first.id)
    expect(await inputsHash()).not.toBe(before)
  })
})

describe('rebuildAnalytics', () => {
  it('clears every entry and reports how many it cleared', async () => {
    await cached('a', async () => 1, 1); await cached('b', async () => 2, 1); await cached('c', async () => 3, 1)
    expect(await rebuildAnalytics()).toBe(3)
    expect(await db.analyticsCache.count()).toBe(0)
    expect(await rebuildAnalytics()).toBe(0)
    const c = counter()
    expect(await cached('a', c.compute, 2)).toBe('figure-1')
  })
})

describe('durable truth', () => {
  it('does not write to transactions, annotations or learningEvents', async () => {
    await tx('a'); await annotate('a', 10)
    await db.learningEvents.add({ id: 'e1', at: 1, type: 'merchant_named', payload: null, outcome: null } as never)
    const snap = async () => JSON.stringify([await db.transactions.toArray(), await db.annotations.toArray(), await db.learningEvents.toArray()])
    const before = await snap()
    await cached('k', async () => 1, 1); await cached('k', async () => 2, 2); await rebuildAnalytics()
    expect(await snap()).toBe(before)
  })

  // The source-text rule, in the style of sourceRules.test.ts: the module may read the tables a figure is computed from and
  // write only analyticsCache. Both lists are allowlists, so a new table or a new method has to be named here before it can
  // touch durable data. `transfers` and `budgetAllocations` joined the readable list when the digest started keying on them
  // (a refund link and a budget change both move every figure and moved nothing this module looked at); the rule the test
  // enforces is unchanged — read freely, write only the disposable table.
  const readable = ['transactions', 'annotations', 'transfers', 'budgetAllocations']
  const readOnly = new Set(['count', 'where', 'above', 'each', 'get', 'toArray', 'orderBy', 'first', 'last', 'toCollection', 'primaryKeys'])
  const violations = (text: string): string[] => {
    const out: string[] = []
    for (const m of text.matchAll(/\bdb\s*\.\s*(\w+)((?:\s*\.\s*\w+\s*\([^)]*\))*)/g)) {
      const [whole, table = '', chain = ''] = m
      if (table === 'analyticsCache') continue
      if (!readable.includes(table)) { out.push(whole); continue } // any other table, and db.table(...)
      const methods = [...chain.matchAll(/\.\s*(\w+)\s*\(/g)].map((x) => x[1] ?? '')
      if (methods.length === 0 || methods.some((x) => !readOnly.has(x))) out.push(whole)
    }
    return out
  }

  it('the module source reads the durable tables and writes only analyticsCache', () => {
    const source = readFileSync(join(import.meta.dirname, 'cache.ts'), 'utf8')
    for (const table of readable) expect(source).toMatch(new RegExp(`db\\.${table}\\b`)) // the scan sees what it is meant to constrain
    expect(violations(source)).toEqual([])
  })

  it('the detector flags every kind of write it exists to forbid', () => {
    for (const bad of [
      "db.transactions.update('a', {})", 'db.annotations.put(x)', 'db.annotations.clear()',
      "db.transactions.where('id').equals(1).delete()", 'db.learningEvents.add(x)', "db.table('transactions').put(x)",
      'const t = db.transactions', 'db.transactions.bulkAdd([])',
      // The two tables the digest learned to read are readable, not writable: this module must never link a refund or
      // change an allocation, however convenient that would be.
      'db.transfers.add(row)', "db.transfers.delete('t1')", 'db.budgetAllocations.put(row)', 'db.budgetAllocations.clear()',
      'const a = db.budgetAllocations', 'db.savingsGoals.toArray()', 'db.categories.toArray()',
    ]) expect(violations(bad), bad).not.toEqual([])
    for (const good of [
      'db.transactions.count()', "db.transactions.where('deletedAt').above(-Infinity).count()", 'db.analyticsCache.put(x)',
      'db.annotations.each(f)', 'db.transfers.toCollection().primaryKeys()', 'db.budgetAllocations.toArray()',
    ]) {
      expect(violations(good), good).toEqual([])
    }
  })
})
