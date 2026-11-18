import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BANNED_LISTS, WORDING_LISTS, assertNotVacuous, causalWords, jargonWords, meansAssumption, noJargon, shamingWords } from '../test/bannedWords'
import { ALL_CHALLENGE_IDS, ALL_RECOMMENDATION_IDS, challengesFor, noteFor } from './education'
import type { ChallengeId, Topic } from './education'
import type { RecommendationId } from './recommendations'

const IDS: readonly RecommendationId[] = [
  'overspent-category', 'small-purchases-add-up', 'savings-inconsistent',
  'unusual-spend', 'discretionary-rising', 'regret-cluster',
]
const TOPICS: readonly Topic[] = [
  'opportunity-cost', 'impulse-spending', 'lifestyle-inflation',
  'small-purchase-accumulation', 'savings-consistency', 'value-of-money',
]
const CHALLENGES: readonly ChallengeId[] = [
  'reduce-category', 'no-spend-days', 'twenty-four-hour-rule', 'subscription-review', 'savings-step-up',
]

/** Every owner-facing string, scanned ONE AT A TIME: joining them would hide a word at a boundary from `\b`. */
function everyString(): { where: string; text: string }[] {
  const out: { where: string; text: string }[] = []
  for (const id of IDS) {
    const note = noteFor(id)
    if (note !== null) out.push({ where: `note ${id} title`, text: note.title }, { where: `note ${id} body`, text: note.body })
    for (const hasData of [false, true]) {
      for (const c of challengesFor(id, hasData)) {
        out.push({ where: `challenge ${c.id} title`, text: c.title }, { where: `challenge ${c.id} body`, text: c.body })
        if (c.why !== undefined) out.push({ where: `challenge ${c.id} why`, text: c.why })
      }
    }
  }
  return out
}

describe('education', () => {
  it('offers every one of the six topics from at least one recommendation', () => {
    const offered = IDS.map((id) => noteFor(id)?.topic)
    for (const t of TOPICS) expect(offered, t).toContain(t)
    expect(ALL_RECOMMENDATION_IDS.slice().sort()).toEqual(IDS.slice().sort())
  })

  it('attaches a note only to the recommendation that triggered it', () => {
    // Each id maps to its own topic: a table that handed every id the same note would pass "every topic is offered"
    // never, but one that swapped topics between ids would, so the pairing itself is pinned.
    const expected: Record<RecommendationId, Topic> = {
      'overspent-category': 'opportunity-cost',
      'small-purchases-add-up': 'small-purchase-accumulation',
      'savings-inconsistent': 'savings-consistency',
      'discretionary-rising': 'lifestyle-inflation',
      'regret-cluster': 'impulse-spending',
      'unusual-spend': 'value-of-money',
    }
    for (const id of IDS) expect(noteFor(id)?.topic, id).toBe(expected[id])
    expect(new Set(IDS.map((id) => noteFor(id)?.body)).size).toBe(6)
    // An id with no note is never shown anything.
    expect(noteFor('not-a-recommendation' as RecommendationId)).toBeNull()
  })

  it('offers the five challenges, and says which cannot run yet and why', () => {
    const reachable = new Set<ChallengeId>()
    for (const id of IDS) for (const c of challengesFor(id, false)) reachable.add(c.id)
    for (const c of CHALLENGES) expect(reachable.has(c), c).toBe(true)
    expect(ALL_CHALLENGE_IDS.slice().sort()).toEqual(CHALLENGES.slice().sort())

    const without = challengesFor('small-purchases-add-up', false).find((c) => c.id === 'subscription-review')
    expect(without, 'never omitted silently').toBeDefined()
    expect(without?.available).toBe(false)
    expect(without?.why).toMatch(/cannot list (your )?subscriptions/)
    // Everything else can run, and carries no apology.
    for (const id of IDS) {
      for (const c of challengesFor(id, false)) {
        if (c.id === 'subscription-review') continue
        expect(c.available, c.id).toBe(true)
        expect(c.why, c.id).toBeUndefined()
      }
    }
    const withData = challengesFor('small-purchases-add-up', true).find((c) => c.id === 'subscription-review')
    expect(withData?.available).toBe(true)
    expect(withData?.why).toBeUndefined()
  })

  it('uses no causal or shaming wording in any note or challenge', () => {
    const strings = everyString()
    expect(strings.length).toBeGreaterThan(30)
    for (const { where, text } of strings) {
      expect(text, `${where} is not empty`).not.toBe('')
      for (const [name, rule] of [['causalWords', causalWords], ['jargonWords', jargonWords], ['NO_JARGON', noJargon], ['shamingWords', shamingWords]] as const) {
        expect(text, `${where} breaks ${name}`).not.toMatch(rule)
      }
    }
  })

  it('assumes nothing about what the owner can afford', () => {
    for (const { where, text } of everyString()) expect(text, `${where} presumes means`).not.toMatch(meansAssumption)
  })

  it('names no figure of its own', () => {
    // A7: a number in a lesson is a number for its own sake. Digits belong to the advice, not the lesson.
    for (const { where, text } of everyString()) expect(text, where).not.toMatch(/\d/)
  })

  it('has word lists that catch a violating sentence and pass an innocent one', () => {
    for (const list of WORDING_LISTS) {
      expect(list.forbids, list.name).toMatch(list.pattern)
      expect(list.allows, list.name).not.toMatch(list.pattern)
    }
    expect(WORDING_LISTS.map((l) => l.name)).toEqual(['meansAssumption', 'shamingWords'])
    expect(BANNED_LISTS).toHaveLength(3)
    expect(() => assertNotVacuous(WORDING_LISTS)).not.toThrow()
    for (const s of ['You only need to skip coffee.', 'Just stop buying lunch.', 'Simply save more.', 'Cut back on luxuries.', 'You should be able to manage.']) {
      expect(s, s).toMatch(meansAssumption)
    }
    for (const s of ['You should not have bought it.', 'That was a waste.', 'Money wasted on takeaway.', 'You overspent again.', 'A bad habit.', 'Irresponsible.']) {
      expect(s, s).toMatch(shamingWords)
    }
    for (const s of ['Only card payments are counted.', 'It is easy to lose track of a month.', 'Prices are just as the bank lists them.', 'Pick one category and set its line.']) {
      expect(s, s).not.toMatch(meansAssumption)
      expect(s, s).not.toMatch(shamingWords)
    }
  })

  it('makes no claim about people in general, since the app knows one person\'s records', () => {
    for (const { where, text } of everyString()) {
      expect(text, where).not.toMatch(/\b(people|most|often|usually|typically|tend|tends|rarely|generally|everyone|normally|commonly)\b/i)
    }
  })

  it('speaks of the regret note in the owner\'s own terms, asks rather than asserts, and counts nothing', () => {
    const body = noteFor('regret-cluster')?.body ?? ''
    expect(body).toMatch(/not worth it/)
    expect(body).not.toMatch(/regret/i)
    expect(body).not.toMatch(/\b(several|many|few|multiple|couple|all)\b/i)
    expect(body).toMatch(/whether any of these were bought quickly/)
    expect(noteFor('regret-cluster')?.topic).toBe('impulse-spending')
  })

  it('does not presume an unusual payment was a choice', () => {
    const body = noteFor('unusual-spend')?.body ?? ''
    expect(body).toMatch(/not choices/)
    expect(body).not.toMatch(/\b(would choose|choose to)\b/i)
  })

  it('probes the lists it owns when bannedWords is imported, as its own comment says', () => {
    // The probe runs at import and is not otherwise observable, so the call is read out of the source.
    const source = readFileSync(resolve(import.meta.dirname, '../test/bannedWords.ts'), 'utf8')
    expect(source).toMatch(/^assertNotVacuous\(WORDING_LISTS\)$/m)
  })

  it('fits each challenge to the purchase it follows', () => {
    // An unusual payment has already happened and may not have been a want.
    expect(challengesFor('unusual-spend', true).map((c) => c.id)).not.toContain('twenty-four-hour-rule')
    expect(challengesFor('regret-cluster', true).map((c) => c.id)).toContain('twenty-four-hour-rule')
    const nsd = challengesFor('overspent-category', true).find((c) => c.id === 'no-spend-days')
    expect(nsd?.body).toMatch(/groceries/)
    // Says what is true now, not what is coming.
    const why = challengesFor('small-purchases-add-up', false).find((c) => c.id === 'subscription-review')?.why ?? ''
    expect(why).not.toMatch(/\b(will|soon|later|once|yet to|yet|coming)\b/i)
    expect(why).toMatch(/cannot list subscriptions/)
  })

  it('catches the wording the review probed, curly apostrophes included', () => {
    for (const s of ['You ought to cut back.', 'Just buy less.', 'Why not just stop?', 'All you need to do is save.', 'It’s simple to save.', 'If you can spare it.', 'Merely a habit.', 'You can afford it.', 'Just don’t buy it.']) {
      expect(s, s).toMatch(meansAssumption)
    }
    for (const s of ['You ought to know better.', 'A poorly judged buy.', 'Foolish.', 'Indulgent.', 'Extravagant.', 'Frivolous.', 'You are wasting money.', 'Squandered.', 'Excessive.', 'Too much on takeaway.', 'A lack of control.', 'A bad purchase.', 'You regret it.', 'You shouldn’t.']) {
      expect(s, s).toMatch(shamingWords)
    }
    for (const s of ['It is easy to lose track of a month.', 'Just as the bank lists them.', 'Only the card payments are counted.']) {
      expect(s, s).not.toMatch(meansAssumption)
    }
  })
})
