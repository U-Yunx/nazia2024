/**
 * Per-pair cap comparison. Runs the SAME multi-pair backtest at several
 * per-pair caps over identical bars, strategy and costs, so the effect of
 * holding more positions on one pair — and of the reverse-order (zig-zag) legs
 * that engage above two — can be read off side by side instead of guessed at.
 * `opts.zigZag` overrides the live rule so any cap can be A/B'd as an
 * alternating book against a plain one-way stack, and `capAdvice` turns the
 * rows into a single "which cap paid best" recommendation.
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
 * the zig-zag legs have. Pass `opts.zigZag` to pin the book either way at
 * every cap and A/B an alternating book against a plain one-way stack.
 */
export function comparePerPairCaps(
  barsBySymbol: Record<string, Bar[]>,
  config: StrategyConfig,
  base: MultiBacktestSettings,
  opts: { caps?: number[]; signalSide?: Side; startEquity?: number; zigZag?: boolean } = {},
): CapComparisonRow[] {
  const caps = opts.caps ?? DEFAULT_CAP_COMPARISON
  const signalSide = opts.signalSide ?? 'long'
  return caps.map((cap) => {
    const tradeMode: TradeMode = cap <= 1 ? 'sequential' : 'concurrent'
    const liveRule = tradeMode === 'concurrent' && cap >= ZIG_ZAG_MIN_PER_PAIR
    const zigZag = opts.zigZag ?? liveRule
    const result = runMultiBacktest(
      barsBySymbol,
      config,
      { ...base, tradeMode, maxPerPair: cap, zigZag },
      opts.startEquity,
    )
    return { cap, tradeMode, zigZag, sequence: legSequence(signalSide, cap, zigZag), result }
  })
}

/**
 * The fill order a pair would book for `count` legs: the reverse-order
 * (zig-zag) sequence when the alternating book is on, otherwise every leg
 * follows the signal side.
 */
export function legSequence(side: Side, count: number, zigZag: boolean): Side[] {
  return zigZag ? zigZagSequence(side, count) : Array.from({ length: count }, () => side)
}

export interface CapAdvice {
  /** All rows the advice was computed from. */
  rows: CapComparisonRow[]
  /** Index (into `rows`) of the strongest cap. */
  bestIndex: number
  /** The strongest row — highest net profit, ties broken by shallower drawdown. */
  best: CapComparisonRow | null
  /** The next-strongest row, for the "extra legs cost more than they earned"
   *  contrast. Null when there is only one row. */
  runnerUp: CapComparisonRow | null
  /** True when no cap produced a single trade — nothing to recommend. */
  empty: boolean
  /** True when the strongest cap cleared costs (net profit > 0). */
  profitable: boolean
}

/**
 * One-line "which cap pays best" recommendation from a comparison: the row
 * with the highest net profit after costs, the runner-up for contrast, and two
 * flags so the UI can phrase the advice honestly (nothing traded / it lost).
 */
export function capAdvice(rows: CapComparisonRow[]): CapAdvice {
  if (rows.length === 0) {
    return { rows, bestIndex: -1, best: null, runnerUp: null, empty: true, profitable: false }
  }
  const bestIndex = bestCapRowIndex(rows)
  const best = rows[bestIndex]
  const rest = rows.filter((_, i) => i !== bestIndex)
  const runnerUp = rest.length > 0 ? rest[bestCapRowIndex(rest)] : null
  return {
    rows,
    bestIndex,
    best,
    runnerUp,
    empty: rows.every((r) => r.result.metrics.totalTrades === 0),
    profitable: (best?.result.metrics.netProfit ?? 0) > 0,
  }
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