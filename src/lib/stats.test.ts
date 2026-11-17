import { describe, it, expect } from 'vitest'
import { medianOf } from './stats'

describe('medianOf', () => {
  it('is null for nothing, not zero', () => { expect(medianOf([])).toBeNull() })
  it('is the middle value of an odd count, whatever order it arrives in', () => { expect(medianOf([900, 100, 500])).toBe(500) })
  it('averages the two middle values of an even count', () => { expect(medianOf([100, 300, 500, 900])).toBe(400) })
  it('rounds a half cent away from zero', () => {
    expect(medianOf([300, 501])).toBe(401) // 400.5
    expect(medianOf([-501, -300])).toBe(-401) // -400.5
  })
  it('does not reorder its input', () => {
    const v = [3, 1, 2]
    medianOf(v)
    expect(v).toEqual([3, 1, 2])
  })
})
