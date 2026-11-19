import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../db/db'
import { buildCategoryIndex, resolve, writeAnnotation } from '../db/annotations'
import { seedDatabase } from '../db/seed'
import type { TransactionRow } from '../db/schema'
import { inputsHash } from '../analytics/cache'
import { addCategory, addRule, listRules, removeCategory, removeRule } from './store'

const bank = (over: Partial<TransactionRow> = {}): TransactionRow => ({
  id: 't1', accountId: 'acc.1', valueDate: '2026-11-03', amountCents: -5000, balanceCents: 0, description: 'Transferencia a TRADING212 UK',
  comment: null, ingCategory: 'Otros gastos', ingSubcategory: 'Transferencias', kind: 'spend', dedupKey: 'k.1', importId: 'imp.1',
  fileSeq: 1, roundupParentId: null, createdAt: 1, deletedAt: null, ...over,
})
const resolved = async (tx: TransactionRow) => resolve(tx, await db.annotations.get(tx.id), await buildCategoryIndex())

beforeEach(async () => { await db.delete(); await db.open(); await seedDatabase(); await db.settings.update('singleton', { categoryRules: [] }) })

describe('category resolution with rules', () => {
  it('files by rule, the owner wins, and removing the rule restores the bank category', async () => {
    const tx = bank(); await db.transactions.add(tx)
    expect((await resolved(tx)).categoryId).toBe('cat.transfers')
    await addRule('trading 212', 'cat.investments')
    expect((await resolved(tx)).categoryId).toBe('cat.investments')
    expect(await db.annotations.count()).toBe(0)
    expect(await db.transactions.get('t1')).toEqual(tx)
    await writeAnnotation('t1', { categoryId: 'cat.pets' }, 'owner')
    expect((await resolved(tx)).categoryId).toBe('cat.pets')
    await db.annotations.clear()
    const [rule] = await listRules()
    await removeRule(rule!.id)
    expect((await resolved(tx)).categoryId).toBe('cat.transfers')
  })
  it('matches the bank description, not the owner override', async () => {
    const tx = bank({ description: 'Pago inventado' }); await db.transactions.add(tx)
    await addRule('trading 212', 'cat.investments')
    await writeAnnotation('t1', { descriptionOverride: 'Trading 212' }, 'owner')
    expect((await resolved(tx)).categoryId).toBe('cat.transfers')
  })
  it('writeAnnotation derives the same category (a confirmation, not a correction)', async () => {
    const tx = bank(); await db.transactions.add(tx)
    await addRule('trading 212', 'cat.investments')
    await writeAnnotation('t1', { categoryId: 'cat.investments' }, 'owner')
    const ev = (await db.learningEvents.toArray()).find((e) => e.type === 'category')!
    expect(ev.payload).toMatchObject({ old: 'cat.investments', oldWasDerived: true, intent: 'confirmation' })
  })
})

describe('category and rule store', () => {
  it('adds a category with a unique id and refuses bad or duplicate names', async () => {
    const a = await addCategory('  Gym ', 'discretionary')
    expect(a).toBe('cat.user.gym')
    expect(await db.categories.get(a)).toMatchObject({ name: 'Gym', kind: 'discretionary', isUserCreated: true })
    await expect(addCategory('GÝM', 'essential')).rejects.toThrow(/already have a category/)
    await expect(addCategory('   ', 'essential')).rejects.toThrow(/1 to 40/)
    await expect(addCategory('x'.repeat(41), 'essential')).rejects.toThrow(/1 to 40/)
    expect(await addCategory('Gym!', 'savings')).toBe('cat.user.gym-2')
  })
  it('refuses to remove a seeded category', async () => {
    await expect(removeCategory('cat.investments')).rejects.toThrow(/made yourself/)
    expect(await db.categories.get('cat.investments')).toBeDefined()
  })
  it('removing a category cleans rules, allocations and annotations', async () => {
    const id = await addCategory('Gym', 'discretionary')
    await addRule('gym club', id); await addRule('other', 'cat.pets')
    await db.budgetAllocations.add({ id: 'b1', categoryId: id, savingsGoalId: null, percentBp: 100, fixedCents: null, effectiveFrom: '2026-01-01', note: null })
    await db.transactions.add(bank({ description: 'Gym Club' }))
    await writeAnnotation('t1', { categoryId: id, subcategoryId: id, note: 'keep' }, 'owner')
    await removeCategory(id)
    expect(await db.categories.get(id)).toBeUndefined()
    expect((await listRules()).map((r) => r.contains)).toEqual(['other'])
    expect(await db.budgetAllocations.count()).toBe(0)
    expect(await db.annotations.get('t1')).toMatchObject({ categoryId: null, subcategoryId: null, note: 'keep' })
  })
  it('validates rules', async () => {
    await expect(addRule('a', 'cat.pets')).rejects.toThrow(/2 to 60/)
    await expect(addRule('x'.repeat(61), 'cat.pets')).rejects.toThrow(/2 to 60/)
    await expect(addRule('shop', 'cat.nope')).rejects.toThrow(/exists/)
    await addRule(' Gym  Club ', 'cat.pets')
    await expect(addRule('gymclub', 'cat.pets')).rejects.toThrow(/already have a rule/)
    expect((await listRules())[0]!.contains).toBe('Gym  Club')
  })
})

describe('digest', () => {
  it('moves when a rule, a category or a day mood changes', async () => {
    const h0 = await inputsHash()
    await addRule('shop', 'cat.pets')
    const h1 = await inputsHash(); expect(h1).not.toBe(h0)
    const id = await addCategory('Gym', 'essential')
    const h2 = await inputsHash(); expect(h2).not.toBe(h1)
    await db.categories.update(id, { kind: 'savings' })
    const h3 = await inputsHash(); expect(h3).not.toBe(h2)
    await db.settings.update('singleton', { dayMoods: { '2026-11-03': 'mood.happy' } })
    expect(await inputsHash()).not.toBe(h3)
  })
})
