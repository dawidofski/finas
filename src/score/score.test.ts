import { describe, expect, it } from 'vitest'
import type { Component } from './components'
import { WEIGHTS, moneyScore, type ComponentId } from './score'

const IDS = Object.keys(WEIGHTS) as ComponentId[]
const m = (score: number): Component => ({ kind: 'measured', score, inputs: `inputs ${score}` })
const nm = (why = 'nothing yet'): Component => ({ kind: 'not-measured', why })

/** All six unmeasured, with the given ones replaced. */
function six(over: Partial<Record<ComponentId, Component>>): Record<ComponentId, Component> {
  return {
    'budget-awareness': nm(), 'savings-consistency': nm(), 'improvement': nm(),
    'spending-awareness': nm(), 'goal-progress': nm(), 'learning': nm(),
    ...over,
  }
}

describe('moneyScore', () => {
  it('weights only the measured components, and says which weight it used', () => {
    // Only improvement (weight 2) is measured, at 80. Score = 2*80 / 2 = 80, weightUsed = 2.
    // An implementation that counts unmeasured ones as 0 would give 160/14 = 11.
    const r = moneyScore(six({ improvement: m(80) }))
    expect(r.score).toBe(80)
    expect(r.weightUsed).toBe(WEIGHTS.improvement)
    expect(r.weightUsed).toBe(2)
  })

  it('uses the full total as the denominator when all six are measured', () => {
    // 3*90 + 3*60 + 2*50 + 2*40 + 2*20 + 2*10 = 270 + 180 + 100 + 80 + 40 + 20 = 690; 690 / 14 = 49.28 -> 49.
    const r = moneyScore({
      'budget-awareness': m(90), 'savings-consistency': m(60), 'improvement': m(50),
      'spending-awareness': m(40), 'goal-progress': m(20), 'learning': m(10),
    })
    expect(r.score).toBe(49)
    expect(r.weightUsed).toBe(14)
  })

  it('renormalises when a component is excluded, so the rest keep their relative weight', () => {
    // Budget awareness (3) at 80 and learning (2) at 50 are the only ones measured.
    // (3*80 + 2*50) / (3+2) = (240 + 100) / 5 = 340 / 5 = 68.
    // Dividing by the original 14 would give 340/14 = 24, silently cutting every score by more than half.
    // An unweighted mean would give 65; the weights must matter.
    const r = moneyScore(six({ 'budget-awareness': m(80), learning: m(50) }))
    expect(r.score).toBe(68)
    expect(r.weightUsed).toBe(5)
    // A perfect score on the measured part stays perfect: (3*100 + 2*100) / 5 = 100, not 500/14 = 36.
    expect(moneyScore(six({ 'budget-awareness': m(100), learning: m(100) })).score).toBe(100)
    // Swapped scores prove each weight is attached to its own component: (3*50 + 2*80) / 5 = 310 / 5 = 62.
    expect(moneyScore(six({ 'budget-awareness': m(50), learning: m(80) })).score).toBe(62)
  })

  it('renormalises over a different measured set with a different total', () => {
    // Savings (3) at 40, improvement (2) at 90, goal (2) at 10: weights 3+2+2 = 7.
    // (120 + 180 + 20) / 7 = 320 / 7 = 45.71 -> 46.
    const r = moneyScore(six({ 'savings-consistency': m(40), improvement: m(90), 'goal-progress': m(10) }))
    expect(r.score).toBe(46)
    expect(r.weightUsed).toBe(7)
  })

  it('rounds half up to a whole point and never above 100 or below 0', () => {
    // Budget (3) at 1 and savings (3) at 0: (3 + 0) / 6 = 0.5 -> 1 (half rounds up, as divRound does everywhere).
    expect(moneyScore(six({ 'budget-awareness': m(1), 'savings-consistency': m(0) })).score).toBe(1)
    // Budget (3) at 33 and learning (2) at 34: (99 + 68) / 5 = 33.4 -> 33.
    expect(moneyScore(six({ 'budget-awareness': m(33), learning: m(34) })).score).toBe(33)
    // A measured zero is a real zero: (3*0 + 2*0) / 5 = 0, and it is a number, not null.
    const zero = moneyScore(six({ 'budget-awareness': m(0), learning: m(0) }))
    expect(zero.score).toBe(0)
    expect(zero.weightUsed).toBe(5)
  })

  it('lets no single component exceed a quarter of the total weight', () => {
    const total = IDS.reduce((s, id) => s + WEIGHTS[id], 0)
    expect(total).toBe(14)
    for (const id of IDS) {
      // weight / total <= 1/4  <=>  4 * weight <= total
      expect(4 * WEIGHTS[id], `${id} would dominate`).toBeLessThanOrEqual(total)
      expect(Number.isInteger(WEIGHTS[id])).toBe(true)
      expect(WEIGHTS[id]).toBeGreaterThan(0)
    }
  })

  it('withholds the score entirely when nothing can be measured yet', () => {
    const r = moneyScore(six({}))
    expect(r.score).toBeNull()
    expect(r.weightUsed).toBe(0)
    expect(r.score).not.toBe(0)
    expect(Number.isNaN(r.score)).toBe(false)
  })

  it('keeps every component in the list, measured or not, so the screen can show all six', () => {
    const r = moneyScore(six({ improvement: m(80), learning: nm('Not enough repeated patterns yet.') }))
    expect(r.components.map((c) => c.id).sort()).toEqual([...IDS].sort())
    expect(r.components).toHaveLength(6)
    const byId = new Map(r.components.map((c) => [c.id, c]))
    expect(byId.get('improvement')?.component).toEqual(m(80))
    expect(byId.get('learning')?.component).toEqual({ kind: 'not-measured', why: 'Not enough repeated patterns yet.' })
    for (const c of r.components) expect(c.weight).toBe(WEIGHTS[c.id])
    // The list is still whole when nothing is measured.
    expect(moneyScore(six({})).components).toHaveLength(6)
  })

  it('gives every component its own non-empty label for the owner', () => {
    const labels = moneyScore(six({})).components.map((c) => c.label)
    expect(labels.every((l) => l.trim().length > 0)).toBe(true)
    expect(new Set(labels).size).toBe(6)
    // A1: a label names what is looked at, never a verdict on the owner.
    for (const l of labels) expect(l).not.toMatch(/\b(fail|bad|poor|wasteful|overspend|lazy|guilt|blame|should)/i)
  })
})
