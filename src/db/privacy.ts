import { db } from './db'
import { getSettings } from './seed'
import type { AccountRow } from './schema'

/**
 * Owner control over what is kept about an account (spec 14.1, 39.1). Both writes go through the ordinary table
 * objects, so the accounts guard in db.ts runs on every one of them.
 */

const autoLabel = (last4: string) => `Cuenta ${last4}`

/**
 * Turns `privacy.storeLast4` on or off. OFF is not just "stop writing new ones": it clears the digits already stored and
 * relabels any account still carrying the automatic `Cuenta <last4>` label, because a label that spells the digits out
 * would keep them on screen and in every backup. A label the owner chose is theirs and is left alone. ON only affects
 * files imported afterwards: the digits are not kept anywhere, so they cannot be restored to existing accounts.
 * One transaction: the flag and the accounts change together or not at all.
 */
export async function setStoreLast4(enabled: boolean): Promise<{ cleared: number }> {
  await getSettings() // creates the row on first use, outside the transaction below
  return db.transaction('rw', [db.settings, db.accounts], async () => {
    const settings = await db.settings.get('singleton')
    if (!settings) throw new Error('Your settings could not be read. Nothing was changed.')
    await db.settings.update('singleton', { privacy: { ...settings.privacy, storeLast4: enabled } })
    if (enabled) return { cleared: 0 }

    const accounts = (await db.accounts.toArray()).sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
    const taken = new Set(accounts.map((a) => a.label))
    let cleared = 0
    for (const [i, account] of accounts.entries()) {
      if (account.last4 === null) continue
      const patch: Partial<AccountRow> = { last4: null }
      if (account.label === autoLabel(account.last4)) {
        // Numbered by when the account was added, and never onto a label another account already has.
        let n = i + 1
        while (taken.has(`Cuenta ${n}`)) n++
        patch.label = `Cuenta ${n}`
        taken.add(patch.label)
      }
      await db.accounts.update(account.id, patch)
      cleared++
    }
    return { cleared }
  })
}

/**
 * Gives an account the name the owner chose. The only rule about what a name may look like is the accounts guard's
 * ("not an account number"), and it is deliberately NOT repeated here: its message is surfaced as it is, so there is one
 * definition of "looks like an account number" and it cannot drift (ruling P3-R39). What this adds is only that a name
 * must have something in it.
 */
export async function renameAccount(id: string, label: string): Promise<void> {
  const name = label.trim()
  if (name === '') throw new Error('Give the account a name.')
  const updated = await db.accounts.update(id, { label: name })
  if (updated === 0) throw new Error('That account could not be found. Nothing was changed.')
}
