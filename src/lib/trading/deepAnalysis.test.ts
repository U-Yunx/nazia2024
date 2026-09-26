/**
 * deepAnalysis — unit tests for the risk-adjusted analytics engine.
 */
import { describe, expect, it } from 'vitest'
import {
  computeDeepMetrics,
  computeSessionStats,
  robotHealthScore,
} from './deepAnalysis'
import type { RobotHistoryPoint, RobotSessionRow } from './robotHistory'

function point(day: number, equity: number): RobotHistoryPoint {
  return {
    id: String(day),
    session_id: null,
    recorded_at: `2026-03-0${day}T12:00:00Z`,
    balance: equity,
    equity,
    unrealized: 0,
  }
}

function session(partial: Partial<RobotSessionRow>): RobotSessionRow {
  return {
    id: crypto.randomUUID(),
    user_id: 'u1',
    account_id: null,
    method: 'auto',
    strategy: 'ema-cross',
    started_at: '2026-03-01T10:00:00Z',
    initial_balance: 10_000,
    final_balance: null,
    pnl: 0,
    trade_count: 0,
    status: 'finished',
    ...partial,
  }
}

describe('computeDeepMetrics', () => {
  it('returns null with fewer than two points', () => {
    expect(computeDeepMetrics([])).toBeNull()
    expect(computeDeepMetrics([point(1, 10_000)])).toBeNull()
  })

  it('computes return, drawdown series and max drawdown', () => {
    const history = [
      point(1, 10_000),
      point(2, 10_500),
      point(3, 9_000),
      point(4, 9_500),
    ]
    const m = computeDeepMetrics(history)
    expect(m).not.toBeNull()
    expect(m!.startEquity).toBe(10_000)
    expect(m!.endEquity).toBe(9_500)
    expect(m!.returnPct).toBeCloseTo(-5, 5)
    expect(m!.peak).toBe(10_500)
    expect(m!.maxDrawdownPct).toBeCloseTo(-14.2857, 3)
    expect(m!.drawdownSeries[m!.drawdownSeries.length - 1].drawdownPct).toBeCloseTo(-9.5238, 3)
    expect(m!.days).toBe(3)
  })

  it('ignores unsorted and non-positive inputs', () => {
    const history = [point(2, 10_500), point(1, 10_000)]
    const m = computeDeepMetrics(history)
    expect(m!.startEquity).toBe(10_000)
    expect(m!.endEquity).toBe(10_500)
  })

  it('produces finite sharpe/sortino/calmar for a profitable run', () => {
    const history = Array.from({ length: 12 }, (_, i) => point(i + 1, 10_000 * Math.pow(1.005, i + 1)))
    const m = computeDeepMetrics(history)!
    expect(m.sharpe).not.toBeNull()
    expect(Number.isFinite(m.sharpe)).toBe(true)
    expect(m.sortino).not.toBeNull()
    expect(Number.isFinite(m.volatilityPct)).toBe(true)
    expect(m.calmar).not.toBeNull()
  })
})

describe('computeSessionStats', () => {
  it('computes win rate, profit factor and expectancy', () => {
    const stats = computeSessionStats([
      session({ pnl: 100, trade_count: 3 }),
      session({ pnl: 150, trade_count: 4 }),
      session({ pnl: -80, trade_count: 2 }),
      session({ pnl: 0, trade_count: 1 }),
      session({ pnl: 999, status: 'running' }),
    ])
    expect(stats.finished).toBe(4)
    expect(stats.wins).toBe(2)
    expect(stats.losses).toBe(1)
    expect(stats.winRate).toBeCloseTo(50, 5)
    expect(stats.grossProfit).toBe(250)
    expect(stats.grossLoss).toBe(80)
    expect(stats.profitFactor).toBeCloseTo(3.125, 5)
    expect(stats.netPnl).toBe(170)
    expect(stats.avgWin).toBe(125)
    expect(stats.avgLoss).toBe(80)
    expect(stats.expectancy).toBeCloseTo(22.5, 5)
    // running session excluded from best/worst
    expect(stats.bestSession?.pnl).toBe(150)
    expect(stats.worstSession?.pnl).toBe(-80)
  })

  it('breaks performance down by strategy', () => {
    const stats = computeSessionStats([
      session({ strategy: 'ema-cross', pnl: 100 }),
      session({ strategy: 'ema-cross', pnl: -40 }),
      session({ strategy: 'mean-revert', pnl: 200 }),
    ])
    expect(stats.byStrategy).toHaveLength(2)
    expect(stats.byStrategy[0].strategy).toBe('mean-revert')
    expect(stats.byStrategy[0].netPnl).toBe(200)
    expect(stats.byStrategy[1].strategy).toBe('ema-cross')
    expect(stats.byStrategy[1].winRate).toBeCloseTo(50, 5)
    expect(stats.byStrategy[1].profitFactor).toBeCloseTo(2.5, 5)
  })

  it('handles an all-win run without crashing (∞ profit factor)', () => {
    const stats = computeSessionStats([session({ pnl: 50 }), session({ pnl: 80 })])
    expect(stats.profitFactor).toBeNull()
    expect(stats.winRate).toBe(100)
    expect(stats.grossLoss).toBe(0)
  })
})

describe('robotHealthScore', () => {
  it('stays neutral when there is no data', () => {
    const h = robotHealthScore(null, null)
    expect(h.score).toBe(0)
    expect(h.label).toBe('Developing')
    expect(h.watchouts.length).toBeGreaterThan(0)
  })

  it('rewards edge, drawdown control and sample size', () => {
    const history = Array.from({ length: 40 }, (_, i) => point(i + 1, 10_000 * Math.pow(1.003, i + 1)))
    const sessions = Array.from({ length: 35 }, (_, i) =>
      session({ pnl: i % 4 === 0 ? -30 : 60, trade_count: 3 }),
    )
    const h = robotHealthScore(computeDeepMetrics(history), computeSessionStats(sessions))
    expect(h.score).toBeGreaterThanOrEqual(60)
    expect(h.strengths.length).toBeGreaterThan(0)
  })

  it('flags deep drawdown and low profit factor as watchouts', () => {
    const history = [point(1, 10_000), point(2, 10_200), point(3, 7_000), point(4, 7_100)]
    const sessions = Array.from({ length: 12 }, () => session({ pnl: -25, trade_count: 2 }))
    const h = robotHealthScore(computeDeepMetrics(history), computeSessionStats(sessions))
    expect(h.label).toBe('Risky')
    expect(h.watchouts.length).toBeGreaterThan(0)
  })
})
