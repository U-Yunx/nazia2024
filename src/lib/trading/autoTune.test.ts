import { describe, expect, it } from 'vitest'
import { autoTuneForMarket } from './autoTune'
import { burstBars, rangeBars, trendingWavesBars } from './testBars'

describe('autoTuneForMarket', () => {
  it('stands aside during an extreme volatility burst (returns null)', () => {
    expect(autoTuneForMarket(burstBars(80, 6), 'EUR/USD')).toBeNull()
  })

  it('returns null on empty or short data', () => {
    expect(autoTuneForMarket([])).toBeNull()
  })

  it('tunes the market on range data and suggests an ATR-based stop', () => {
    const tuned = autoTuneForMarket(rangeBars(140), 'EUR/USD')
    expect(tuned).not.toBeNull()
    expect(tuned!.profitFactor).toBeGreaterThan(0)
    expect(tuned!.trades).toBeGreaterThan(0)
    expect(['MA', 'MACD', 'RSI', 'BOLLINGER']).toContain(tuned!.type)
    expect(tuned!.stopPips).toBeGreaterThanOrEqual(8)
    expect(tuned!.stopPips).toBeLessThanOrEqual(250)
  })

  it('prefers a trend-following strategy on a trending market', () => {
    const tuned = autoTuneForMarket(trendingWavesBars(140), 'EUR/USD')
    expect(tuned).not.toBeNull()
    expect(['MA', 'MACD']).toContain(tuned!.type)
  })

  it('exposes the regime + tuned config on the result', () => {
    const tuned = autoTuneForMarket(rangeBars(140), 'EUR/USD')
    expect(tuned).not.toBeNull()
    expect(tuned!.regime.trend).toBe('range')
    expect(tuned!.params).toBeDefined()
  })
})