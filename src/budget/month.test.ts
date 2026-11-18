import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../db/db'
import { seedDatabase } from '../db/seed'
import type { AnnotationRow, TransactionRow, TransferRow } from '../db/schema'
import { saveAllocation } from './allocations'
import { monthlyBudget } from './month'
import { resolveMany } from '../db/annotations'

let uid = 0
const GROCERIES: [string, string] = ['Alimentación', 'Supermercados y alimentación']
const RESTAURANTS: [string, string] = ['Ocio y viajes', 'Cafeterías y restaurantes']
const ROUNDUP: [string, string] = ['Ahorro', 'Redondeo']
const INTERNAL: [string, string] = ['Movimientos excluidos', 'Traspaso entre cuentas']
const NOV = '2026-11'
const TODAY = '2026-12-05'

const tx = async (
  id: string, valueDate: string, amountCents: number, ing: [string, string] | null = null,
  kind: TransactionRow['kind'] = amountCents > 0 ? 'income' : 'spend', accountId = 'acc.1', deletedAt: number | null = null,
): Promise<void> => {
  await db.transactions.add({
    id, accountId, valueDate, amountCents, balanceCents: 0, description: 'Movimiento inventado', comment: null,
    ingCategory: ing?.[0] ?? null, ingSubcategory: ing?.[1] ?? null, kind, dedupKey: `k.${++uid}`, importId: 'imp.1', fileSeq: uid,
    roundupParentId: null, createdAt: 1, deletedAt,
  })
}

const link = async (id: string, out: string, inn: string, amountCents: number, linkKind?: TransferRow['linkKind']): Promise<void> => {
  await db.transfers.add({
    id, outTransactionId: out, inTransactionId: inn, amountCents, matchScore: 100, confirmedByUser: true, matchedAt: 1,
    ...(linkKind ? { linkKind } : {}),
  })
}

const annotate = async (transactionId: string, over: Partial<AnnotationRow>): Promise<void> => {
  await db.annotations.add({
    transactionId, categoryId: null, subcategoryId: null, merchantId: null, typeOverride: null, paymentMethod: null, note: null,
    moodId: null, purchaseReasonId: null, worthwhile: null, reviewed: false, dateOverride: null, amountCentsOverride: null,
    descriptionOverride: null, updatedAt: 1, ...over,
  })
}

const allocate = (categoryId: string, percentBp: number | null, fixedCents: number | null = null) =>
  saveAllocation({ categoryId, savingsGoalId: null, percentBp, fixedCents, effectiveFrom: '2026-01-01', note: null })

const line = async (id: string, month = NOV, today = TODAY) => {
  const found = (await monthlyBudget(month, today)).lines.find((l) => l.targetId === id)
  if (!found) throw new Error(`no line for ${id}`)
  return found
}

beforeEach(async () => {
  uid = 0
  await db.delete(); await db.open(); await seedDatabase()
  await db.savingsGoals.add({
    id: 'goal.1', name: 'Viaje inventado', targetCents: 100000, deadline: null, contributionPercentBp: 0, createdAt: 1, completedAt: null, archived: false,
  })
})

describe('monthlyBudget income and allocation', () => {
  it('computes a percentage allocation against the month income', async () => {
    await tx('pay', '2026-11-01', 200000)
    await allocate('cat.groceries', 1500)
    const l = await line('cat.groceries')
    expect(l).toMatchObject({ targetKind: 'category', label: 'Supermercados y alimentación', allocatedCents: 30000, fixed: false })
    expect((await monthlyBudget(NOV, TODAY)).income).toEqual({ cents: 200000, provisional: false, basis: 'actual' })
  })

  it('computes the same percentage against a different income', async () => {
    await tx('pay', '2026-11-01', 240000)
    await allocate('cat.groceries', 1500)
    expect((await line('cat.groceries')).allocatedCents).toBe(36000)
  })

  it('keeps a fixed allocation fixed whatever the income', async () => {
    await tx('pay', '2026-11-01', 240000)
    await allocate('cat.restaurants', null, 10000)
    expect(await line('cat.restaurants')).toMatchObject({ allocatedCents: 10000, fixed: true })
  })

  it('marks every figure provisional when the income basis is provisional', async () => {
    await tx('o', '2026-10-01', 180000)
    await tx('s', '2026-09-01', 220000)
    await tx('n', '2026-11-03', -1000, GROCERIES) // November has data but no income yet
    await allocate('cat.groceries', 1000)
    const b = await monthlyBudget(NOV, '2026-11-10')
    expect(b.income).toEqual({ cents: 200000, provisional: true, basis: 'trailing-average' })
    expect(b.lines[0]?.allocatedCents).toBe(20000)
  })

  it('reports the month as partial when today falls inside it', async () => {
    await tx('pay', '2026-11-01', 200000)
    expect((await monthlyBudget(NOV, '2026-11-16')).partial).toBe(true)
    expect((await monthlyBudget(NOV, '2026-11-30')).partial).toBe(true)
    expect((await monthlyBudget(NOV, '2026-12-01')).partial).toBe(false)
    expect((await monthlyBudget('2026-10', '2026-11-16')).partial).toBe(false)
  })

  it('rejects a malformed month or today', async () => {
    await expect(monthlyBudget('2026-13', TODAY)).rejects.toThrow()
    await expect(monthlyBudget(NOV, 'today')).rejects.toThrow()
  })
})

describe('monthlyBudget spending', () => {
  beforeEach(async () => {
    await tx('pay', '2026-11-01', 200000)
    await allocate('cat.groceries', 1500)
  })

  it('sums spending per category from the resolved category, not the ING pair', async () => {
    await tx('a', '2026-11-05', -10000, GROCERIES)
    await tx('b', '2026-11-06', -5000, RESTAURANTS) // ING says restaurants...
    await annotate('b', { categoryId: 'cat.groceries' }) // ...the owner says groceries
    await tx('c', '2026-12-01', -9000, GROCERIES) // another month
    await tx('d', '2026-11-07', -7000, GROCERIES, 'spend', 'acc.1', 99) // soft-deleted
    expect((await line('cat.groceries')).spentCents).toBe(15000)
    expect((await monthlyBudget(NOV, TODAY)).totals).toMatchObject({ spentCents: 15000, essentialCents: 15000, discretionaryCents: 0 })
  })

  // CHANGED in the §41 ruling. This test used to be "moves a transaction into the month it is dated to by the owner" and
  // asserted 4000 (the October-bank row the owner re-dated into November counted in November, the November-bank row
  // re-dated into December dropped out). Months are now the bank's, so the same data gives 3000.
  it("counts a re-dated transaction in the BANK's month and shows the owner's date on screen (§41)", async () => {
    await tx('a', '2026-10-31', -4000, GROCERIES)
    await annotate('a', { dateOverride: '2026-11-02' }) // bank October, owner says November
    await tx('b', '2026-11-04', -3000, GROCERIES)
    await annotate('b', { dateOverride: '2026-12-02' }) // bank November, owner says December
    expect((await line('cat.groceries')).spentCents).toBe(3000)
    expect((await line('cat.groceries', '2026-10')).spentCents).toBe(4000)
    expect((await line('cat.groceries', '2026-12')).spentCents).toBe(0)
    // The other half: the owner still sees the date they chose.
    const shown = (await resolveMany([(await db.transactions.get('b')) as TransactionRow]))[0]
    expect(shown?.valueDate).toBe('2026-12-02')
    expect((await db.transactions.get('b'))?.valueDate).toBe('2026-11-04') // and the bank's is untouched
  })

  it('subtracts a refund in the month the bank dated it, whatever date the owner gave it', async () => {
    await tx('buy', '2026-11-05', -10000, GROCERIES)
    await tx('ref', '2026-11-20', 2500, GROCERIES, 'income')
    await annotate('ref', { dateOverride: '2026-12-02' })
    await link('r1', 'buy', 'ref', 2500, 'refund')
    expect((await monthlyBudget(NOV, TODAY)).income.cents).toBe(200000) // out of November income...
    expect((await line('cat.groceries')).spentCents).toBe(7500) // ...and taken off November spending: one month
    expect((await line('cat.groceries', '2026-12')).spentCents).toBe(0)
  })

  it('subtracts a linked refund from its category', async () => {
    await tx('buy', '2026-11-05', -10000, GROCERIES)
    await tx('rest', '2026-11-08', -3000, RESTAURANTS)
    await tx('ref', '2026-11-20', 2500, RESTAURANTS, 'income') // filed elsewhere: the link, not the refund row, decides
    await link('r1', 'buy', 'ref', 2500, 'refund')
    const b = await monthlyBudget(NOV, TODAY)
    expect(b.lines.find((l) => l.targetId === 'cat.groceries')?.spentCents).toBe(7500)
    expect(b.lines.find((l) => l.targetId === 'cat.restaurants')?.spentCents).toBe(3000)
    expect(b.totals.spentCents).toBe(10500)
    expect(b.income.cents).toBe(200000) // the refund is not income
  })

  it('ignores a refund link whose positive income never counted (a restored or hand-made row)', async () => {
    await tx('buy', '2026-11-05', -10000, GROCERIES)
    await tx('lone', '2026-11-20', 2500, INTERNAL, 'internal')
    await link('r1', 'buy', 'lone', 2500, 'refund')
    expect((await line('cat.groceries')).spentCents).toBe(10000)
  })

  it('applies a refund on its own date, even when the purchase was in an earlier month', async () => {
    await tx('buy', '2026-10-28', -10000, GROCERIES)
    await tx('ref', '2026-11-03', 4000, GROCERIES, 'income')
    await link('r1', 'buy', 'ref', 4000, 'refund')
    expect((await line('cat.groceries')).spentCents).toBe(-4000) // October's purchase is not in November
    expect((await line('cat.groceries', '2026-10')).spentCents).toBe(10000) // and October is not reduced
  })

  it('counts round-ups as savings, not spending', async () => {
    await tx('r1', '2026-11-05', -35, ROUNDUP, 'roundup')
    await tx('r2', '2026-11-06', -80, ROUNDUP, 'roundup')
    await tx('g', '2026-11-07', -1000, GROCERIES)
    const t = (await monthlyBudget(NOV, TODAY)).totals
    expect(t).toMatchObject({ savingsCents: 115, spentCents: 1000, essentialCents: 1000 })
    expect(t.savingsRateBp).toBe(6) // 115 / 200000 = 0.0575 %, rounded to 6 bp
  })

  it('still counts a round-up whose legs were matched as a transfer, once', async () => {
    await tx('ru-out', '2026-11-05', -35, ROUNDUP, 'roundup')
    await tx('ru-in', '2026-11-05', 35, ROUNDUP, 'roundup', 'acc.2')
    await link('t1', 'ru-out', 'ru-in', 35, 'roundup')
    const b = await monthlyBudget(NOV, TODAY)
    expect(b.totals).toMatchObject({ savingsCents: 35, spentCents: 0 })
    expect(b.income.cents).toBe(200000)
  })

  it('keeps spending on the BANK amount when the owner corrects the amount (§41)', async () => {
    await tx('a', '2026-11-05', -10000, GROCERIES)
    await annotate('a', { amountCentsOverride: -4000 })
    expect((await line('cat.groceries')).spentCents).toBe(10000)
    expect((await monthlyBudget(NOV, TODAY)).totals.spentCents).toBe(10000)
  })

  it('does not lose a purchase when the owner flips its sign: it stays spending, on the bank amount', async () => {
    await tx('a', '2026-11-05', -5000, GROCERIES)
    await annotate('a', { amountCentsOverride: 5000 })
    expect((await line('cat.groceries')).spentCents).toBe(5000)
    expect((await monthlyBudget(NOV, TODAY)).income.cents).toBe(200000) // and it is not income either
  })

  // CHANGED in the §43 ruling (Plan 4, task 9). This test used to be "keeps the bank kind: re-kinding a purchase does
  // not move a closed month" and asserted 5000, because the override changed no figure. `kind` is now the owner's
  // classification, like `categoryId`, so the same data gives 0. The §41 half this test also stood for — a kind
  // correction must not move a row between months — is pinned by the next test, which honours the kind in the bank's
  // month and nowhere else.
  it('a spend re-kinded to internal leaves spending without appearing as income', async () => {
    await tx('a', '2026-11-05', -5000, GROCERIES)
    expect((await line('cat.groceries')).spentCents).toBe(5000)
    await annotate('a', { typeOverride: 'internal' })
    const b = await monthlyBudget(NOV, TODAY)
    expect((await line('cat.groceries')).spentCents).toBe(0)
    // It left spending and arrived in NO other figure: not income, not savings.
    expect(b.totals).toMatchObject({ spentCents: 0, savingsCents: 0, essentialCents: 0, discretionaryCents: 0 })
    expect(b.income.cents).toBe(200000)
  })

  it('a re-kinded row stays in the month the bank dated it', async () => {
    // The bank filed an October arrival as a movement between accounts; the owner says it is real income and also
    // re-dated it into November. The kind correction counts; the month it counts in is October's, the bank's.
    await tx('moved', '2026-10-31', 4000, INTERNAL, 'internal')
    await annotate('moved', { typeOverride: 'income', dateOverride: '2026-11-02' })
    expect((await monthlyBudget('2026-10', TODAY)).income.cents).toBe(4000)
    expect((await monthlyBudget(NOV, TODAY)).income.cents).toBe(200000) // November's own salary, not a cent more
    // And the same the other way round, for spending: a November-bank row re-kinded INTO spending and re-dated into
    // December is November's spending.
    await tx('back', '2026-11-28', -2500, GROCERIES, 'internal')
    await annotate('back', { typeOverride: 'spend', dateOverride: '2026-12-02' })
    expect((await line('cat.groceries')).spentCents).toBe(2500)
    expect((await line('cat.groceries', '2026-12')).spentCents).toBe(0)
  })

  it('credits a round-up that arrived in savings before its spending-account leg was imported', async () => {
    await tx('ru-in', '2026-11-05', 35, ROUNDUP, 'roundup', 'acc.2')
    const b = await monthlyBudget(NOV, TODAY)
    expect(b.totals).toMatchObject({ savingsCents: 35, spentCents: 0 })
    expect(b.income.cents).toBe(200000)
  })

  it('credits a round-up once when both legs exist, and once when only the inflow does', async () => {
    await tx('ru-in', '2026-11-05', 35, ROUNDUP, 'roundup', 'acc.2')
    expect((await monthlyBudget(NOV, TODAY)).totals.savingsCents).toBe(35)
    await tx('ru-out', '2026-11-05', -35, ROUNDUP, 'roundup')
    await link('t1', 'ru-out', 'ru-in', 35, 'roundup')
    expect((await monthlyBudget(NOV, TODAY)).totals.savingsCents).toBe(35) // not 70
  })

  it('credits a round-up once at every stage: inflow alone, both legs unpaired, then linked', async () => {
    await tx('ru-in', '2026-11-05', 35, ROUNDUP, 'roundup', 'acc.2')
    expect((await monthlyBudget(NOV, TODAY)).totals.savingsCents).toBe(35)
    await tx('ru-out', '2026-11-05', -35, ROUNDUP, 'roundup') // no parent phrase, so no transfers row pairs them
    expect((await monthlyBudget(NOV, TODAY)).totals.savingsCents).toBe(35) // not 70
    await link('t1', 'ru-out', 'ru-in', 35, 'roundup')
    expect((await monthlyBudget(NOV, TODAY)).totals.savingsCents).toBe(35)
  })

  it('credits each round-up movement once: two inflows with one outflow, then two inflows with none', async () => {
    await tx('ru-in1', '2026-11-05', 35, ROUNDUP, 'roundup', 'acc.2')
    await tx('ru-in2', '2026-11-05', 35, ROUNDUP, 'roundup', 'acc.2')
    expect((await monthlyBudget(NOV, TODAY)).totals.savingsCents).toBe(70) // two movements, neither outflow imported
    await tx('ru-out1', '2026-11-05', -35, ROUNDUP, 'roundup')
    expect((await monthlyBudget(NOV, TODAY)).totals.savingsCents).toBe(70) // one outflow covers one inflow: 35 + 35, not 35
    await tx('ru-out2', '2026-11-05', -35, ROUNDUP, 'roundup')
    expect((await monthlyBudget(NOV, TODAY)).totals.savingsCents).toBe(70) // both outflows now carry it
  })

  it('credits an unpaired round-up inflow that shares a date and amount with a paired movement', async () => {
    await tx('ru-in1', '2026-11-05', 35, ROUNDUP, 'roundup', 'acc.2')
    await tx('ru-out1', '2026-11-05', -35, ROUNDUP, 'roundup')
    await link('t1', 'ru-out1', 'ru-in1', 35, 'roundup')
    await tx('ru-in2', '2026-11-05', 35, ROUNDUP, 'roundup', 'acc.2') // its own outflow was never imported
    expect((await monthlyBudget(NOV, TODAY)).totals.savingsCents).toBe(70)
  })

  it('credits both a round-up inflow and an outflow of the same amount and date on one account', async () => {
    await tx('ru-in', '2026-11-05', 35, ROUNDUP, 'roundup', 'acc.2')
    await tx('ru-out', '2026-11-05', -35, ROUNDUP, 'roundup', 'acc.2') // same account: cannot be two legs of one movement
    expect((await monthlyBudget(NOV, TODAY)).totals.savingsCents).toBe(70)
  })

  it('credits a spend re-kinded to a round-up once, inflow and all (§43)', async () => {
    // The owner says this purchase was really a round-up, so it is credited to savings (§43) — and therefore it is an
    // outflow that HAS been counted. An unpaired bank round-up inflow of the same date and amount on another account
    // is the same 35 of movement seen from the savings side; crediting it too would report 70.
    await tx('ru-out', '2026-11-05', -35, GROCERIES, 'spend')
    await annotate('ru-out', { typeOverride: 'roundup' })
    await tx('ru-in', '2026-11-05', 35, ROUNDUP, 'roundup', 'acc.2') // no transfers row: unpaired
    const b = await monthlyBudget(NOV, TODAY)
    expect(b.totals).toMatchObject({ savingsCents: 35, spentCents: 0 }) // 35, not 70
    expect((await line('cat.groceries')).spentCents).toBe(0) // it left spending, as §43 says
    expect(b.income.cents).toBe(200000) // and no leg of it reached income
  })

  // §43.4: the third direction of the same asymmetry. The pending-inflow gate used to ask the BANK's kind while
  // income.ts asked the resolved one, so a re-kinded arrival was in two figures or in none. Both tests below assert
  // income and savings together, because that is where the euro went or failed to go.
  it('does not credit savings for a round-up inflow the owner re-kinded to income (§43.4)', async () => {
    // The bank filed this arrival as a round-up and its outflow was never imported, so it is the only record of the
    // movement. The owner says it is really earnings: income counts it (the resolved kind), so crediting savings as
    // well would put one movement of 0.35 EUR in two figures and read the savings rate off money nobody saved.
    await tx('ru-in', '2026-11-05', 35, ROUNDUP, 'roundup', 'acc.2')
    expect((await monthlyBudget(NOV, TODAY)).totals.savingsCents).toBe(35) // before the correction: savings, once
    await annotate('ru-in', { typeOverride: 'income' })
    const b = await monthlyBudget(NOV, TODAY)
    expect(b.totals).toMatchObject({ savingsCents: 0, spentCents: 0 }) // it left savings...
    expect(b.income.cents).toBe(200035) // ...and is in income alone: the salary plus this arrival, counted once
  })

  it('credits savings for an arrival the owner re-kinded to a round-up, which income has dropped (§43.4)', async () => {
    // The bank called it income; the owner says it is a round-up into savings. §43's case list says a row re-kinded to
    // `roundup` IS savings, and income stops counting it, so 50.00 EUR must be in the savings figure or in none at all.
    await tx('odd', '2026-11-05', 5000, null, 'income', 'acc.2')
    expect((await monthlyBudget(NOV, TODAY)).income.cents).toBe(205000)
    await annotate('odd', { typeOverride: 'roundup' })
    const b = await monthlyBudget(NOV, TODAY)
    expect(b.income.cents).toBe(200000) // it left income...
    expect(b.totals).toMatchObject({ savingsCents: 5000, spentCents: 0 }) // ...and arrived in savings
  })

  it('accounts a re-kinded inflow against its own outflow when that outflow was imported (§43.4)', async () => {
    // The admitted inflow still goes through the splice below the loop, so an inflow that reaches the pending set only
    // because of a correction cannot be credited on top of the outflow that already carried the saving. (This one does
    // not turn on the gate's kind — it pins the splice, which the gate change puts on a new path.)
    await tx('ru-out', '2026-11-05', -5000, ROUNDUP, 'roundup') // the movement that actually left the account
    await tx('ru-in', '2026-11-05', 5000, null, 'income', 'acc.2') // the bank filed the arrival as income
    await annotate('ru-in', { typeOverride: 'roundup' }) // the owner says it is the savings leg of that movement
    const b = await monthlyBudget(NOV, TODAY)
    expect(b.totals).toMatchObject({ savingsCents: 5000, spentCents: 0 }) // 5000, not 10000
    expect(b.income.cents).toBe(200000)
  })

  it('credits an outflow whose inflow was never imported', async () => {
    await tx('ru-out', '2026-11-05', -35, ROUNDUP, 'roundup')
    expect((await monthlyBudget(NOV, TODAY)).totals.savingsCents).toBe(35)
  })

  it('splits essential from discretionary by subcategory kind', async () => {
    await tx('a', '2026-11-05', -10000, GROCERIES)
    await tx('b', '2026-11-06', -4000, RESTAURANTS)
    await tx('c', '2026-11-07', -500, null) // no category: counted as spending, classified as neither
    expect((await monthlyBudget(NOV, TODAY)).totals).toMatchObject({
      spentCents: 14500, essentialCents: 10000, discretionaryCents: 4000,
    })
  })

  it('lets a line for a parent category cover its subcategories', async () => {
    await allocate('cat.group.ocio-viajes', 2000)
    await tx('a', '2026-11-05', -10000, RESTAURANTS)
    expect((await line('cat.group.ocio-viajes')).spentCents).toBe(10000)
  })

  it('gives spending in an unallocated category a line, so the lines explain the total', async () => {
    await tx('a', '2026-11-05', -10000, GROCERIES)
    await tx('b', '2026-11-06', -4000, RESTAURANTS) // never budgeted
    await tx('c', '2026-11-07', -500, null) // no category at all
    const b = await monthlyBudget(NOV, TODAY)
    expect(b.lines.map((l) => [l.targetId, l.unbudgeted])).toEqual([
      ['cat.groceries', false], ['', true], ['cat.restaurants', true],
    ])
    expect(b.lines.find((l) => l.targetId === 'cat.restaurants')).toMatchObject({
      label: 'Cafeterías y restaurantes', allocatedCents: 0, spentCents: 4000, remainingCents: -4000, varianceBp: null, fixed: false,
    })
    expect(b.lines.find((l) => l.targetId === '')?.label).toBe('Uncategorised')
    expect(b.lines.reduce((n, l) => n + l.spentCents, 0)).toBe(b.totals.spentCents)
  })

  it('does not add an unbudgeted line for spending an allocated parent already covers', async () => {
    await allocate('cat.group.ocio-viajes', 2000)
    await tx('a', '2026-11-05', -4000, RESTAURANTS)
    const b = await monthlyBudget(NOV, TODAY)
    expect(b.lines.map((l) => [l.targetId, l.unbudgeted])).toEqual([['cat.group.ocio-viajes', false], ['cat.groceries', false]].reverse())
    expect(b.lines.find((l) => l.targetId === 'cat.group.ocio-viajes')?.spentCents).toBe(4000)
  })

  it('gives each euro to the most specific allocated category, so parent and child never double count', async () => {
    await allocate('cat.group.alimentacion', 2000)
    await tx('a', '2026-11-05', -10000, GROCERIES) // groceries is itself allocated (beforeEach)
    await allocate('cat.group.compras', 2000)
    await allocate('cat.pets', 500)
    await tx('p', '2026-11-06', -3000, ['Compras', 'Mascotas y veterinario'])
    await tx('s', '2026-11-07', -2000, ['Compras', 'Compras (otros)'])
    const b = await monthlyBudget(NOV, TODAY)
    const spent = (id: string) => b.lines.find((l) => l.targetId === id)?.spentCents
    expect(spent('cat.groceries')).toBe(10000)
    expect(spent('cat.group.alimentacion')).toBe(0)
    expect(spent('cat.pets')).toBe(3000)
    expect(spent('cat.group.compras')).toBe(2000)
    expect(b.lines.find((l) => l.targetId === 'cat.group.compras')?.label).toBe('Compras (excluding categories budgeted separately)')
    expect(b.lines.find((l) => l.targetId === 'cat.pets')?.label).toBe('Mascotas y veterinario')
    expect(b.lines.reduce((n, l) => n + l.spentCents, 0)).toBe(b.totals.spentCents)
  })

  it('keeps sum(line.spentCents) equal to totals.spentCents across every kind of movement', async () => {
    await allocate('cat.group.ocio-viajes', 1000) // parent with an allocated child below
    await allocate('cat.restaurants', 500)
    await tx('r1', '2026-11-05', -4000, RESTAURANTS)
    await tx('b1', '2026-11-05', -2500, ['Ocio y viajes', 'Libros, música y videojuegos'])
    await tx('g1', '2026-11-06', -9000, GROCERIES)
    await tx('u1', '2026-11-07', -1200, ['Compras', 'Compras (otros)']) // unallocated
    await tx('n1', '2026-11-08', -700, null) // uncategorised
    await tx('buy', '2026-11-09', -6000, ['Compras', 'Mascotas y veterinario'])
    await tx('ref', '2026-11-12', 1500, ['Otros gastos', 'Transferencias'], 'income')
    await link('rf', 'buy', 'ref', 1500, 'refund')
    await tx('ru-out', '2026-11-10', -35, ROUNDUP, 'roundup')
    await tx('ru-in', '2026-11-10', 35, ROUNDUP, 'roundup', 'acc.2')
    await link('ru', 'ru-out', 'ru-in', 35, 'roundup')
    await tx('t-out', '2026-11-11', -50000, INTERNAL, 'internal')
    await tx('t-in', '2026-11-11', 50000, INTERNAL, 'income', 'acc.2')
    await link('tr', 't-out', 't-in', 50000)
    const b = await monthlyBudget(NOV, TODAY)
    expect(b.totals.spentCents).toBe(4000 + 2500 + 9000 + 1200 + 700 + 6000 - 1500)
    expect(b.totals.savingsCents).toBe(35)
    expect(b.income.cents).toBe(200000)
    expect(b.lines.reduce((n, l) => n + l.spentCents, 0)).toBe(b.totals.spentCents)
  })

  // The money-conservation table the Plan 3 review built, EXTENDED with the §43 re-kinded cases: every arrangement the
  // app can produce, in one month, with income, spending and savings all asserted at once. Each arrangement has its own
  // test above; this one exists because a euro counted twice or counted nowhere shows up as a changed total here even
  // when each arrangement in isolation still looks right. Every figure the earlier version asserted is unchanged.
  it('every euro is still counted exactly once across the eleven arrangements', async () => {
    await tx('plain', '2026-11-03', -9000, GROCERIES) // 1 an ordinary spend: 9000 of spending
    await tx('amount', '2026-11-04', -4000, GROCERIES) // 2 an amount override: the BANK's 4000, not 999 (§41)
    await annotate('amount', { amountCentsOverride: -999 })
    await tx('flip', '2026-11-05', -5000, GROCERIES) // 3 an override that flips the sign: still 5000 going out (§41)
    await annotate('flip', { amountCentsOverride: 5000 })
    await tx('as-internal', '2026-11-06', -6000, GROCERIES) // 4 a spend re-kinded to internal: in no figure (§43)
    await annotate('as-internal', { typeOverride: 'internal' })
    await tx('in-internal', '2026-11-07', 7000, GROCERIES, 'income') // 5 a positive re-kinded to internal: in none
    await annotate('in-internal', { typeOverride: 'internal' })
    await tx('in-spend', '2026-11-08', 8000, GROCERIES, 'income') // 6 a positive re-kinded to spend: money that
    await annotate('in-spend', { typeOverride: 'spend' }) //        arrived is never spending, so it is in none either
    await tx('buy', '2026-11-09', -10000, RESTAURANTS) // 7 a linked refund: 10000 - 2500 in the purchase's category
    await tx('ref', '2026-11-12', 2500, RESTAURANTS, 'income')
    await link('rf', 'buy', 'ref', 2500, 'refund')
    await tx('ru-out', '2026-11-10', -35, ROUNDUP, 'roundup') // 8 a matched round-up pair: 35 of savings, once
    await tx('ru-in', '2026-11-10', 35, ROUNDUP, 'roundup', 'acc.2')
    await link('ru', 'ru-out', 'ru-in', 35, 'roundup')
    await tx('ru-lone', '2026-11-13', 80, ROUNDUP, 'roundup', 'acc.2') // 9 an unpaired round-up leg: 80 of savings
    await tx('t-out', '2026-11-11', -50000, INTERNAL, 'internal') // 10 a matched internal transfer: in no figure
    await tx('t-in', '2026-11-11', 50000, INTERNAL, 'income', 'acc.2')
    await link('tr', 't-out', 't-in', 50000)
    await tx('nocat', '2026-11-14', -700, null) // 11 an uncategorised spend: 700 of spending, under 'Uncategorised'

    const b = await monthlyBudget(NOV, TODAY)
    expect(b.income.cents).toBe(200000) // the salary alone: 5, 6, 7's refund, 8, 9 and 10 are all out of income
    expect(b.totals.spentCents).toBe(9000 + 4000 + 5000 + 7500 + 700)
    expect(b.totals.savingsCents).toBe(35 + 80)
    expect(b.totals).toMatchObject({ essentialCents: 18000, discretionaryCents: 7500 })
    const spent = (id: string) => b.lines.find((l) => l.targetId === id)?.spentCents
    expect(spent('cat.groceries')).toBe(9000 + 4000 + 5000) // 1, 2, 3 only: 4, 5 and 6 are filed there and count nowhere
    expect(spent('cat.restaurants')).toBe(7500)
    expect(spent('')).toBe(700)
    expect(b.lines.reduce((n, l) => n + l.spentCents, 0)).toBe(b.totals.spentCents)

    // The three rows the owner re-kinded out of every figure are now worth exactly what deleting them is worth:
    // nothing. If any one of them were still being counted anywhere, one of these totals would move.
    for (const id of ['as-internal', 'in-internal', 'in-spend']) await db.transactions.update(id, { deletedAt: 9 })
    const after = await monthlyBudget(NOV, TODAY)
    expect(after.totals).toEqual(b.totals)
    expect(after.income).toEqual(b.income)
  })

  it('reports no overcommitment figure when there is no income basis', async () => {
    await db.transactions.clear()
    await allocate('cat.groceries', null, 25000)
    const b = await monthlyBudget('2027-03', '2027-03-20')
    expect(b.income.basis).toBe('none')
    expect(b.overcommittedBp).toBeNull()
    expect(b.unallocatedCents).toBe(-25000)
  })

  it('has no overcommitment percentage when a trailing average comes to zero, but still reports the euro shortfall', async () => {
    await db.transactions.clear()
    await tx('i', '2026-08-03', 1) // one cent of income in three months averages to zero cents
    await tx('a', '2026-08-05', -1000, GROCERIES)
    await tx('b', '2026-09-05', -1000, GROCERIES)
    await tx('c', '2026-10-05', -1000, GROCERIES)
    await tx('d', '2026-11-05', -500, GROCERIES) // the month has data, so the average applies
    await allocate('cat.groceries', null, 25000)
    const b = await monthlyBudget('2026-11', '2026-11-20')
    expect(b.income).toMatchObject({ cents: 0, basis: 'trailing-average' })
    expect(b.overcommittedBp).toBeNull()
    expect(b.unallocatedCents).toBe(-25000)
  })

  it('words a deleted category on an unbudgeted line without suggesting a choice', async () => {
    await tx('x', '2026-11-05', -2000, null)
    await annotate('x', { categoryId: 'cat.never-existed' })
    const l = (await monthlyBudget(NOV, TODAY)).lines.find((m) => m.targetId === 'cat.never-existed')
    expect(l).toMatchObject({ label: 'Removed category (not budgeted)', unbudgeted: true, spentCents: 2000 })
  })

  it('excludes both legs of a matched transfer from every total', async () => {
    await tx('out', '2026-11-10', -60000, INTERNAL, 'internal')
    await tx('in', '2026-11-10', 60000, INTERNAL, 'income', 'acc.2')
    await link('t1', 'out', 'in', 60000)
    // A leg the bank filed as spending is still not spending once it is the other half of a transfer.
    await tx('odd-out', '2026-11-12', -9000, GROCERIES, 'spend')
    await tx('odd-in', '2026-11-12', 9000, GROCERIES, 'income', 'acc.2')
    await link('t2', 'odd-out', 'odd-in', 9000)
    const b = await monthlyBudget(NOV, TODAY)
    expect(b.income.cents).toBe(200000)
    expect(b.totals).toMatchObject({ spentCents: 0, savingsCents: 0 })
    expect(b.lines[0]?.spentCents).toBe(0)
  })

  it('excludes a transfer leg whose partner is dated in the next month', async () => {
    await tx('out', '2026-11-30', -5000, GROCERIES, 'spend')
    await tx('in', '2026-12-02', 5000, GROCERIES, 'income', 'acc.2')
    await link('t1', 'out', 'in', 5000)
    expect((await monthlyBudget(NOV, TODAY)).totals.spentCents).toBe(0)
  })
})

describe('monthlyBudget allocation arithmetic', () => {
  beforeEach(async () => { await tx('pay', '2026-11-01', 200000) })

  it('reports the unallocated remainder', async () => {
    await allocate('cat.groceries', 3000) // 600 EUR
    await allocate('cat.restaurants', null, 25000) // 250 EUR
    const b = await monthlyBudget(NOV, TODAY)
    expect(b.unallocatedCents).toBe(200000 - 60000 - 25000)
    expect(b.overcommittedBp).toBe(0)
  })

  it('reports overcommitment without refusing it', async () => {
    await allocate('cat.groceries', 7000)
    await allocate('cat.restaurants', 5000)
    await saveAllocation({ categoryId: null, savingsGoalId: 'goal.1', percentBp: 1000, fixedCents: null, effectiveFrom: '2026-01-01', note: null })
    const b = await monthlyBudget(NOV, TODAY)
    expect(b.lines).toHaveLength(3)
    expect(b.overcommittedBp).toBe(3000)
    expect(b.unallocatedCents).toBe(-60000)
  })

  it('reports variance as positive when overspent and negative when underspent', async () => {
    await allocate('cat.groceries', 1500) // 300 EUR
    await allocate('cat.restaurants', null, 10000) // 100 EUR
    await tx('g', '2026-11-05', -36000, GROCERIES) // 60 EUR over
    await tx('r', '2026-11-06', -6000, RESTAURANTS) // 40 EUR under
    expect(await line('cat.groceries')).toMatchObject({ spentCents: 36000, remainingCents: -6000, varianceBp: 2000 })
    expect(await line('cat.restaurants')).toMatchObject({ spentCents: 6000, remainingCents: 4000, varianceBp: -4000 })
  })

  it('reports no variance ratio (null) when nothing was allocated, and no income when nothing was earned', async () => {
    await allocate('cat.groceries', null, 0)
    await tx('g', '2026-11-05', -500, GROCERIES)
    expect((await line('cat.groceries')).varianceBp).toBeNull()
    const empty = await monthlyBudget('2027-03', TODAY)
    expect(empty.income).toMatchObject({ cents: 0, basis: 'none' })
    expect(empty.lines[0]?.allocatedCents).toBe(0)
  })

  it('guards the savings rate against a zero income basis', async () => {
    await db.transactions.clear()
    await tx('r', '2027-03-05', -35, ROUNDUP, 'roundup')
    const b = await monthlyBudget('2027-03', '2027-03-20')
    expect(b.income).toMatchObject({ cents: 0, basis: 'none', provisional: true })
    expect(b.totals).toMatchObject({ savingsCents: 35, savingsRateBp: null })
  })

  it('has no savings rate when a trailing average comes to zero, not only when the basis is none', async () => {
    await db.transactions.clear()
    await tx('i', '2026-08-03', 1) // one cent of income in three months averages to zero cents
    await tx('a', '2026-08-05', -1000, GROCERIES)
    await tx('b', '2026-09-05', -1000, GROCERIES)
    await tx('c', '2026-10-05', -1000, GROCERIES)
    await tx('r', '2026-11-05', -35, ROUNDUP, 'roundup')
    const b = await monthlyBudget('2026-11', '2026-11-20')
    expect(b.income).toMatchObject({ cents: 0, provisional: true, basis: 'trailing-average' })
    expect(b.totals.savingsCents).toBe(35)
    expect(b.totals.savingsRateBp).toBeNull()
  })

  it('labels an allocation whose category was deleted and keeps its figures right', async () => {
    await db.categories.add({ id: 'cat.gone', name: 'Temporal', parentId: null, kind: 'discretionary', isUserCreated: true, ingMappings: [] })
    await allocate('cat.gone', 1000)
    await tx('x', '2026-11-05', -2000, null)
    await annotate('x', { categoryId: 'cat.gone' })
    await db.categories.delete('cat.gone')
    const l = await line('cat.gone')
    expect(l.label).toBe('Removed category: remove this line and add a new one')
    expect(l).toMatchObject({ allocatedCents: 20000, spentCents: 2000, remainingCents: 18000 })
  })

  it('labels an allocation whose savings goal was deleted', async () => {
    await saveAllocation({ categoryId: null, savingsGoalId: 'goal.1', percentBp: null, fixedCents: 5000, effectiveFrom: '2026-01-01', note: null })
    expect((await line('goal.1')).label).toBe('Viaje inventado')
    await db.savingsGoals.delete('goal.1')
    expect(await line('goal.1')).toMatchObject({
      label: 'Removed savings goal: choose another', targetKind: 'goal', allocatedCents: 5000, spentCents: 0, remainingCents: 5000,
    })
  })
})

describe('monthlyBudget goal lines', () => {
  const goalAlloc = (goalId: string, fixedCents: number | null, percentBp: number | null = null) =>
    saveAllocation({ categoryId: null, savingsGoalId: goalId, percentBp, fixedCents, effectiveFrom: '2026-01-01', note: null })
  beforeEach(async () => {
    await db.savingsGoals.add({
      id: 'goal.2', name: 'Coche inventado', targetCents: 500000, deadline: null, contributionPercentBp: 0, createdAt: 1, completedAt: null, archived: false,
    })
    await tx('pay', '2026-11-01', 200000)
  })

  it('shows a goal line as funded by the savings attributed to it that month', async () => {
    await goalAlloc('goal.1', 3000)
    await goalAlloc('goal.2', 1000)
    await tx('s1', '2026-11-05', -2000, ROUNDUP, 'roundup') // 20.00 saved in the month, shared 3:1 -> 1500 and 500
    expect(await line('goal.1')).toMatchObject({ targetKind: 'goal', allocatedCents: 3000, spentCents: 1500, remainingCents: 1500, varianceBp: -5000 })
    expect(await line('goal.2')).toMatchObject({ allocatedCents: 1000, spentCents: 500, remainingCents: 500, varianceBp: -5000 })
  })

  it('never funds a goal beyond its allocation, and funds nothing when nothing was saved', async () => {
    await goalAlloc('goal.1', 3000)
    await goalAlloc('goal.2', 1000)
    await tx('s1', '2026-11-05', -9000, ROUNDUP, 'roundup') // more saved than planned: each line is met exactly
    expect(await line('goal.1')).toMatchObject({ spentCents: 3000, remainingCents: 0, varianceBp: 0 })
    expect(await line('goal.2')).toMatchObject({ spentCents: 1000, remainingCents: 0, varianceBp: 0 })
    expect(await line('goal.1', '2026-10')).toMatchObject({ spentCents: 0, remainingCents: 3000, varianceBp: -10000 })
  })

  it('gives a goal with a zero allocation nothing, and no ratio', async () => {
    await goalAlloc('goal.1', 3000)
    await goalAlloc('goal.2', 0)
    await tx('s1', '2026-11-05', -2000, ROUNDUP, 'roundup')
    expect(await line('goal.1')).toMatchObject({ spentCents: 2000 })
    expect(await line('goal.2')).toMatchObject({ allocatedCents: 0, spentCents: 0, varianceBp: null })
  })

  it('does not let savings change what a category line shows', async () => {
    await allocate('cat.groceries', null, 10000)
    await goalAlloc('goal.1', 3000)
    await tx('g', '2026-11-05', -4000, GROCERIES)
    await tx('s1', '2026-11-06', -2000, ROUNDUP, 'roundup')
    expect(await line('cat.groceries')).toMatchObject({ spentCents: 4000 })
    expect(await line('goal.1')).toMatchObject({ spentCents: 2000 })
  })
})
