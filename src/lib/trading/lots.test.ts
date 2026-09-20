import { describe, expect, it } from 'vitest'
import {
  LOT_STEP,
  LOT_UNITS,
  MIN_LOT,
  formatLots,
  lotsToUnits,
  normalizeLots,
  riskUnits,
  sizingUnits,
  unitsToLots,
} from './lots'

describe('trading lots', () => {
  it('converts units to lots at a contract size', () => {
    expect(unitsToLots(LOT_UNITS)).toBe(1)
    expect(unitsToLots(50_000)).toBe(0.5)
    expect(unitsToLots(7_000)).toBe(0.07)
    expect(unitsToLots(0)).toBe(0)
    expect(unitsToLots(NaN)).toBe(0)
    // Account-aware contracts: mini 10k, micro 1k, nano 100 units per lot.
    expect(unitsToLots(5_000, 10_000)).toBe(0.5)
    expect(unitsToLots(500, 1_000)).toBe(0.5)
    expect(unitsToLots(50, 100)).toBe(0.5)
  })

  it('converts lots to whole units at a contract size', () => {
    expect(lotsToUnits(1)).toBe(100_000)
    expect(lotsToUnits(0.05)).toBe(5_000)
    expect(lotsToUnits(1.234)).toBe(123_400)
    expect(lotsToUnits(0)).toBe(0)
    expect(lotsToUnits(NaN)).toBe(0)
    expect(lotsToUnits(1, 10_000)).toBe(10_000)
    expect(lotsToUnits(0.05, 10_000)).toBe(500)
    expect(lotsToUnits(0.05, 1_000)).toBe(50)
    expect(lotsToUnits(0.05, 100)).toBe(5)
    // Below one micro-lot is not a valid size.
    expect(lotsToUnits(0.001, 100)).toBe(0)
  })

  it('snaps lots to the 0.01 step', () => {
    expect(normalizeLots(1.234)).toBe(1.23)
    expect(normalizeLots(0.016)).toBe(0.02)
    expect(normalizeLots(0.004)).toBe(0.01)
    expect(normalizeLots(0)).toBe(0)
    expect(normalizeLots(NaN)).toBe(0)
    expect(LOT_STEP).toBe(0.01)
    expect(MIN_LOT).toBe(0.01)
  })

  it('sizes risk-based positions from equity, stop and pip value', () => {
    // $10k equity, 1% risk = $100. Stop 20 pips × $0.0001/pip/unit = $0.002/unit
    // → 50,000 units, rounded down to the 0.01-lot (1,000-unit) step.
    const units = riskUnits({
      equityUsd: 10_000,
      riskPct: 1,
      stopPips: 20,
      pipValuePerUnit: 0.0001,
      contractSize: 100_000,
    })
    expect(units).toBe(50_000)

    // Tiny Nano budget: 1% of $100 with a wide stop → floors at one micro-lot
    // (0.01 × 100 = 1 unit — brokers never step below 0.01 lot).
    const nano = riskUnits({
      equityUsd: 100,
      riskPct: 1,
      stopPips: 50,
      pipValuePerUnit: 0.0001,
      contractSize: 100,
    })
    expect(nano).toBe(1)

    expect(riskUnits({ equityUsd: 0, riskPct: 1, stopPips: 20, pipValuePerUnit: 0.0001 })).toBe(0)
    expect(riskUnits({ equityUsd: 100, riskPct: 1, stopPips: 20, pipValuePerUnit: 0 })).toBe(0)
  })

  it('sizes robot trades by mode', () => {
    // Fixed: 0.05 lots of a mini contract = 500 units.
    expect(
      sizingUnits({ mode: 'fixed', lot: 0.05, riskPct: 1, equityUsd: 2_000, stopPips: 20, pipValuePerUnit: 0.0001, contractSize: 10_000 }),
    ).toBe(500)
    // Risk: 2% of $2,000 = $40, stop 20 pips → 20,000 units on a mini contract.
    expect(
      sizingUnits({ mode: 'risk', lot: 0, riskPct: 2, equityUsd: 2_000, stopPips: 20, pipValuePerUnit: 0.0001, contractSize: 10_000 }),
    ).toBe(20_000)
    // Fixed below the micro-lot floor is invalid.
    expect(
      sizingUnits({ mode: 'fixed', lot: 0.001, riskPct: 1, equityUsd: 2_000, stopPips: 20, pipValuePerUnit: 0.0001, contractSize: 10_000 }),
    ).toBe(0)
  })

  it('formats lots without trailing-zero noise', () => {
    expect(formatLots(0.07)).toBe('0.07')
    expect(formatLots(0.07000000000001)).toBe('0.07')
    expect(formatLots(1)).toBe('1')
    expect(formatLots(1.25)).toBe('1.25')
    expect(formatLots(25)).toBe('25')
  })
})