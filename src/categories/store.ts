import { db } from '../db/db'
import { getSettings } from '../db/seed'
import type { CategoryKind, CategoryRow, CategoryRule } from '../db/schema'
import { fold } from '../lib/text'
import { ruleText } from './rules'

/** The kinds an owner can choose for a category of their own. */
export type OwnerKind = Extract<CategoryKind, 'essential' | 'discretionary' | 'savings'>

const USER_GROUP_ID = 'cat.group.yours'
const nameKey = (name: string): string => fold(name).toLowerCase().replace(/\s+/gu, ' ').trim()
const slugOf = (name: string): string => {
  const slug = fold(name).toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '')
  return slug === '' ? 'category' : slug
}

/** Adds a category of the owner's own and returns its id. */
export async function addCategory(name: string, kind: OwnerKind): Promise<string> {
  const clean = name.trim().replace(/\s+/gu, ' ')
  if (clean.length < 1 || clean.length > 40) throw new Error('Give the category a name of 1 to 40 characters.')
  if (kind !== 'essential' && kind !== 'discretionary' && kind !== 'savings') throw new Error('Choose what kind of category this is.')
  return db.transaction('rw', db.categories, async () => {
    const all = await db.categories.toArray()
    if (all.some((c) => nameKey(c.name) === nameKey(clean))) throw new Error(`You already have a category called "${clean}".`)
    const ids = new Set(all.map((c) => c.id))
    const base = `cat.user.${slugOf(clean)}`
    let id = base
    for (let i = 2; ids.has(id); i++) id = `${base}-${i}`
    if (!ids.has(USER_GROUP_ID)) {
      await db.categories.add({ id: USER_GROUP_ID, name: 'Your categories', parentId: null, kind: null, isUserCreated: false, ingMappings: [] })
    }
    const row: CategoryRow = { id, name: clean, parentId: USER_GROUP_ID, kind, isUserCreated: true, ingMappings: [] }
    await db.categories.add(row)
    return id
  })
}

/**
 * Removes a category the owner made. Purchases filed there fall back to the category the bank gave them: the owner's own
 * choice on those purchases is cleared, rules that pointed here are dropped, and so is any budget line for it.
 */
export async function removeCategory(id: string): Promise<void> {
  await db.transaction('rw', [db.categories, db.settings, db.budgetAllocations, db.annotations, db.merchants], async () => {
    const row = await db.categories.get(id)
    if (row === undefined) throw new Error('That category no longer exists.')
    if (!row.isUserCreated) throw new Error('Only a category you made yourself can be removed.')
    await db.categories.delete(id)
    const settings = await db.settings.get('singleton')
    if (settings?.categoryRules !== undefined) {
      await db.settings.update('singleton', { categoryRules: settings.categoryRules.filter((r) => r.categoryId !== id) })
    }
    await db.budgetAllocations.where('categoryId').equals(id).delete()
    // updatedAt is left as it was: no clock is read here, and the categories table itself is what the figures key on.
    await db.annotations.toCollection().filter((a) => a.categoryId === id || a.subcategoryId === id).modify((a) => {
      if (a.categoryId === id) a.categoryId = null
      if (a.subcategoryId === id) a.subcategoryId = null
    })
    await db.merchants.where('defaultCategoryId').equals(id).modify({ defaultCategoryId: null })
  })
}

export async function listRules(): Promise<CategoryRule[]> {
  return [...((await db.settings.get('singleton'))?.categoryRules ?? [])]
}

export async function addRule(contains: string, categoryId: string): Promise<void> {
  const text = contains.trim()
  if (text.length < 2 || text.length > 60) throw new Error('Type 2 to 60 characters for the rule to look for.')
  await db.transaction('rw', db.categories, db.settings, async () => {
    if ((await db.categories.get(categoryId)) === undefined) throw new Error('Choose a category that exists.')
    const settings = await getSettings()
    const rules = settings.categoryRules ?? []
    if (rules.some((r) => ruleText(r.contains) === ruleText(text))) throw new Error(`You already have a rule for "${text}".`)
    await db.settings.update('singleton', { categoryRules: [...rules, { id: `rule.${crypto.randomUUID()}`, contains: text, categoryId }] })
  })
}

export async function removeRule(id: string): Promise<void> {
  await db.transaction('rw', db.settings, async () => {
    const settings = await db.settings.get('singleton')
    const rules = settings?.categoryRules ?? []
    if (settings === undefined || !rules.some((r) => r.id === id)) return
    await db.settings.update('singleton', { categoryRules: rules.filter((r) => r.id !== id) })
  })
}
