import type { EntityTable } from 'dexie'
import { db } from './db'
import type { CategoryKind, CategoryRow, MoodRow, PurchaseReasonRow, SettingsRow } from './schema'

/**
 * One node per ING category/subcategory pair observed in a real export (§21.2). Essential versus
 * discretionary is assigned per subcategory. Strings are matched byte-exact against the UTF-8 file.
 * `Transferencias` and `Taxis y Carsharing` default to discretionary but are judgement calls the
 * owner may edit; an edit is a learning event.
 */
export const ING_CATEGORY_MAP: ReadonlyArray<{ ing: string; ingSub: string; categoryId: string; kind: CategoryKind }> = [
  { ing: 'Ahorro', ingSub: 'Redondeo', categoryId: 'cat.roundup', kind: 'savings' },
  { ing: 'Alimentación', ingSub: 'Supermercados y alimentación', categoryId: 'cat.groceries', kind: 'essential' },
  { ing: 'Compras', ingSub: 'Compras (otros)', categoryId: 'cat.shopping', kind: 'discretionary' },
  { ing: 'Compras', ingSub: 'Mascotas y veterinario', categoryId: 'cat.pets', kind: 'essential' },
  { ing: 'Educación y salud', ingSub: 'Farmacia, herbolario y nutrición', categoryId: 'cat.pharmacy', kind: 'essential' },
  { ing: 'Hogar', ingSub: 'Mantenimiento del hogar', categoryId: 'cat.home-maintenance', kind: 'essential' },
  { ing: 'Movimientos excluidos', ingSub: 'Traspaso entre cuentas', categoryId: 'cat.internal-transfer', kind: 'internal' },
  { ing: 'Ocio y viajes', ingSub: 'Cafeterías y restaurantes', categoryId: 'cat.restaurants', kind: 'discretionary' },
  { ing: 'Ocio y viajes', ingSub: 'Libros, música y videojuegos', categoryId: 'cat.books-music-games', kind: 'discretionary' },
  { ing: 'Otros gastos', ingSub: 'Otros gastos (otros)', categoryId: 'cat.other-spending', kind: 'discretionary' },
  { ing: 'Otros gastos', ingSub: 'Transferencias', categoryId: 'cat.transfers', kind: 'discretionary' },
  { ing: 'Vehículo y transporte', ingSub: 'Taxis y Carsharing', categoryId: 'cat.taxis', kind: 'discretionary' },
]

// Listed in display order (the one-tap row). `valence` is the statistical value, -2..+2, and is
// independent of `order`. Other has null valence: excluded from ordinal tests, kept in frequency tests.
const MOODS: ReadonlyArray<Pick<MoodRow, 'id' | 'label' | 'emoji' | 'valence'>> = [
  { id: 'mood.happy', label: 'Happy', emoji: '😊', valence: 2 },
  { id: 'mood.excited', label: 'Excited', emoji: '🤩', valence: 2 },
  { id: 'mood.relaxed', label: 'Relaxed', emoji: '😌', valence: 1 },
  { id: 'mood.satisfied', label: 'Satisfied', emoji: '🙂', valence: 1 },
  { id: 'mood.neutral', label: 'Neutral', emoji: '😐', valence: 0 },
  { id: 'mood.sad', label: 'Sad', emoji: '😢', valence: -1 },
  { id: 'mood.stressed', label: 'Stressed', emoji: '😫', valence: -2 },
  { id: 'mood.anxious', label: 'Anxious', emoji: '😰', valence: -2 },
  { id: 'mood.bored', label: 'Bored', emoji: '🥱', valence: -1 },
  { id: 'mood.frustrated', label: 'Frustrated', emoji: '😤', valence: -2 },
  { id: 'mood.guilty', label: 'Guilty', emoji: '😔', valence: -1 },
  { id: 'mood.other', label: 'Other', emoji: '💭', valence: null },
]

const REASONS: ReadonlyArray<Pick<PurchaseReasonRow, 'id' | 'label'>> = [
  { id: 'reason.essential', label: 'Essential' },
  { id: 'reason.planned', label: 'Planned' },
  { id: 'reason.impulse', label: 'Impulse' },
  { id: 'reason.convenience', label: 'Convenience' },
  { id: 'reason.social-pressure', label: 'Social pressure' },
  { id: 'reason.reward', label: 'Reward' },
  { id: 'reason.emotional-spending', label: 'Emotional spending' },
  { id: 'reason.other', label: 'Other' },
]

/** One top-level node per ING category. Parents group; they carry no kind. */
const PARENT_ID_BY_ING: ReadonlyMap<string, string> = new Map([
  ['Ahorro', 'cat.group.ahorro'],
  ['Alimentación', 'cat.group.alimentacion'],
  ['Compras', 'cat.group.compras'],
  ['Educación y salud', 'cat.group.educacion-salud'],
  ['Hogar', 'cat.group.hogar'],
  ['Movimientos excluidos', 'cat.group.movimientos-excluidos'],
  ['Ocio y viajes', 'cat.group.ocio-viajes'],
  ['Otros gastos', 'cat.group.otros-gastos'],
  ['Vehículo y transporte', 'cat.group.vehiculo-transporte'],
])

/** 32 random bytes from the platform CSPRNG, hex-encoded. Deliberately no fallback (§14.1). */
function newAccountSalt(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

function defaultSettings(): SettingsRow {
  return {
    id: 'singleton',
    theme: 'system',
    locale: 'es-ES',
    privacy: { accountSalt: newAccountSalt(), storeLast4: true },
    moodPrompting: { enabled: true },
    deepseek: { enabled: false },
    backup: { lastBackupAt: null },
  }
}

/** Inserts only rows whose primary key is absent, so owner edits and archiving survive a re-seed. */
async function addMissing<T extends { id: string }>(table: EntityTable<T, 'id'>, rows: T[]): Promise<void> {
  const existing = new Set<unknown>(await table.toCollection().primaryKeys())
  const missing = rows.filter(r => !existing.has(r.id))
  if (missing.length > 0) await table.bulkAdd(missing)
}

const INVESTMENTS_ID = 'cat.investments'
const TRADING_RULE_ID = 'rule.trading-212'
/**
 * Rules added once to an installation, including one that already exists. This owner's bank lists a deposit to the broker as
 * "Transferencia internacional emitida" and a reference number, never by the broker's name, so the Trading 212 rule alone
 * files none of them. Each is added a single time (settings.seededRules remembers it); the owner can remove it for good.
 */
const ONCE_RULES: ReadonlyArray<{ id: string; contains: string; categoryId: string }> = [
  { id: 'rule.international-transfer', contains: 'Transferencia internacional emitida', categoryId: INVESTMENTS_ID },
]

/** Idempotent: safe to call on every launch. The account salt is created once and never replaced. */
export async function seedDatabase(): Promise<void> {
  await db.transaction('rw', [db.categories, db.moods, db.purchaseReasons, db.settings], async () => {
    const parents: CategoryRow[] = [...PARENT_ID_BY_ING].map(([ing, id]) => ({
      id, name: ing, parentId: null, kind: null, isUserCreated: false, ingMappings: [],
    }))
    const leaves: CategoryRow[] = ING_CATEGORY_MAP.map(m => {
      const parentId = PARENT_ID_BY_ING.get(m.ing)
      if (parentId === undefined) throw new Error(`Seed error: ING category "${m.ing}" has no parent node`)
      return { id: m.categoryId, name: m.ingSub, parentId, kind: m.kind, isUserCreated: false, ingMappings: [`${m.ing} / ${m.ingSub}`] }
    })
    await addMissing(db.categories, [...parents, ...leaves])
    if (!(await db.settings.get('singleton'))) await db.settings.add(defaultSettings())
    // Investments: counted as money put aside, like the round-up category. The Trading 212 rule is added only when the
    // category is, so an owner who deletes the rule does not get it back at the next start.
    if ((await db.categories.get(INVESTMENTS_ID)) === undefined) {
      await db.categories.add({ id: INVESTMENTS_ID, name: 'Investments', parentId: 'cat.group.ahorro', kind: 'savings', isUserCreated: false, ingMappings: [] })
      const settings = await db.settings.get('singleton')
      const rules = settings?.categoryRules ?? []
      if (!rules.some((r) => r.id === TRADING_RULE_ID)) {
        await db.settings.update('singleton', { categoryRules: [...rules, { id: TRADING_RULE_ID, contains: 'trading 212', categoryId: INVESTMENTS_ID }] })
      }
    }
    {
      const settings = await db.settings.get('singleton')
      const done = new Set(settings?.seededRules ?? [])
      const pending = ONCE_RULES.filter((r) => !done.has(r.id))
      if (settings && pending.length > 0) {
        const rules = settings.categoryRules ?? []
        const fresh = pending.filter((r) => !rules.some((x) => x.id === r.id))
        await db.settings.update('singleton', { categoryRules: [...rules, ...fresh], seededRules: [...done, ...pending.map((r) => r.id)] })
      }
    }
    await addMissing(db.moods, MOODS.map((m, i): MoodRow => ({ ...m, isCustom: false, order: i, archived: false })))
    await addMissing(db.purchaseReasons, REASONS.map((r, i): PurchaseReasonRow => ({ ...r, isCustom: false, order: i, archived: false })))
    if (!(await db.settings.get('singleton'))) await db.settings.add(defaultSettings())
  })
}

/** The settings singleton, created on first use. */
export async function getSettings(): Promise<SettingsRow> {
  return db.transaction('rw', db.settings, async () => {
    const existing = await db.settings.get('singleton')
    if (existing) return existing
    const created = defaultSettings()
    await db.settings.add(created)
    return created
  })
}
