import { describe, expect, it } from 'vitest'
import { LOT_UNITS, formatLots, lotsToUnits, unitsToLots } from './lots'

describe('trading lots', () => {
  it('converts units to lots', () => {
    expect(unitsToLots(LOT_UNITS)).toBe(1)
    expect(unitsToLots(50_000)).toBe(0.5)
    expect(unitsToLots(7_000)).toBe(0.07)
    expect(unitsToLots(0)).toBe(0)
    expect(unitsToLots(NaN)).toBe(0)
  })

  it('converts lots to whole units', () => {
    expect(lotsToUnits(1)).toBe(100_000)
    expect(lotsToUnits(0.05)).toBe(5_000)
    expect(lotsToUnits(1.234)).toBe(123_400)
    expect(lotsToUnits(0)).toBe(0)
    expect(lotsToUnits(NaN)).toBe(0)
  })

  it('formats lots without trailing-zero noise', () => {
    expect(formatLots(0.07)).toBe('0.07')
    expect(formatLots(0.07000000000001)).toBe('0.07')
    expect(formatLots(1)).toBe('1')
    expect(formatLots(1.25)).toBe('1.25')
    expect(formatLots(1)).toBe('1')
  })
})