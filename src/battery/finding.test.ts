import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BATTERY, type RelationshipId } from './battery'
import type { Bracket } from './critical'
import type { ContingencyResult, ContingencyRow } from './contingency'
import { findingFor, formatEffect, type BatteryResults, type CorrectionVerdict, type Finding, type Observation, type Scale } from './finding'

/**
 * The wording of §12's eight fields. Every assertion here is about a sentence a person reads about their own money, so
 * the tests are about the copy and not about the arithmetic behind it.
 *
 * THE BANNED-LANGUAGE LISTS ARE READ OUT OF THE TWO TEST FILES THAT ALREADY OWN THEM, not restated. Two lists that
 * drift apart is this repository's most repeated defect, and a third copy of these regexes would be exactly that. The
 * extraction is deliberately brittle: if either line is reworded the read throws here rather than silently scanning
 * against a stale pattern.
 */
const SRC = resolve(import.meta.dirname, '..')

function regexFrom(file: string, name: string): RegExp {
  const text = readFileSync(resolve(SRC, file), 'utf8')
  const match = new RegExp(`const ${name} = /(.*)/([a-z]*)\\s*$`, 'm').exec(text)
  const source = match?.[1]
  if (source === undefined) throw new Error(`no regex named ${name} in src/${file}`)
  return new RegExp(source, match?.[2] ?? '')
}

const causalWords = regexFrom('ui/screens/Reports.test.tsx', 'causalWords')
const jargonWords = regexFrom('ui/screens/Reports.test.tsx', 'jargonWords')
const noJargon = regexFrom('learning/categorise.test.ts', 'NO_JARGON')

/**
 * The screens that exist, read out of the router rather than listed here: `screen(path, title)` is the stub factory, so
 * every title it builds is a screen that says "Not built yet" and an action must never send the owner to one.
 */
const ROUTES_SOURCE = readFileSync(resolve(SRC, 'ui/routes.tsx'), 'utf8')
const unbuiltScreens = [...ROUTES_SOURCE.matchAll(/screen\('[^']*',\s*'([^']+)'/g)].map((m) => m[1] ?? '')
const everyScreen = [...ROUTES_SOURCE.matchAll(/title: '([^']+)'/g)].map((m) => m[1] ?? '')

const PERIOD = { from: '2026-01-05', to: '2026-11-15' }

const rank = (effectBp: number, bracket: Bracket, n: number) => ({ effectBp, bracket, n, period: PERIOD })

const contingency = (over: Partial<ContingencyResult> = {}): ContingencyResult => ({
  n: 64,
  period: PERIOD,
  columns: ['Impulse', 'Not impulse'],
  rows: [
    { key: 'mood.bored', label: 'Bored', counts: [14, 10] },
    { key: 'mood.not-bored', label: 'Any other mood', counts: [8, 32] },
  ],
  chiScaled: 95000,
  df: 1,
  vBp: 3400,
  bracket: 'p<0.01',
  verdict: 'tested',
  ...over,
})

const reasonRows: ContingencyRow[] = [
  { key: 'reason.gift', label: 'A gift for someone', counts: [18, 2] },
  { key: 'reason.impulse', label: 'Impulse', counts: [6, 22] },
  { key: 'reason.planned', label: 'Planned', counts: [24, 4] },
  { key: 'reason.removed-a', label: 'Removed reason', counts: [5, 5] },
  { key: 'reason.removed-b', label: 'Removed reason', counts: [3, 7] },
]

/** One plausible result per relationship. The iteration below drives off BATTERY, so a new relationship with no entry fails. */
const FIXTURES: BatteryResults = {
  'mood-amount': rank(2600, 'p<0.05', 34),
  'mood-frequency': {
    ...rank(3200, 'p<0.05', 17),
    lowMood: { weeks: 9, purchases: 41 },
    goodMood: { weeks: 8, purchases: 26 },
    tiedWeeks: 3,
  },
  'stress-discretionary': rank(1850, 'p<0.01', 46),
  'boredom-impulse': contingency(),
  'reason-worthwhile': contingency({ n: 96, columns: ['Worthwhile', 'Not worthwhile'], rows: reasonRows, df: 4, vBp: 4100 }),
  weekend: rank(1200, 'none', 210),
  payday: rank(-900, 'p<0.05', 124),
  'small-purchases': {
    small: { count: 23, totalCents: 8740, medianCents: 320 },
    month: '2026-10',
    ceilingCents: 2000,
    monthSpendCents: 140000,
  },
  'salary-lifestyle': rank(4200, 'none', 7),
  'category-savings': {
    months: 9,
    period: PERIOD,
    categories: [
      { categoryId: 'cat.eating-out', label: 'Eating out', effectBp: -5200, bracket: 'p<0.05' },
      { categoryId: 'cat.transport', label: 'Transport', effectBp: 1900, bracket: 'none' },
    ],
  },
}

const VERDICT: CorrectionVerdict = { bracket: 'p<0.05', survives: true }

const ids = BATTERY.map((r) => r.id)

function build<K extends RelationshipId>(id: K, verdict: CorrectionVerdict = VERDICT): Finding {
  return findingFor(id, FIXTURES[id], verdict)
}

/** Every string a person reads off one finding. `id` is a key, not copy, so it is checked separately. */
const copyOf = (f: Finding): string[] =>
  [f.pattern, f.unit, f.period, f.effect.label, formatEffect(f.effect), f.confidence, f.limitation, f.meaning, f.action]

/**
 * A wide spread of every template: both signs and a flat effect, all four rungs, surviving and not, and all three
 * contingency verdicts. The language rules below hold over every sentence any of these can produce, not just the
 * handful a happy path reaches.
 */
function everyFinding(): { id: RelationshipId; finding: Finding }[] {
  const brackets: Bracket[] = ['p<0.001', 'p<0.01', 'p<0.05', 'none']
  const out: { id: RelationshipId; finding: Finding }[] = []
  for (const id of ids) {
    const base = FIXTURES[id]
    const shapes: BatteryResults[typeof id][] = [base]
    if ('effectBp' in base) {
      shapes.push({ ...base, effectBp: -base.effectBp }, { ...base, effectBp: 0 })
    }
    if ('verdict' in base) {
      shapes.push(
        { ...base, verdict: 'sparse' },
        { ...base, verdict: 'too-many-categories' },
        { ...base, rows: [] },
      )
    }
    if ('categories' in base) {
      shapes.push({ ...base, categories: [] }, { ...base, categories: [{ ...base.categories[0]!, effectBp: 0 }] })
    }
    if ('small' in base) {
      shapes.push({ ...base, small: { count: 1, totalCents: 199, medianCents: 199 } }, { ...base, small: { count: 0, totalCents: 0, medianCents: null } })
    }
    for (const shape of shapes) {
      for (const bracket of brackets) {
        for (const survives of [true, false]) {
          out.push({ id, finding: findingFor(id, shape, { bracket, survives }) })
        }
      }
    }
  }
  return out
}

describe('the eight fields a finding carries', () => {
  it('reads its banned-language lists out of the two files that own them', () => {
    // A vacuous extraction would make every language test below pass on anything, so the patterns are checked first.
    expect('because').toMatch(causalWords)
    expect('therefore').toMatch(causalWords)
    expect('cache').toMatch(jargonWords)
    expect('percentile').toMatch(jargonWords)
    expect('bayes').toMatch(noJargon)
    expect('a happy sentence about your money').not.toMatch(causalWords)
    expect(unbuiltScreens).toContain('AI coach')
    expect(unbuiltScreens.length).toBeGreaterThanOrEqual(5)
    expect(everyScreen).toContain('Dashboard')
  })

  it('fills all eight fields the spec requires, for every one of the ten relationships', () => {
    expect(ids).toHaveLength(10)
    // Driven off BATTERY: a relationship added there with no template, or no fixture, fails here rather than later.
    expect(Object.keys(FIXTURES).sort()).toEqual([...ids].sort())
    for (const id of ids) {
      const f = build(id)
      // §12's eight, plus `id` and `unit`: the screen must never label the count "transactions", since for four of
      // the ten it holds weeks, days or months, so the template declares the unit rather than leaving it to prose.
      expect(Object.keys(f).sort()).toEqual(['action', 'confidence', 'effect', 'id', 'limitation', 'meaning', 'pattern', 'period', 'transactions', 'unit'])
      expect(Object.keys(f.effect).sort()).toEqual(['bp', 'label', 'scale'])
      expect(f.id).toBe(id)
      expect(f.pattern.length).toBeGreaterThan(30)
      expect(Number.isSafeInteger(f.transactions)).toBe(true)
      expect(f.transactions).toBeGreaterThan(0)
      expect(f.period).toMatch(/^\d{2}\/\d{2}\/\d{4} to \d{2}\/\d{2}\/\d{4}$/)
      expect(f.effect.label.length).toBeGreaterThan(20)
      expect(Number.isSafeInteger(f.effect.bp)).toBe(true)
      expect(f.confidence.length).toBeGreaterThan(30)
      expect(f.limitation.length).toBeGreaterThan(80)
      expect(f.meaning.length).toBeGreaterThan(60)
      expect(f.action.length).toBeGreaterThan(30)
    }
    // Ten relationships, ten distinct patterns: a template copied from its neighbour and left unedited fails.
    expect(new Set(ids.map((id) => build(id).pattern)).size).toBe(10)
    expect(new Set(ids.map((id) => build(id).limitation)).size).toBe(10)
    expect(new Set(ids.map((id) => build(id).action)).size).toBe(10)
  })

  it('uses no causal language in any field of any template', () => {
    for (const { id, finding } of everyFinding()) {
      for (const s of copyOf(finding)) {
        expect(s, `${id}: ${s}`).not.toMatch(causalWords)
      }
    }
  })

  it('uses no statistical jargon in any field of any template', () => {
    for (const { id, finding } of everyFinding()) {
      for (const s of copyOf(finding)) {
        expect(s, `${id}: ${s}`).not.toMatch(jargonWords)
        expect(s, `${id}: ${s}`).not.toMatch(noJargon)
      }
    }
  })

  it('never renders the name of the test that was run', () => {
    // The banned words are derived from BATTERY's own `test` strings: the capitalised words of each that its
    // owner-facing `question` does not itself use. A new relationship brings its own test name under this rule.
    const bannedFrom = (relationships: readonly { question: string; test: string | null }[]): Set<string> => {
      const out = new Set<string>()
      for (const r of relationships) {
        if (r.test === null) continue
        out.add(r.test)
        for (const word of r.test.split(/\s+/)) {
          if (word.length >= 5 && /^[A-Z]/.test(word) && !r.question.includes(word)) out.add(word)
        }
      }
      return out
    }
    // The DERIVATION is pinned, not the names it happens to find today: a test name may legitimately be corrected in
    // battery.ts (mood -> frequency's was, from a Poisson rate test to the rank comparison it really is), and a guard
    // that named it would have gone stale rather than followed. These fixtures prove it is not vacuous.
    const sample = bannedFrom([
      { question: 'Does the amount you spend go up or down with your mood?', test: 'Spearman rank correlation of mood against amount' },
      { question: 'Do you spend differently at weekends?', test: 'Mann-Whitney U' },
      { question: 'How much do your small purchases add up to?', test: null },
    ])
    expect(sample).toContain('Spearman')
    expect(sample).toContain('Mann-Whitney')
    expect(sample).not.toContain('mood') // a word the owner-facing question already uses is not jargon
    const banned = bannedFrom(BATTERY)
    // Every live test string, plus at least one bare name per relationship that has one.
    for (const r of BATTERY) if (r.test !== null) expect(banned).toContain(r.test)
    expect([...banned].filter((w) => !w.includes(' ')).length).toBeGreaterThanOrEqual(3)
    for (const { id, finding } of everyFinding()) {
      for (const s of copyOf(finding)) {
        for (const word of banned) expect(s, `${id} names the test: ${word}`).not.toContain(word)
      }
    }
  })

  it('states a limitation that names the actual limit, not a disclaimer', () => {
    const disclaimer = /may not be (accurate|reliable|right)|might not be accurate|is not perfect|no guarantee|pinch of salt|for information only|not financial advice|results may vary|use at your own|approximate only|this is only an estimate/i
    for (const { id, finding } of everyFinding()) {
      expect(finding.limitation, id).not.toMatch(disclaimer)
      // A real limit counts something: how many observations, how many of them were left out, which subset.
      expect(finding.limitation, id).toMatch(/\d/)
      expect(finding.limitation.length, id).toBeGreaterThan(80)
    }
    // The count in `transactions` is named in its own unit, so a week or a month can never read as a transaction.
    // Both halves are pinned: the unit each relationship DECLARES, and that its limitation says the same word in
    // prose next to the count. Changing one without the other fails, which a check of either alone would not catch.
    const units: Record<RelationshipId, Observation> = {
      'mood-amount': 'purchases', 'mood-frequency': 'weeks', 'stress-discretionary': 'purchases',
      'boredom-impulse': 'purchases', 'reason-worthwhile': 'purchases', weekend: 'purchases',
      payday: 'days', 'small-purchases': 'purchases', 'salary-lifestyle': 'months', 'category-savings': 'months',
    }
    for (const id of ids) {
      const f = build(id)
      expect(f.unit, `${id} declares the wrong unit for its count`).toBe(units[id])
      expect(f.limitation, `${id} leaves its count of ${f.unit} unnamed`)
        .toMatch(new RegExp(`\\b${f.transactions}\\b[^.]{0,30}\\b${f.unit}\\b`))
    }
    // Four of the ten count something other than a transaction, which is the whole reason the field exists.
    expect(ids.filter((id) => build(id).unit !== 'purchases').sort())
      .toEqual(['category-savings', 'mood-frequency', 'payday', 'salary-lifestyle'])
  })

  it('says a result is uncertain in words, never as a number pretending to be exact', () => {
    for (const { id, finding } of everyFinding()) {
      expect(finding.confidence, `${id}: ${finding.confidence}`).not.toMatch(/\d/)
      expect(finding.confidence, id).not.toMatch(/p\s*[<=>]|p-?value|%/i)
    }
    // Each rung, and failing the battery-wide correction, reads differently; none of them is a figure.
    const spoken = (v: CorrectionVerdict) => build('weekend', v).confidence
    const said = [
      spoken({ bracket: 'p<0.001', survives: true }),
      spoken({ bracket: 'p<0.01', survives: true }),
      spoken({ bracket: 'p<0.05', survives: true }),
      spoken({ bracket: 'p<0.05', survives: false }),
      spoken({ bracket: 'none', survives: false }),
    ]
    expect(new Set(said).size).toBe(5)
  })

  it('suggests an action the app can actually offer', () => {
    for (const { id, finding } of everyFinding()) {
      for (const screen of unbuiltScreens) {
        expect(finding.action, `${id} sends the owner to the unbuilt ${screen} screen`)
          .not.toMatch(new RegExp(`\\b${screen}\\b`, 'i'))
      }
      expect(finding.action, id).not.toMatch(/savings goal|recurring payment|set a goal|ask the coach/i)
      // Any screen an action does name must be one of the screens that exists.
      const named = everyScreen.filter((s) => finding.action.includes(s))
      for (const s of named) expect(unbuiltScreens, `${id} names ${s}`).not.toContain(s)
    }
    // At least some actions are a thing to do in the owner's own life rather than a tap in the app.
    const inLife = ids.map((id) => build(id).action).filter((a) => !everyScreen.some((s) => a.includes(s)))
    expect(inLife.length).toBeGreaterThanOrEqual(3)
  })

  it('reads the direction of a two-group comparison the way each module documents it', () => {
    // Kerby's r is +10000 when the FIRST group passed is entirely above the second. A sign read backwards is invisible
    // to the type checker, so each call site's documented first group is pinned here.
    // rank.ts stressDiscretionary: a = the stressed spends, positive r = spending shifted toward discretionary.
    const stressedMore = findingFor('stress-discretionary', rank(1850, 'p<0.01', 46), VERDICT).pattern
    expect(stressedMore).toMatch(/went on wants rather than needs was .* higher among the ones you recorded while stressed/)
    const stressedLess = findingFor('stress-discretionary', rank(-1850, 'p<0.01', 46), VERDICT).pattern
    expect(stressedLess).toMatch(/went on wants rather than needs was .* lower among the ones you recorded while stressed/)
    // rank.ts weekend: a = the weekend purchases, positive r = the weekend ones were larger.
    expect(findingFor('weekend', rank(1200, 'p<0.05', 210), VERDICT).pattern).toMatch(/weekend purchases ran larger/i)
    expect(findingFor('weekend', rank(-1200, 'p<0.05', 210), VERDICT).pattern).toMatch(/weekday purchases ran larger/i)
    // trend.ts salaryLifestyle: a = the HIGHER-income months, positive r = the share on wants rose with income.
    expect(findingFor('salary-lifestyle', rank(4200, 'p<0.05', 9), VERDICT).pattern).toMatch(/higher income, a larger share/)
    expect(findingFor('salary-lifestyle', rank(-4200, 'p<0.05', 9), VERDICT).pattern).toMatch(/higher income, a smaller share/)
    // trend.ts moodFrequency: a = the LOW-mood weeks, positive r = more purchases in weeks of low mood.
    const low = { ...FIXTURES['mood-frequency'] }
    expect(findingFor('mood-frequency', { ...low, effectBp: 3200 }, VERDICT).pattern).toMatch(/feeling low, you gave a mood to more purchases/)
    expect(findingFor('mood-frequency', { ...low, effectBp: -3200 }, VERDICT).pattern).toMatch(/feeling good, you gave a mood to more purchases/)
    // rank.ts moodAmount is Spearman: x = valence, y = money out, so positive rho = happier moods, larger purchases.
    expect(findingFor('mood-amount', rank(2600, 'p<0.05', 34), VERDICT).pattern).toMatch(/happier the mood .*the larger the purchase/)
    expect(findingFor('mood-amount', rank(-2600, 'p<0.05', 34), VERDICT).pattern).toMatch(/lower the mood .*the larger the purchase/)
    // trend.ts paydayTrend: x = days since payday, y = that day's spending, so positive rho = bigger days later.
    expect(findingFor('payday', rank(900, 'p<0.05', 124), VERDICT).pattern).toMatch(/further from payday/)
    expect(findingFor('payday', rank(-900, 'p<0.05', 124), VERDICT).pattern).toMatch(/just after payday/)
  })

  it('keeps mood and amount to discretionary purchases, never to all spending', () => {
    const f = build('mood-amount')
    for (const s of copyOf(f)) expect(s).not.toMatch(/what you spend|your spending|all your purchases/i)
    expect(f.pattern).toMatch(/discretionary purchases/)
    expect(f.limitation).toMatch(/fixed essentials/i)
  })

  it('words mood and frequency as conditioned on having bought, and says how many weeks were left out', () => {
    const f = build('mood-frequency')
    for (const s of copyOf(f)) expect(s).not.toMatch(/when you are (low|bored|good)/i)
    expect(f.pattern).toMatch(/weeks when/)
    expect(f.pattern).toMatch(/recorded/)
    // tiedWeeks is 3 in the fixture, and a week counted nowhere has to be accounted for to the owner.
    expect(f.limitation).toMatch(/\b3 weeks\b/)
    expect(f.limitation).toMatch(/a week you bought nothing in|week with no purchases/i)
  })

  it('words stress against discretionary as a share, never as an amount', () => {
    const f = build('stress-discretionary')
    expect(f.pattern).toMatch(/went on wants/)
    expect(f.effect.label).toMatch(/share/)
    expect(f.limitation).toMatch(/a share and not an amount/)
    for (const s of copyOf(f)) expect(s).not.toMatch(/spent more|bigger purchases|larger purchases|purchases got/i)
    // The figure is one share MINUS the other, so it reads as percentage points. "18,5 % more of them" would be a
    // relative claim, and a smaller one: 40 % against 58,5 % is 18,5 points apart and about 46 % more.
    expect(f.pattern).toContain('18,5 percentage points higher')
    expect(f.pattern).not.toMatch(/18,5 % (more|fewer|higher|lower)/)
    expect(f.effect.scale).toBe('points')
  })

  it('never claims a floored strength is "at least" that much, and says instead that it is rounded down', () => {
    // Cramer's V floors (stats.ts: at most a basis point low, never high); rho is correctly rounded. One phrasing
    // cannot serve both, and "at least" of a floor reads as a certainty claim rather than a rounding one.
    for (const { id, finding } of everyFinding()) {
      expect(finding.limitation, id).not.toMatch(/at least/i)
    }
    for (const id of ['boredom-impulse', 'reason-worthwhile'] as const) {
      expect(build(id).limitation).toMatch(/rounded down, so it is never larger/)
    }
    for (const id of ['mood-amount', 'payday', 'category-savings'] as const) {
      expect(build(id).limitation).not.toMatch(/rounded down/)
    }
  })

  it('tells the owner which findings rest only on the purchases they annotated, and which do not', () => {
    for (const id of ['mood-amount', 'stress-discretionary'] as const) {
      expect(build(id).limitation).toMatch(/purchases you chose to annotate/)
    }
    expect(build('mood-frequency').limitation).toMatch(/not weeks of your life/)
    // The weekend relationship reads every live transaction, so it must claim no such limit and name its own.
    const w = build('weekend')
    expect(w.limitation).not.toMatch(/you chose to annotate/)
    expect(w.limitation).toMatch(/reads 210 purchases from the window and not only the ones you annotated/)
    expect(w.limitation).toMatch(/one big shop|Friday/)
    // It reads the window's purchases, but it still filters: spendsOf keeps only what the Budget screen calls
    // spending and drops transfer legs, so "all the purchases" would claim nothing was left out.
    expect(w.limitation).toMatch(/the way the Budget screen counts spending/)
    expect(w.limitation).toMatch(/money you moved into savings/)
    // And it KEEPS a refunded purchase where the Budget screen nets it out, so the two figures can differ and the
    // owner could put them side by side. The limitation says so rather than letting them find it.
    expect(w.limitation).toMatch(/refunded for still counts/)
    expect(w.limitation).toMatch(/can sit above the total the Budget screen shows/)
    // No relationship in this battery reads everything, so none of the ten may claim to.
    for (const id of ids) {
      expect(build(id).limitation, id).not.toMatch(/(all|every one of) (the |your )?(purchases|transactions|spending)/i)
    }
  })

  it('gives a sparse or oversized table its own words, never the words of a plain absence', () => {
    const plain = build('boredom-impulse', { bracket: 'none', survives: false })
    for (const verdict of ['sparse', 'too-many-categories'] as const) {
      const f = findingFor('boredom-impulse', contingency({ verdict, bracket: 'none' }), { bracket: 'none', survives: false })
      expect(f.confidence, verdict).not.toBe(plain.confidence)
      expect(f.meaning, verdict).not.toBe(plain.meaning)
      expect(f.action, verdict).not.toBe(plain.action)
      expect(f.confidence, verdict).toMatch(/did not judge|has not judged|not known/)
      // It must not tell the owner there is nothing there when the app declined to look.
      expect(f.meaning, verdict).toMatch(/has not said/)
      expect(f.effect.bp, verdict).toBe(3400)
    }
    // A real 'none' on a tested table is "not certain yet", never "no effect".
    expect(plain.confidence).toMatch(/not enough here yet|cannot tell yet/)
  })

  it('never reports an uncertain result as no effect at all', () => {
    for (const { id, finding } of everyFinding()) {
      expect(finding.confidence, id).not.toMatch(/no (effect|pattern|link|relationship|connection)/i)
      expect(finding.meaning, id).not.toMatch(/there is nothing (there|to find)\b/i)
    }
  })

  it('does not present two rows that share a label as if they were one answer', () => {
    // src/learning/regret.ts labels every removed purchase reason 'Removed reason', so two deleted reasons arrive as
    // two rows under one name. The counts keep them apart; the wording must not pretend the name does.
    const f = build('reason-worthwhile')
    expect(f.limitation).toMatch(/2 of the rows carry the same name, Removed reason/)
    expect(f.limitation).toMatch(/kept apart in the counts but not in their names/)
    // No literal quotation marks in the prose: the screen decides how a label is set off, and marks only the
    // owner's OWN words as a quotation. Quoting here as well gave "Removed reason" a doubled quotation.
    for (const s of copyOf(f)) expect(s).not.toMatch(/["“”]/)
    // With no shared label there is no such clause to read.
    const distinct = findingFor('reason-worthwhile', contingency({
      n: 96, columns: ['Worthwhile', 'Not worthwhile'], df: 2, vBp: 4100,
      rows: reasonRows.slice(0, 3),
    }), VERDICT)
    expect(distinct.limitation).not.toMatch(/carry the same name/)
  })

  it('offers two readings of a tested result rather than one explanation of it', () => {
    for (const id of ids) {
      const f = build(id)
      if (id === 'small-purchases') continue // a count, not a comparison: §12 asks for no test and offers no second reading of one
      expect(f.meaning, id).toMatch(/One reading/)
      expect(f.meaning, id).toMatch(/Another/)
    }
  })

  it('declares what each effect figure is, so a correlation is never rendered as a percentage', () => {
    // Every effect leaves this module as basis points, which makes three different quantities look alike. Rendering
    // all three with formatBp made two of them claim things the arithmetic does not support: a Spearman rho of 0.42
    // read as "42 %" of nothing at all, and a difference of two shares read as a relative percentage.
    const scales: Record<RelationshipId, Scale> = {
      'mood-amount': 'closeness', 'mood-frequency': 'percent', 'stress-discretionary': 'points',
      'boredom-impulse': 'percent', 'reason-worthwhile': 'percent', weekend: 'percent',
      payday: 'closeness', 'small-purchases': 'percent', 'salary-lifestyle': 'percent',
      'category-savings': 'closeness',
    }
    for (const id of ids) expect(build(id).effect.scale, `${id} declares the wrong scale`).toBe(scales[id])
    // The three correlations and the one difference of shares, and no others: a relationship added later cannot
    // inherit 'percent' by omission, since Scale is a closed union and TEMPLATES must name one.
    expect(ids.filter((id) => build(id).effect.scale === 'closeness').sort())
      .toEqual(['category-savings', 'mood-amount', 'payday'])
    expect(ids.filter((id) => build(id).effect.scale === 'points')).toEqual(['stress-discretionary'])

    // One formatter, so the scale cannot be honoured here and guessed at on the screen.
    expect(formatEffect({ bp: 4200, scale: 'percent' })).toBe('42 %')
    expect(formatEffect({ bp: 1850, scale: 'points' })).toBe('18,5 percentage points')
    expect(formatEffect({ bp: 1850, scale: 'points' })).not.toContain('%')
    const closeness = formatEffect({ bp: 4200, scale: 'closeness' })
    expect(closeness).not.toContain('%')
    expect(closeness).toMatch(/^42 out of 100, where 100 would be moving together perfectly/)
    expect(formatEffect({ bp: -4200, scale: 'closeness' })).toMatch(/^-42 out of 100/)
    // A correlation says its scale outright: a bare figure beside "how closely these moved" invites the % reading.
    for (const id of ['mood-amount', 'payday', 'category-savings'] as const) {
      expect(formatEffect(build(id).effect), id).toContain('out of 100')
    }
  })

  it('says the weekly count is of the purchases that carry a mood, not of everything bought', () => {
    // The weekly value is only the valenced-mood-tagged purchases, so a week of twenty purchases with a mood on
    // three of them scores three. The `meaning` field already concedes that confound; the limitation has to state it.
    const f = build('mood-frequency')
    expect(f.pattern).toMatch(/you gave a mood to more purchases/)
    expect(f.pattern).not.toMatch(/you made more purchases/)
    expect(f.limitation).toMatch(/counts only the purchases you gave a mood to and not everything you bought in it/)
    expect(f.limitation).toMatch(/twenty purchases with a mood on three of them counts as three/)
  })

  it('names how many categories were searched, so the strongest of them carries its own correction', () => {
    // Picking the strongest of N categories is itself a multiple comparison. Benjamini-Hochberg corrects across the
    // ten relationships and sees ONE bracket from this one, so the search inside it is uncorrected and the certainty
    // reaching the owner is overstated by exactly what that search is worth. Until trend.ts corrects within the
    // relationship, the sentence has to carry its own correction, and it does that by naming the number compared.
    const base = FIXTURES['category-savings']
    const two = build('category-savings')
    expect(two.limitation).toMatch(/Eating out is the strongest of 2 categories compared/)
    expect(two.limitation).toMatch(/itself a comparison/)
    expect(two.limitation).not.toMatch(/\b12\b/) // the figure is counted, not a constant

    const twelve = findingFor('category-savings', {
      ...base,
      categories: [...Array(12).keys()].map((i) => ({
        categoryId: `cat.${i}`, label: `Category ${i}`, effectBp: 5200 - i * 100, bracket: 'none' as const,
      })),
    }, VERDICT)
    expect(twelve.limitation).toMatch(/Category 0 is the strongest of 12 categories compared/)
    expect(twelve.limitation).toMatch(/the more categories you spend in, the more it overstates/)

    // One category is not a search, and no category is not a comparison: neither may claim to have been either.
    const one = findingFor('category-savings', { ...base, categories: base.categories.slice(0, 1) }, VERDICT)
    expect(one.limitation).toMatch(/the only category your spending moved in/)
    expect(one.limitation).not.toMatch(/strongest of/)
    const none = findingFor('category-savings', { ...base, categories: [] }, VERDICT)
    expect(none.limitation).toMatch(/No category moved enough .* to be compared at all/)
    expect(none.limitation).not.toMatch(/strongest of/)

    // No other relationship runs more than one comparison, so none of them may borrow this clause.
    for (const id of ids) {
      if (id === 'category-savings') continue
      expect(build(id).limitation, id).not.toMatch(/strongest of/)
    }
  })

  it('reports the period as the bank dates the result covers', () => {
    expect(build('weekend').period).toBe('05/01/2026 to 15/11/2026')
    // Every result module reports the span of the data it ACTUALLY used, and this module reads that field and
    // nothing else. It takes no window from its caller: the caller is the screen, which knows only what it asked
    // for, so echoing the request would claim months the owner may have no records in.
    for (const id of ids) {
      // The one relationship whose period is built HERE rather than read off a result: §12 gives it no test and
      // SmallPurchases carries no dates, so its scope is a month key and its period is that month's two ends.
      if (id === 'small-purchases') continue
      expect(build(id).period, id).toBe('05/01/2026 to 15/11/2026')
    }
    const narrower = findingFor('boredom-impulse', contingency({ period: { from: '2026-03-02', to: '2026-04-20' } }), VERDICT)
    expect(narrower.period).toBe('02/03/2026 to 20/04/2026')
    // A month-shaped result still reports whole bank dates: the first day of the month to its last.
    expect(build('small-purchases').period).toBe('01/10/2026 to 31/10/2026')
    // A result whose period never got filled in says so rather than throwing on a screen.
    const blank = findingFor('weekend', { ...rank(1200, 'none', 210), period: { from: '', to: '' } }, VERDICT)
    expect(blank.period.length).toBeGreaterThan(0)
    expect(blank.period).not.toMatch(/\//)
  })
})
