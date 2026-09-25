/**
 * Per-pair cap comparison. Runs the SAME multi-pair backtest at several
 * per-pair caps over identical bars, strategy and costs, so the effect of
 * holding more positions on one pair — and of the reverse-order (zig-zag) legs
 * that engage above two — can be read off side by side instead of guessed at.
 */
import type { Bar, BacktestResult, StrategyConfig } from '../types'
import type { Side, TradeMode } from '../trading/types'
import { ZIG_ZAG_MIN_PER_PAIR, zigZagSequence } from '../trading/engine'
import { runMultiBacktest, type MultiBacktestSettings } from './backtest'

/** Caps compared by default: one-way, two-per-pair, and past the zig-zag line. */
export const DEFAULT_CAP_COMPARISON = [1, 2, 4]

export interface CapComparisonRow {
  /** Positions allowed per pair in this run. */
  cap: number
  tradeMode: TradeMode
  /** True when the zig-zag rule is live at this cap (concurrent, cap ≥ 3). */
  zigZag: boolean
  /** The legs a pair fills, in order, for `signalSide` (a sell signal mirrors it). */
  sequence: Side[]
  result: BacktestResult
}

/**
 * Backtest the same watchlist and strategy once per cap. Cap 1 runs sequential
 * (one position per pair), everything above runs concurrent, and the zig-zag
 * flag follows the live rule at each cap — so `zigZag: false` in `base` is
 * deliberately overridden, otherwise the comparison couldn't show the effect
 * the zig-zag legs have.
 */
export function comparePerPairCaps(
  barsBySymbol: Record<string, Bar[]>,
  config: StrategyConfig,
  base: MultiBacktestSettings,
  opts: { caps?: number[]; signalSide?: Side; startEquity?: number } = {},
): CapComparisonRow[] {
  const caps = opts.caps ?? DEFAULT_CAP_COMPARISON
  const signalSide = opts.signalSide ?? 'long'
  return caps.map((cap) => {
    const tradeMode: TradeMode = cap <= 1 ? 'sequential' : 'concurrent'
    const zigZag = tradeMode === 'concurrent' && cap >= ZIG_ZAG_MIN_PER_PAIR
    const result = runMultiBacktest(
      barsBySymbol,
      config,
      { ...base, tradeMode, maxPerPair: cap, zigZag },
      opts.startEquity,
    )
    return { cap, tradeMode, zigZag, sequence: zigZagSequence(signalSide, cap), result }
  })
}

/**
 * Index of the strongest row — highest net profit, ties broken by the shallower
 * max drawdown. Returns -1 for an empty list.
 */
export function bestCapRowIndex(rows: CapComparisonRow[]): number {
  let best = -1
  rows.forEach((row, i) => {
    if (best < 0) {
      best = i
      return
    }
    const b = rows[best]
    const better =
      row.result.metrics.netProfit > b.result.metrics.netProfit ||
      (row.result.metrics.netProfit === b.result.metrics.netProfit &&
        row.result.metrics.maxDrawdownPct < b.result.metrics.maxDrawdownPct)
    if (better) best = i
  })
  return best
}
