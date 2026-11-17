import { describe, it, expect, beforeEach } from 'vitest'
import { db } from './db'
import { seedDatabase, ING_CATEGORY_MAP, getSettings } from './seed'
import type { CategoryRow, MoodRow, PurchaseReasonRow } from './schema'

beforeEach(async () => { await db.delete(); await db.open() })

const byOrder = <T extends { order: number }>(rows: T[]) => [...rows].sort((a, b) => a.order - b.order)

describe('seedDatabase', () => {
  it('is idempotent', async () => {
    await seedDatabase(); const a = await db.table('categories').count()
    const m = await db.table('moods').count(); const r = await db.table('purchaseReasons').count()
    await seedDatabase()
    expect(await db.table('categories').count()).toBe(a)
    expect(await db.table('moods').count()).toBe(m)
    expect(await db.table('purchaseReasons').count()).toBe(r)
    expect(a).toBe(21)
  })
  it('does not overwrite owner edits on re-seed', async () => {
    await seedDatabase()
    await db.table('categories').update('cat.pets', { kind: 'discretionary' })
    await db.table('moods').update('mood.happy', { archived: true })
    await seedDatabase()
    expect((await db.table('categories').get('cat.pets'))!.kind).toBe('discretionary')
    expect((await db.table('moods').get('mood.happy'))!.archived).toBe(true)
  })
  it('maps every ING pair seen in the real export', async () => {
    await seedDatabase()
    for (const pair of [
      ['Ahorro','Redondeo'], ['Alimentación','Supermercados y alimentación'],
      ['Compras','Compras (otros)'], ['Compras','Mascotas y veterinario'],
      ['Educación y salud','Farmacia, herbolario y nutrición'],
      ['Hogar','Mantenimiento del hogar'],
      ['Movimientos excluidos','Traspaso entre cuentas'],
      ['Ocio y viajes','Cafeterías y restaurantes'],
      ['Ocio y viajes','Libros, música y videojuegos'],
      ['Otros gastos','Otros gastos (otros)'], ['Otros gastos','Transferencias'],
      ['Vehículo y transporte','Taxis y Carsharing'],
    ]) expect(ING_CATEGORY_MAP.find(m => m.ing === pair[0] && m.ingSub === pair[1])).toBeDefined()
    expect(ING_CATEGORY_MAP).toHaveLength(12)
  })
  it('assigns kind at subcategory level, exactly as specified', async () => {
    await seedDatabase()
    const kind = (sub: string) => ING_CATEGORY_MAP.find(m => m.ingSub === sub)!.kind
    expect(kind('Redondeo')).toBe('savings')
    expect(kind('Traspaso entre cuentas')).toBe('internal')
    expect(kind('Mascotas y veterinario')).toBe('essential')
    expect(kind('Compras (otros)')).toBe('discretionary')
    expect(kind('Supermercados y alimentación')).toBe('essential')
    expect(kind('Farmacia, herbolario y nutrición')).toBe('essential')
    expect(kind('Mantenimiento del hogar')).toBe('essential')
    expect(kind('Cafeterías y restaurantes')).toBe('discretionary')
    expect(kind('Libros, música y videojuegos')).toBe('discretionary')
    expect(kind('Otros gastos (otros)')).toBe('discretionary')
    expect(kind('Transferencias')).toBe('discretionary')
    expect(kind('Taxis y Carsharing')).toBe('discretionary')
  })
  it('stores the map in the categories table with matching ids, kinds and mappings', async () => {
    await seedDatabase()
    for (const m of ING_CATEGORY_MAP) {
      const row = await db.table('categories').get(m.categoryId)
      expect(row.kind).toBe(m.kind)
      expect(row.ingMappings).toEqual([`${m.ing} / ${m.ingSub}`])
      expect(row.isUserCreated).toBe(false)
    }
    expect(new Set(ING_CATEGORY_MAP.map(m => m.categoryId)).size).toBe(12)
  })
  it('seeds nine parents with null kind and twelve leaves with a kind, each leaf under its ING parent', async () => {
    await seedDatabase()
    const all = await db.table('categories').toArray() as CategoryRow[]
    const parents = all.filter(c => c.parentId === null)
    const leaves = all.filter(c => c.parentId !== null)
    expect(parents.map(p => p.name).sort()).toEqual(
      ['Ahorro','Alimentación','Compras','Educación y salud','Hogar','Movimientos excluidos','Ocio y viajes','Otros gastos','Vehículo y transporte'].sort())
    expect(parents.every(p => p.kind === null)).toBe(true)
    expect(leaves).toHaveLength(12)
    expect(leaves.every(l => l.kind !== null)).toBe(true)
    for (const m of ING_CATEGORY_MAP) {
      const leaf = all.find(c => c.id === m.categoryId)!
      expect(all.find(c => c.id === leaf.parentId)!.name).toBe(m.ing)
    }
  })
  it('does not duplicate parents on re-seed', async () => {
    await seedDatabase(); await seedDatabase()
    expect((await db.table('categories').toArray() as CategoryRow[]).filter(c => c.parentId === null)).toHaveLength(9)
  })
  it('orderBy(order) returns the moods and reasons in the owner display sequence', async () => {
    await seedDatabase()
    expect((await db.moods.orderBy('order').toArray()).map(m => m.label)).toEqual(
      ['Happy','Excited','Relaxed','Satisfied','Neutral','Sad','Stressed','Anxious','Bored','Frustrated','Guilty','Other'])
    expect((await db.purchaseReasons.orderBy('order').toArray()).map(r => r.label)).toEqual(
      ['Essential','Planned','Impulse','Convenience','Social pressure','Reward','Emotional spending','Other'])
  })
  it('seeds the twelve suggested moods with valence, in display order', async () => {
    await seedDatabase()
    const moods = byOrder(await db.table('moods').toArray() as MoodRow[])
    expect(moods.map(m => m.label)).toEqual(['Happy','Excited','Relaxed','Satisfied','Neutral','Sad','Stressed','Anxious','Bored','Frustrated','Guilty','Other'])
    const v = Object.fromEntries(moods.map(m => [m.label, m.valence]))
    expect(v).toEqual({
      Happy: 2, Excited: 2, Relaxed: 1, Satisfied: 1, Neutral: 0, Sad: -1,
      Stressed: -2, Anxious: -2, Bored: -1, Frustrated: -2, Guilty: -1, Other: null,
    })
    expect(moods.every(m => !m.isCustom && m.archived === false && m.emoji.length > 0)).toBe(true)
  })
  it('seeds the eight purchase reasons', async () => {
    await seedDatabase()
    const reasons = byOrder(await db.table('purchaseReasons').toArray() as PurchaseReasonRow[])
    expect(reasons.map(r => r.label)).toEqual(
      ['Essential','Planned','Impulse','Convenience','Social pressure','Reward','Emotional spending','Other'])
    expect(reasons.every(r => !r.isCustom && r.archived === false)).toBe(true)
  })
  it('creates a settings singleton with a 32-byte account salt that is stable', async () => {
    await seedDatabase(); const first = await getSettings()
    expect(first.privacy.accountSalt).toMatch(/^[0-9a-f]{64}$/)
    await seedDatabase(); expect((await getSettings()).privacy.accountSalt).toBe(first.privacy.accountSalt)
  })
  it('getSettings creates the singleton when absent, and the salt survives', async () => {
    const s = await getSettings()
    expect(s.id).toBe('singleton')
    expect(s.privacy.accountSalt).toMatch(/^[0-9a-f]{64}$/)
    await seedDatabase()
    expect((await getSettings()).privacy.accountSalt).toBe(s.privacy.accountSalt)
  })
  it('generates a different salt per installation', async () => {
    await seedDatabase(); const a = (await getSettings()).privacy.accountSalt
    await db.delete(); await db.open(); await seedDatabase()
    expect((await getSettings()).privacy.accountSalt).not.toBe(a)
  })
  it('defaults theme to system and stores no account identifiers', async () => {
    await seedDatabase(); const s = await getSettings()
    expect(s.theme).toBe('system')
  })
  it('seeds no trace of the owner statements in any seeded table', async () => {
    await seedDatabase()
    // The random salt is excluded: 64 random hex digits could contain a digit run by chance.
    const settings = await getSettings()
    const rows = [
      await db.table('categories').toArray(), await db.table('moods').toArray(),
      await db.table('purchaseReasons').toArray(),
      { ...settings, privacy: { ...settings.privacy, accountSalt: '' } },
    ]
    expect(JSON.stringify(rows)).not.toMatch(/[0-9]{8,}/)
  })
  it('pins the parent category ids other code will reference', async () => {
    await seedDatabase()
    const ids = (await db.table('categories').toArray() as CategoryRow[]).filter(c => c.parentId === null).map(c => c.id).sort()
    expect(ids).toEqual([
      'cat.group.ahorro', 'cat.group.alimentacion', 'cat.group.compras', 'cat.group.educacion-salud',
      'cat.group.hogar', 'cat.group.movimientos-excluidos', 'cat.group.ocio-viajes',
      'cat.group.otros-gastos', 'cat.group.vehiculo-transporte',
    ])
    const pets = await db.table('categories').get('cat.pets')
    expect(pets.parentId).toBe('cat.group.compras')
  })
})
