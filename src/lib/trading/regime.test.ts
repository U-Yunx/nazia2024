import { describe, expect, it } from 'vitest'
import type { Bar } from '../types'
import { computeAdx, detectRegime } from './regime'
import { barsFromCloses, burstBars, rangeBars, uptrendBars } from './testBars'

/** A calm EUR/USD-ish series where ATR works out to ~60 pips. */
function eurBars(n: number): Bar[] {
  return barsFromCloses(
    Array.from({ length: n }, (_, i) => 1.08 + Math.sin(i / 4) * 0.004),
    0.006,
  )
}

describe('computeAdx', () => {
  it('reads a strong uptrend as a trend', () => {
    expect(computeAdx(uptrendBars(90))).toBeGreaterThan(30)
  })

  it('reads a choppy mean-reverting range as directionless', () => {
    expect(computeAdx(rangeBars(90))).toBeLessThan(25)
  })
})

describe('detectRegime', () => {
  it('returns null when there is not enough data', () => {
    expect(detectRegime([])).toBeNull()
    expect(detectRegime(rangeBars(10))).toBeNull()
  })

  it('flags an uptrend and favours trend-followers', () => {
    const regime = detectRegime(uptrendBars(90))
    expect(regime).not.toBeNull()
    expect(regime!.trend).toBe('up')
    expect(regime!.favorTrend).toBe(true)
    expect(regime!.favorReversion).toBe(false)
    expect(regime!.spreadAside).toBe(false)
    expect(regime!.volatility).not.toBe('high')
  })

  it('flags a range and favours mean-reversioners', () => {
    const regime = detectRegime(rangeBars(90))
    expect(regime).not.toBeNull()
    expect(regime!.trend).toBe('range')
    expect(regime!.favorReversion).toBe(true)
    expect(regime!.favorTrend).toBe(false)
  })

  it('detects a volatility burst and stands aside', () => {
    const regime = detectRegime(burstBars(80, 6))
    expect(regime).not.toBeNull()
    expect(regime!.volatility).toBe('high')
    expect(regime!.volatilityRatio).toBeGreaterThanOrEqual(1.8)
    expect(regime!.spreadAside).toBe(true)
  })

  it('suggests an ATR-based stop inside the clamp for EUR/USD', () => {
    const regime = detectRegime(eurBars(80))
    expect(regime).not.toBeNull()
    expect(regime!.suggestedStopPips).toBeGreaterThanOrEqual(8)
    expect(regime!.suggestedStopPips).toBeLessThanOrEqual(250)
  })
})