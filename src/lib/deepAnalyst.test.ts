/**
 * Deep Analyst context-builder tests. The builder is the only pure logic in
 * the Deep Analyst flow — everything else is a UI panel + an Edge Function —
 * so it carries the unit coverage: pnl sign, trend/volatility, remaining R:R
 * and peak pull-back must all be computed exactly for the LLM prompt.
 */
import { describe, expect, it } from 'vitest'
import { buildDeepAnalystContext } from './deepAnalyst'
import type { AccountState, Position } from './trading/types'
import type { Bar } from './types'

const account: AccountState = {
  id: null,
  broker: 'paper',
  currency: 'USD',
  initialBalance: 10_000,
  balance: 10_000,
  risk: {
    kind: 'standard',
    riskPerTradePct: 1,
    maxOpenPositions: 5,
    defaultStopPips: 20,
    takeProfitRatio: 2,
    profitUnit: 'usd',
    targetPerTradeUsd: 0,
    maxLossPerTradeUsd: 0,
    targetPerTradePips: 0,
    maxLossPerTradePips: 0,
    maxDailyLossPct: 5,
    autoTrade: false,
    trailingStop: true,
    trailPips: 15,
    breakEvenPips: 10,
    trailActivationPips: 12,
    maxConsecutiveLosses: 0,
    adaptiveRisk: true,
    volatilityFilter: false,
    profitPullbackPct: 25,
    profitPullbackActivateUsd: 1,
    peakReturnClose: false,
    peakReturnGivebackPct: 10,
    drawdownClosePct: 25,
    costPerTradeUsd: 0,
    partialTakeProfit: false,
    partialClosePct: 50,
    partialTpRatio: 1,
  },
  positions: [],
  trades: [],
  createdAt: null,
  updatedAt: null,
}

function position(overrides: Partial<Position> = {}): Position {
  return {
    id: 'p1',
    symbol: 'EUR/USD',
    side: 'long',
    units: 1_000,
    entryPrice: 1.1000,
    entryTime: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    stopPrice: 1.0980,
    takeProfitPrice: 1.1040,
    entryEquity: 10_000,
    status: 'open',
    ...overrides,
  }
}

function bars(close: number): Bar[] {
  // 30 flat-ish bars so trend ≈ 0 and volatility is tiny and finite.
  return Array.from({ length: 30 }, (_, i) => ({
    time: new Date(Date.now() - (30 - i) * 900_000).toISOString(),
    open: close,
    high: close + 0.0001,
    low: close - 0.0001,
    close,
    volume: 100,
  }))
}

describe('buildDeepAnalystContext', () => {
  it('computes a positive pnl and remaining R:R for a winning long', () => {
    const ctx = buildDeepAnalystContext(position(), 1.1010, account, {}, bars(1.1010))
    expect(ctx.market.pnlUsd).toBeGreaterThan(0)
    expect(ctx.market.pnlPct).toBeGreaterThan(0)
    // Risk left = 1.1010 − 1.0980 = 30 pips; reward left = 1.1040 − 1.1010 = 30 pips.
    expect(ctx.market.remainingRiskPips).toBeCloseTo(30, 0)
    expect(ctx.market.remainingRewardPips).toBeCloseTo(30, 0)
    expect(ctx.market.riskRewardRemaining).toBeCloseTo(1, 1)
  })

  it('reports a loss for a losing short', () => {
    const ctx = buildDeepAnalystContext(
      position({ side: 'short', entryPrice: 1.1000, stopPrice: 1.1020, takeProfitPrice: 1.0960 }),
      1.1010,
      account,
      {},
    )
    expect(ctx.market.pnlUsd).toBeLessThan(0)
    // A short above entry: risk = 1.1010 → 1.1020 = 10 pips to the stop.
    expect(ctx.market.remainingRiskPips).toBeCloseTo(10, 0)
    // Reward = 1.1010 → 1.0960 = 50 pips to the take-profit (still reachable).
    expect(ctx.market.remainingRewardPips).toBeCloseTo(50, 0)
    expect(ctx.market.riskRewardRemaining).toBeCloseTo(5, 1)
  })

  it('measures pull-back from the stored peak profit', () => {
    const ctx = buildDeepAnalystContext(
      position({ peakProfitUsd: 40 }),
      1.1010,
      account,
      {},
      bars(1.1010),
    )
    // Pnl at 1.1010 from 1.1000 on 1000 units ≈ $10 → 75% below the $40 peak.
    expect(ctx.market.pullbackFromPeakPct).not.toBeNull()
    expect(ctx.market.pullbackFromPeakPct!).toBeGreaterThan(50)
  })

  it('computes trend and volatility from the supplied history', () => {
    const rising = Array.from({ length: 30 }, (_, i) => ({
      time: new Date(Date.now() - (30 - i) * 900_000).toISOString(),
      open: 1.09 + i * 0.0001,
      high: 1.09 + i * 0.0001 + 0.0002,
      low: 1.09 + i * 0.0001 - 0.0002,
      close: 1.09 + i * 0.0001,
    }))
    const ctx = buildDeepAnalystContext(position(), 1.1010, account, {}, rising)
    expect(ctx.market.trendPct).not.toBeNull()
    expect(ctx.market.trendPct!).toBeGreaterThan(0)
    expect(ctx.market.atrPct).not.toBeNull()
    expect(ctx.market.swingHigh).not.toBeNull()
    expect(ctx.market.swingLow).not.toBeNull()
  })

  it('degrades gracefully without history', () => {
    const ctx = buildDeepAnalystContext(position(), 1.1010, account)
    expect(ctx.market.atrPct).toBeNull()
    expect(ctx.market.trendPct).toBeNull()
    expect(ctx.market.swingHigh).toBeNull()
    expect(ctx.market.series).toEqual([])
    // Core facts still present.
    expect(ctx.position.symbol).toBe('EUR/USD')
    expect(ctx.market.mark).toBe(1.1010)
    expect(ctx.account.mode).toBe('paper')
  })
})
