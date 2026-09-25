import { describe, it, expect } from 'vitest'
import type { Bar, StrategyConfig } from '../types'
import { zigZagSequence } from '../trading/engine'
import { computeSignal } from './signals'
import { runMultiBacktest, type MultiBacktestSettings } from './backtest'
import {
  bestCapRowIndex,
  capAdvice,
  comparePerPairCaps,
  DEFAULT_CAP_COMPARISON,
  legSequence,
  type CapComparisonRow,
} from './capComparison'

const STRATEGY: StrategyConfig = {
  pair: 'EUR/USD',
  interval: '5min',
  type: 'BOLLINGER',
  params: { period: 20, stdDev: 2 },
}

/** Unique, monotonic timestamps so the merged event stream is unambiguous. */
function barsFromCloses(closes: number[], spread = 0.28): Bar[] {
  return closes.map((close, i) => ({
    time: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
    open: close,
    high: close + spread,
    low: close - spread,
    close,
  }))
}

/**
 * A calm base with one isolated sharp dip per cluster. The base closes
 * alternate ±0.05 so every 20-bar window always has a real (non-zero)
 * deviation — 20 identical closes would collapse the bands onto the price
 * (`upper == lower == close`) and read as a sell. Against that base a single
 * dip bar sits more than 2σ below the mean while barely moving σ itself, so it
 * pierces the lower band with RSI ≈ 34 — a repeatable BUY — and the base bars
 * around it stay neutral. Clusters are 22 bars apart so only one dip ever falls
 * inside the 20-bar band window (two dips would widen σ and stop the pierce).
 */
const DIP_INDICES = [30, 52, 74, 96]
const BAR_COUNT = 120
const DIP_CLOSE = 99.4

function baseCloses(length: number, step = 0.05): number[] {
  return Array.from({ length }, (_, i) => 100 + (i % 2 === 0 ? step : -step))
}

function dipBars(): Bar[] {
  const closes = baseCloses(BAR_COUNT)
  for (const i of DIP_INDICES) closes[i] = DIP_CLOSE
  return barsFromCloses(closes)
}

/**
 * A second pair that never signals: closes alternate ±0.2, which keeps the band
 * width (σ = 0.2, so 100 ± 0.4) safely around every close and RSI pinned at 50 —
 * so neither the buy nor the sell condition is ever met.
 */
function neutralBars(): Bar[] {
  return barsFromCloses(baseCloses(BAR_COUNT, 0.2))
}

const PAIRS = ['EUR/USD', 'GBP/USD']
const BARS: Record<string, Bar[]> = { 'EUR/USD': dipBars(), 'GBP/USD': neutralBars() }
const BASE: MultiBacktestSettings = {
  pairs: PAIRS,
  tradeMode: 'concurrent',
  maxPerPair: 4,
  maxOpenTrades: 10,
  costPerTrade: 0,
}

describe('capComparison fixtures', () => {
  it('signals a buy on every dip bar and stays neutral elsewhere', () => {
    const bars = dipBars()
    for (const idx of DIP_INDICES) {
      expect(computeSignal(bars.slice(0, idx + 1), STRATEGY).signal).toBe('buy')
    }
    for (const idx of [10, 40, 60, 110, 119]) {
      expect(computeSignal(bars.slice(0, idx + 1), STRATEGY).signal).toBe('neutral')
    }
  })

  it('never signals on the flat companion pair', () => {
    const bars = neutralBars()
    for (const idx of [25, 50, 75, 100, 119]) {
      expect(computeSignal(bars.slice(0, idx + 1), STRATEGY).signal).toBe('neutral')
    }
  })
})

describe('zigZagSequence', () => {
  it('stays one-way below the zig-zag line', () => {
    expect(zigZagSequence('long', 1)).toEqual(['long'])
    expect(zigZagSequence('long', 2)).toEqual(['long', 'long'])
    expect(zigZagSequence('short', 2)).toEqual(['short', 'short'])
  })

  it('alternates every leg after the second', () => {
    expect(zigZagSequence('long', 4)).toEqual(['long', 'long', 'short', 'long'])
    expect(zigZagSequence('long', 6)).toEqual(['long', 'long', 'short', 'long', 'short', 'long'])
    // A sell signal mirrors the pattern.
    expect(zigZagSequence('short', 4)).toEqual(['short', 'short', 'long', 'short'])
  })

  it('clamps to the requested count and handles an empty cap', () => {
    expect(zigZagSequence('long', 6, 3)).toEqual(['long', 'long', 'short'])
    expect(zigZagSequence('long', 0)).toEqual([])
  })
})

describe('comparePerPairCaps', () => {
  it('runs one row per cap with the live mode and zig-zag flags', () => {
    const rows = comparePerPairCaps(BARS, STRATEGY, BASE)
    expect(rows.map((r) => r.cap)).toEqual(DEFAULT_CAP_COMPARISON)
    expect(rows.map((r) => r.tradeMode)).toEqual(['sequential', 'concurrent', 'concurrent'])
    expect(rows.map((r) => r.zigZag)).toEqual([false, false, true])
    expect(rows.map((r) => r.sequence.join(','))).toEqual([
      'long',
      'long,long',
      'long,long,short,long',
    ])
    for (const row of rows) {
      expect(Number.isFinite(row.result.metrics.netProfit)).toBe(true)
      expect(Number.isFinite(row.result.metrics.maxDrawdownPct)).toBe(true)
      expect(row.result.metrics.totalTrades).toBeGreaterThan(0)
    }
  })

  it('matches a direct sequential run at cap 1, so the baseline is honest', () => {
    const rows = comparePerPairCaps(BARS, STRATEGY, BASE, { caps: [1] })
    const direct = runMultiBacktest(BARS, STRATEGY, { ...BASE, tradeMode: 'sequential', maxPerPair: 1 })
    expect(rows[0].result.metrics).toEqual(direct.metrics)
  })

  it('is deterministic for identical input', () => {
    const a = comparePerPairCaps(BARS, STRATEGY, BASE)
    const b = comparePerPairCaps(BARS, STRATEGY, BASE)
    expect(a.map((r) => r.result.metrics)).toEqual(b.map((r) => r.result.metrics))
  })

  it('ignores an explicit zigZag: false so every row uses the live rule', () => {
    const rows = comparePerPairCaps(BARS, STRATEGY, { ...BASE, zigZag: false })
    expect(rows[2].zigZag).toBe(true)
  })
})

describe('bestCapRowIndex', () => {
  const row = (cap: number, netProfit: number, maxDrawdownPct: number) =>
    ({
      cap,
      tradeMode: 'concurrent',
      zigZag: false,
      sequence: [],
      result: { metrics: { netProfit, maxDrawdownPct } },
    }) as unknown as CapComparisonRow

  it('picks the highest net profit', () => {
    expect(bestCapRowIndex([row(1, 10, 5), row(2, 4, 1), row(4, -3, 2)])).toBe(0)
  })

  it('breaks ties on the shallower drawdown', () => {
    expect(bestCapRowIndex([row(1, 10, 5), row(2, 10, 3), row(4, 5, 1)])).toBe(1)
  })

  it('returns -1 for an empty comparison', () => {
    expect(bestCapRowIndex([])).toBe(-1)
  })
})

describe('runMultiBacktest — reverse-order (zig-zag) legs', () => {
  it('keeps a one-way stack at a cap of 2', () => {
    const result = runMultiBacktest(BARS, STRATEGY, { ...BASE, maxPerPair: 2 })
    expect(result.metrics.totalTrades).toBe(2)
    expect(result.trades.every((t) => t.side === 'long')).toBe(true)
  })

  it('opens reversed legs above 2 per pair, booking two-way trades', () => {
    const wide = runMultiBacktest(BARS, STRATEGY, { ...BASE, maxPerPair: 4 })
    const narrow = runMultiBacktest(BARS, STRATEGY, { ...BASE, maxPerPair: 2 })
    // Four dip signals fill long, long, short, long — the third leg reverses,
    // so the wider cap books shorts the one-way stack never sees.
    expect(narrow.trades.every((t) => t.side === 'long')).toBe(true)
    expect(wide.trades.filter((t) => t.side === 'short')).toHaveLength(2)
    // One of them is closed by the reversal itself, not left to the end.
    expect(wide.trades.some((t) => t.side === 'short' && t.reason === 'signal')).toBe(true)
    expect(wide.metrics.totalTrades).toBeGreaterThan(narrow.metrics.totalTrades)
  })

  it('stays one-way at the same cap when zigZag is switched off', () => {
    const result = runMultiBacktest(BARS, STRATEGY, { ...BASE, maxPerPair: 4, zigZag: false })
    // Four same-side legs fill the cap and are only closed at the end of data.
    expect(result.metrics.totalTrades).toBe(4)
    expect(result.trades.every((t) => t.side === 'long')).toBe(true)
    expect(result.trades.every((t) => t.reason === 'end')).toBe(true)
  })
})

describe('legSequence', () => {
  it('mirrors the live book when zig-zag is on and stacks when it is off', () => {
    expect(legSequence('long', 4, true)).toEqual(['long', 'long', 'short', 'long'])
    expect(legSequence('long', 4, false)).toEqual(['long', 'long', 'long', 'long'])
    // A sell signal mirrors the pattern, and stacks short when off.
    expect(legSequence('short', 3, true)).toEqual(['short', 'short', 'long'])
    expect(legSequence('short', 3, false)).toEqual(['short', 'short', 'short'])
    expect(legSequence('long', 0, true)).toEqual([])
  })
})

describe('comparePerPairCaps — zigZag override', () => {
  it('pins the one-way stack at a cap that would otherwise alternate', () => {
    const rows = comparePerPairCaps(BARS, STRATEGY, BASE, { zigZag: false })
    expect(rows.map((r) => r.zigZag)).toEqual([false, false, false])
    expect(rows[2].sequence).toEqual(['long', 'long', 'long', 'long'])
    // Same cap, no alternating book: only long legs, all closed at the end.
    expect(rows[2].result.trades.every((t) => t.side === 'long')).toBe(true)
    expect(rows[2].result.trades.every((t) => t.reason === 'end')).toBe(true)
  })

  it('forces the alternating book below the zig-zag line', () => {
    const rows = comparePerPairCaps(BARS, STRATEGY, BASE, { zigZag: true })
    expect(rows.map((r) => r.zigZag)).toEqual([true, true, true])
    expect(rows[0].sequence).toEqual(['long'])
    expect(rows[1].sequence).toEqual(['long', 'long'])
  })

  it('reproduces the live rule when no override is given', () => {
    const live = comparePerPairCaps(BARS, STRATEGY, BASE)
    const forced = comparePerPairCaps(BARS, STRATEGY, BASE, { zigZag: true })
    expect(live[2].result.metrics).toEqual(forced[2].result.metrics)
  })

  it('matches a direct one-way run at the same cap', () => {
    const rows = comparePerPairCaps(BARS, STRATEGY, BASE, { caps: [4], zigZag: false })
    const direct = runMultiBacktest(BARS, STRATEGY, { ...BASE, maxPerPair: 4, zigZag: false })
    expect(rows[0].result.metrics).toEqual(direct.metrics)
  })
})

describe('capAdvice', () => {
  const adviceFor = (netProfits: number[], totalTrades = 3) =>
    capAdvice(
      netProfits.map(
        (netProfit, i) =>
          ({
            cap: i + 1,
            tradeMode: 'concurrent',
            zigZag: false,
            sequence: [],
            result: { metrics: { netProfit, maxDrawdownPct: 5, totalTrades } },
          }) as unknown as CapComparisonRow,
      ),
    )

  it('points at the highest net profit and names the runner-up', () => {
    const advice = adviceFor([10, 40, 25])
    expect(advice.bestIndex).toBe(1)
    expect(advice.best?.cap).toBe(2)
    expect(advice.runnerUp?.cap).toBe(3)
    expect(advice.profitable).toBe(true)
    expect(advice.empty).toBe(false)
  })

  it('reports an unprofitable comparison instead of hiding it', () => {
    const advice = adviceFor([-30, -12, -50])
    expect(advice.best?.cap).toBe(2)
    expect(advice.profitable).toBe(false)
    expect(advice.empty).toBe(false)
  })

  it('flags an empty comparison when no cap traded', () => {
    const advice = adviceFor([0, 0], 0)
    expect(advice.empty).toBe(true)
    expect(advice.profitable).toBe(false)
  })

  it('has no runner-up for a single row and handles an empty list', () => {
    expect(adviceFor([5]).runnerUp).toBeNull()
    const none = capAdvice([])
    expect(none.best).toBeNull()
    expect(none.bestIndex).toBe(-1)
    expect(none.empty).toBe(true)
  })

  it('recommends a real cap from the live comparison', () => {
    const advice = capAdvice(comparePerPairCaps(BARS, STRATEGY, BASE))
    expect(advice.best).not.toBeNull()
    expect(advice.empty).toBe(false)
    expect(advice.runnerUp).not.toBeNull()
    expect(advice.rows).toHaveLength(DEFAULT_CAP_COMPARISON.length)
    // The fixture's dips all end profitable, so the advice is a positive one.
    expect(advice.profitable).toBe(true)
  })
})
