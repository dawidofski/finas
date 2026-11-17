import { db } from '../db/db'
import { resolveMany } from '../db/annotations'
import type { CategoryRow, TransactionRow } from '../db/schema'
import { applyPercentBp, percentBpOf, sumCents } from '../lib/money'
import { excludedTransactionIds, netIncome, refundSubtractions, treatmentOf } from '../analysis/income'
import { liveTransactionsBetween } from '../analysis/transactionsInRange'
import { allocationsFor } from './allocations'

export interface BudgetLine {
  targetKind: 'category' | 'goal'
  targetId: string
  /** The owner-facing name. A target that no longer exists gets a plain "Removed ..." label instead of a blank. */
  label: string
  allocatedCents: number
  /** Net of refunds, so it can be negative when a refund lands in a month with less spending in that category. */
  spentCents: number
  /** allocated - spent. Negative means the line is overspent. */
  remainingCents: number
  /**
   * (spent - allocated) / allocated, in basis points: OVERSPENDING IS POSITIVE and underspending negative, so +2500
   * is a quarter over and -4000 is forty percent under. Positive means "more than planned", the direction the money
   * moved. NULL whenever allocated is 0: with no budget there is no ratio, and a confident 0 % would read as "exactly
   * on budget". The screen should rely on remainingCents then.
   */
  varianceBp: number | null
  fixed: boolean
  /** True for a category with spending this month and no allocation in force (allocatedCents is 0, fixed is false). */
  unbudgeted: boolean
}

export interface MonthlyBudget {
  month: string
  income: { cents: number; provisional: boolean; basis: 'actual' | 'trailing-average' | 'none' }
  /** The month is the one `today` falls in: present spending as month-to-date. */
  partial: boolean
  lines: BudgetLine[]
  /** income - everything allocated. Signed: negative when allocations exceed income (never clamped or refused, 21.5). */
  unallocatedCents: number
  /** Null when the income basis is zero cents (no income, or an average of zeros): a share of nothing is meaningless; use unallocatedCents. */
  overcommittedBp: number | null
  totals: {
    /** Net spending (refunds subtracted), excluding savings. May exceed essential + discretionary by the unclassified part. */
    spentCents: number
    essentialCents: number
    discretionaryCents: number
    savingsCents: number
    /** Savings as a share of the income basis, in basis points. NULL when the basis is zero cents (no income, or an average of zeros): nothing to measure against, and 0 would read as a confident "saved nothing". */
    savingsRateBp: number | null
  }
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const REMOVED_CATEGORY = 'Removed category: remove this line and add a new one'
// An unbudgeted line has no allocation to re-point, so it must not suggest one.
const REMOVED_UNBUDGETED = 'Removed category (not budgeted)'
const REMOVED_GOAL = 'Removed savings goal: choose another'

/**
 * The live transactions of `month`, by the BANK's value date (§41). A `dateOverride` changes what the owner sees and how
 * rows sort, never which month a figure belongs to: income.ts buckets the same way, so one screen's totals describe one
 * window, and a closed month cannot change because a date was corrected later.
 */
async function candidateTransactions(month: string): Promise<TransactionRow[]> {
  return liveTransactionsBetween(month, month)
}

export async function monthlyBudget(month: string, today: string): Promise<MonthlyBudget> {
  if (!MONTH_RE.test(month)) throw new Error(`Invalid month, expected YYYY-MM: ${month}`)
  if (!DATE_RE.test(today)) throw new Error(`Invalid date, expected YYYY-MM-DD: ${today}`)

  const [income, allocations, excluded, candidates, categories, goals, transfers] = await Promise.all([
    netIncome(month), allocationsFor(month), excludedTransactionIds(month), candidateTransactions(month),
    db.categories.toArray(), db.savingsGoals.toArray(), db.transfers.toArray(),
  ])
  const categoryById = new Map<string, CategoryRow>(categories.map((c) => [c.id, c]))
  const goalById = new Map(goals.map((g) => [g.id, g]))
  const basis = income.cents
  const kindOf = (categoryId: string | null) => (categoryId === null ? null : categoryById.get(categoryId)?.kind ?? null)

  // A round-up is two legs: money leaving the spending account and the same money arriving in savings. Both are kept
  // out of income (own money is not earnings), but the pair is also a real act of saving (spec 10: savings "including
  // round-ups"). Counting both legs would double it, counting neither would say nothing was saved while the savings
  // balance grew, so the spending-account leg counts once (spec 9.2). An internal transfer moves money without saving
  // any of it, so both its legs vanish from income, spending and savings alike.
  const roundupOutIds = new Set(transfers.filter((t) => t.linkKind === 'roundup').map((t) => t.outTransactionId))

  // §41, whole module: the month, the amount and its sign are the BANK's, so a correction made later cannot move a
  // closed month or lose money (a sign-flipping override would otherwise drop a spend from every figure).
  // The owner-corrected values used below are exactly two, and both are classifications: the CATEGORY and the KIND
  // (§43, ruled in Plan 4 — a kind correction moves a row between figures, never between months). Both are read off
  // the resolved row `r`; everything that is money or time is read off the bank row `t`.
  //
  // THE TRAP, because both rows carry both: `r.amountCents` and `r.valueDate` exist and are the OWNER's. Writing one
  // of them into a figure would silently put an amount override into the budget, which §41 forbids and which almost
  // every test still passes. In the loop below, `r` is read for `kind` and `categoryId` and for nothing else.
  const bank = new Map(candidates.map((t) => [t.id, t]))
  const rows = await resolveMany(candidates)

  const spendByCategory = new Map<string, number>() // key '' = uncategorised
  const bump = (id: string | null, cents: number): void => {
    const key = id ?? ''
    spendByCategory.set(key, (spendByCategory.get(key) ?? 0) + cents)
  }
  const savings: number[] = []
  // A leg of ANY transfer row: once a round-up pair exists the outflow carries the saving, so the inflow must not.
  const transferLegIds = new Set(transfers.flatMap((t) => [t.outTransactionId, t.inTransactionId]))
  // Round-up outflows that were credited to savings, by value date and amount, with their account. An inflow that is
  // not a transfer leg carries a saving only when no such outflow is left to account for it, and each outflow accounts
  // for ONE inflow, so two genuine round-ups with one imported outflow still credit twice in all (35 + 35), not once.
  // The match is looser than pairAcrossAccounts: opposite amount, same value date, other account, no parent phrase.
  const creditedOutflows = new Map<string, string[]>()
  const pendingInflows: TransactionRow[] = []
  for (const r of rows) {
    const t = bank.get(r.id)
    if (!t) continue
    // The resolved kind and the resolved category, the owner's two classifications (§43); income.ts asks the same
    // question of the same function with the same resolved kind, so the two readers cannot drift apart.
    const treatment = treatmentOf(r.kind, kindOf(r.categoryId))
    // The bank's sign decides which side of the ledger a row can be on, whatever kind the owner gave it: a positive
    // re-kinded to `spend` is money that arrived, so it can never be spending. It leaves income (income.ts asks the
    // resolved kind) and enters nothing — the owner said it is not income, and no figure can hold an inflow as spending.
    if (t.amountCents >= 0) {
      // A round-up arriving in savings whose spending-account leg was never imported is the only record of the saving.
      // The outflow carries the saving when it is present, because it is the movement that actually left the spending
      // account, so which inflows are still owed is decided below, once every outflow has been counted.
      //
      // The RESOLVED kind (§43.4), because which rows carry a saving IS a figure, and income.ts gates the income sum
      // on the same resolved kind. With the bank's kind here the two readers disagreed in both directions: an inflow
      // re-kinded to `income` was counted by income AND credited to savings (one movement in two figures), and an
      // arrival re-kinded to `roundup` left income and entered nothing, although §43's case list says a row re-kinded
      // to `roundup` is savings. The amount, the sign (`t.amountCents > 0`) and the date below stay the BANK's.
      if (r.kind === 'roundup' && t.amountCents > 0 && !transferLegIds.has(t.id)) pendingInflows.push(t)
      continue
    }
    // Deliberately the BANK's kind, not the resolved one: this is not a figure but the round-up PAIRING, a statement
    // about two bank events (the importer's `transfers` row, or the date/amount/account match below), which no later
    // correction can change. The carve-out on the next line keeps a paired round-up outflow in the figures instead of
    // dropping it as an excluded transfer leg. Were this the resolved kind, re-kinding a round-up to `spend` would
    // make the outflow neither savings nor spending: counted nowhere.
    const isRoundup = t.kind === 'roundup'
    // Whether the outflow was credited to savings AS A ROUND-UP, which is what registering it below records. It asks
    // the RESOLVED kind because that is the kind the crediting decision above used (§43): a spend the owner re-kinded
    // to `roundup` is credited, so it has to be registered, or an unpaired round-up inflow of the same date and
    // amount is credited as well and one movement of 35 shows as 70 (finding B1 of the previous plan, arriving through
    // the new path). The bank kind stays in the test as well as the resolved one, because an outflow the bank filed as
    // a round-up can reach the savings branch for the other reason — a savings CATEGORY, with the owner's kind saying
    // something else — and it was already accounting for its inflow before this fix.
    const creditedAsRoundup = isRoundup || r.kind === 'roundup'
    if (excluded.has(t.id) && !(isRoundup && roundupOutIds.has(t.id))) continue
    if (treatment === 'savings') {
      savings.push(-t.amountCents)
      // A PAIRED outflow's counterpart is its own transfer in-leg, already removed from the pending set, so it must
      // not be left available to account for some other inflow.
      // Registration says only "this outflow has already been counted"; it never changes which rows are credited.
      if (creditedAsRoundup && !roundupOutIds.has(t.id)) {
        const key = `${t.valueDate}|${-t.amountCents}`
        creditedOutflows.set(key, [...(creditedOutflows.get(key) ?? []), t.accountId])
      }
      continue
    }
    if (treatment === 'spending') bump(r.categoryId, -t.amountCents)
  }
  for (const inn of pendingInflows) {
    const accounts = creditedOutflows.get(`${inn.valueDate}|${inn.amountCents}`) ?? []
    // Known limit, deliberately not fixed: this takes the FIRST different-account outflow, so outflows on accounts A
    // and B against inflows on X and B can over-credit. It needs three accounts in an exact cross.
    const i = accounts.findIndex((a) => a !== inn.accountId)
    if (i >= 0) accounts.splice(i, 1) // this outflow has accounted for this inflow; it cannot account for another
    else savings.push(inn.amountCents)
  }

  // A refund reduces the category its purchase is filed under, in the month the BANK dated the refund. Whether a link
  // subtracts anything at all is decided in ONE place, refundSubtraction (income.ts), which income uses too: the
  // positive leaves income exactly when this subtracts, by the same bank amount, so the two always move together.
  const refundLinks = transfers.filter((t) => t.linkKind === 'refund')
  const legIds = [...new Set(refundLinks.flatMap((t) => [t.outTransactionId, t.inTransactionId]))]
  const rawLegs = new Map<string, TransactionRow>()
  for (const r of await db.transactions.bulkGet(legIds)) if (r) rawLegs.set(r.id, r)
  for (const s of await refundSubtractions(transfers, rawLegs)) {
    if (s.refundValueDate.startsWith(month)) bump(s.categoryId, -s.cents)
  }

  let essential = 0
  let discretionary = 0
  let spent = 0
  for (const [id, cents] of spendByCategory) {
    spent += cents
    const kind = kindOf(id === '' ? null : id)
    if (kind === 'essential') essential += cents
    else if (kind === 'discretionary') discretionary += cents
  }

  // Who owns a euro of spending: the MOST SPECIFIC allocated category on its path (itself, then its parent, ...).
  // Why most-specific-wins: an owner who budgets "Mascotas" separately inside "Compras" is pulling it out of the
  // group's budget, not asking for it twice. Each euro then belongs to exactly one line, so the lines always add up
  // to totals.spentCents. Because of that, the parent's allocation and its child's are two separate budgets (the
  // child, and the parent minus its separately budgeted children), and allocatedTotal below rightly adds both.
  // A rule is needed on the read side anyway: a restored backup can hold any combination of allocations.
  const allocatedCategories = new Set(allocations.flatMap((a) => (a.categoryId !== null ? [a.categoryId] : [])))
  const ownerOf = (id: string): string | null => {
    let cur: string | null = id === '' ? null : id
    for (let hops = 0; cur !== null && hops < 8; hops++) {
      if (allocatedCategories.has(cur)) return cur
      cur = categoryById.get(cur)?.parentId ?? null
    }
    return null
  }
  const spentByOwner = new Map<string, number>()
  const unbudgetedSpend = new Map<string, number>()
  for (const [id, cents] of spendByCategory) {
    const owner = ownerOf(id)
    const into = owner === null ? unbudgetedSpend : spentByOwner
    const key = owner ?? id
    into.set(key, (into.get(key) ?? 0) + cents)
  }
  // A line whose category has an allocated descendant covers only part of its group, and says so.
  const hasBudgetedChild = (categoryId: string): boolean =>
    [...allocatedCategories].some((other) => {
      let cur: string | null = categoryById.get(other)?.parentId ?? null
      for (let hops = 0; cur !== null && hops < 8; hops++) {
        if (cur === categoryId) return true
        cur = categoryById.get(cur)?.parentId ?? null
      }
      return false
    })

  const lines: BudgetLine[] = allocations.map((a) => {
    const fixed = a.fixedCents !== null
    const allocatedCents = a.fixedCents ?? applyPercentBp(basis, a.percentBp ?? 0)
    const isCategory = a.categoryId !== null
    const targetId = (isCategory ? a.categoryId : a.savingsGoalId) as string
    const name = isCategory ? categoryById.get(targetId)?.name : goalById.get(targetId)?.name
    const label = name === undefined ? (isCategory ? REMOVED_CATEGORY : REMOVED_GOAL)
      : isCategory && hasBudgetedChild(targetId) ? `${name} (excluding categories budgeted separately)` : name
    // No transaction is tied to a goal yet, so a goal line has nothing spent against it.
    const spentCents = isCategory ? spentByOwner.get(targetId) ?? 0 : 0
    return {
      targetKind: isCategory ? 'category' : 'goal', targetId, label, allocatedCents, spentCents,
      remainingCents: allocatedCents - spentCents,
      varianceBp: allocatedCents === 0 ? null : percentBpOf(spentCents - allocatedCents, allocatedCents),
      fixed, unbudgeted: false,
    }
  })

  // Spending nobody claimed still gets a line, so the lines explain the total. Uncategorised spending (id '') too.
  const unbudgetedLines: BudgetLine[] = [...unbudgetedSpend]
    .filter(([, cents]) => cents !== 0)
    .sort(([x], [y]) => (x < y ? -1 : 1))
    .map(([id, cents]) => ({
      targetKind: 'category', targetId: id,
      label: id === '' ? 'Uncategorised' : categoryById.get(id)?.name ?? REMOVED_UNBUDGETED,
      allocatedCents: 0, spentCents: cents, remainingCents: -cents, varianceBp: null, fixed: false, unbudgeted: true,
    }))
  lines.push(...unbudgetedLines)

  const allocatedTotal = sumCents(lines.map((l) => l.allocatedCents))
  const savingsCents = sumCents(savings)
  return {
    month,
    income: { cents: income.cents, provisional: income.provisional, basis: income.basis },
    partial: month === today.slice(0, 7),
    lines,
    unallocatedCents: income.cents - allocatedTotal,
    overcommittedBp: basis === 0 ? null : Math.max(0, percentBpOf(allocatedTotal, basis) - 10000),
    totals: {
      spentCents: spent, essentialCents: essential, discretionaryCents: discretionary, savingsCents,
      savingsRateBp: basis === 0 ? null : percentBpOf(savingsCents, basis),
    },
  }
}
