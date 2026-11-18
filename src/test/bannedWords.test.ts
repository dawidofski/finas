import { describe, expect, it } from 'vitest'
import { BANNED_LISTS, WORDING_LISTS, meansAssumption, shamingWords, violations } from './bannedWords'

/**
 * The two lists owned in bannedWords.ts are held to the JUDGING or PRESUMING construction, not to a word. A list that
 * forbids ordinary sentences gets weakened by the next person who hits it, so each sentence below that is innocent is
 * asserted to pass, and each that is not is asserted to be caught. Both directions are pinned: a list loosened until it
 * catches nothing fails the second block, and one tightened until it forbids plain description fails the first.
 */
const INNOCENT = [
  'This month had too much variation to compare.',
  'Too much of the data is missing.',
  'An excessive number of rows were skipped.',
  'Matches were poorly scored.',
  'Food waste',
  'Regretted purchases are listed.',
  'The app merely lists them.',
  'Rows just set aside are shown apart.',
  'It is easy to fix.',
  'Only the card payments are counted.',
  'It is easy to lose track of a month.',
  'Prices are just as the bank lists them.',
  'Pick one category and set its line.',
  'Food waste is a category.', 'Spending on Food waste is shown.', 'The fee could not be applied.', 'An excessive number of rows were set aside.', 'The match failed to load, so it was set aside.',
  'You need to choose a month first.',
]

const SHAMING = [
  'You spent too much.', 'Too much on takeaway.', 'Excessive spending.', 'Excessive.', 'Poorly spent.', 'Money wasted.', 'A wasted month.',
  'You will regret it.', 'You’ll regret it.', 'You regret it.', 'Irresponsible.', 'Irresponsibly done.', 'Careless.', 'Carelessly.', 'Wasteful.',
  'Extravagant.', 'Extravagance.', 'Indulgent.', 'Indulging yourself.', 'Needless.', 'Needless purchases.', 'A bad buy.', 'A bad purchase.',
  'A poorly judged buy.', 'You are wasting money.',
  'Don’t waste it.', 'Do not waste your money.', 'What a waste.', 'Stop wasting.', 'Waste!', 'You waste it every month.', 'Excessive amount on takeaway.', 'An excessive amount on coffee.',
  'Excessively.', 'You spent excessively.', 'Your spending is out of control.', 'Greedy.', 'You failed to save.', 'You’ve failed to stick to it.', 'You could have saved more.', 'You could’ve saved it.',
  'You can’t afford this.', 'You cannot afford this.', 'That was a waste.', 'Squandered.', 'A lack of control.', 'You shouldn’t.', 'You overspent again.',
]

const MEANS = [
  'Merely skip it.', 'Merely a habit.', 'Just stop.', 'Just buy less.', 'Just set a limit.', 'Simply save more.', 'You only need to skip coffee.',
  'Cut back on luxuries.', 'It’s simple to save.', 'You can afford it.',
  'You need to cut back.', 'You have to stop.', 'You must spend less.', 'You’ll need to cut.', 'You must stop buying lunch.',
]

describe('the wording lists owned in bannedWords.ts', () => {
  it('leaves innocent sentences alone, in both lists and through violations()', () => {
    for (const s of INNOCENT) {
      expect(s, s).not.toMatch(shamingWords)
      expect(s, s).not.toMatch(meansAssumption)
      expect(violations(s), s).toEqual([])
    }
  })

  it('catches the judging wording, by name', () => {
    for (const s of SHAMING) {
      expect(s, s).toMatch(shamingWords)
      expect(violations(s), s).toContain('shamingWords')
    }
  })

  it('catches the presuming wording, by name', () => {
    for (const s of MEANS) {
      expect(s, s).toMatch(meansAssumption)
      expect(violations(s), s).toContain('meansAssumption')
    }
  })

  it('applies all five lists in violations(), each catching its own word', () => {
    expect([...BANNED_LISTS, ...WORDING_LISTS].map((l) => l.name)).toEqual(['causalWords', 'jargonWords', 'NO_JARGON', 'meansAssumption', 'shamingWords'])
    expect(violations('because')).toContain('causalWords')
    expect(violations('percentile')).toContain('jargonWords')
    expect(violations('bayes')).toContain('NO_JARGON')
    expect(violations('you only need to')).toContain('meansAssumption')
    expect(violations('a wasted month')).toContain('shamingWords')
    expect(violations('a plain sentence about your own money')).toEqual([])
  })
})
