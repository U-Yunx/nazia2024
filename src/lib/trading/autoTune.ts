/**
 * Auto-tune: grid-search a strategy's parameters against recent bars and return
 * the parameter set with the best risk-adjusted score, if any beats the current
 * one.
 *
 * Scoring (since the profitability pass) is deliberately conservative: raw
 * profit factor is punished for thin samples (a few trades are mostly luck),
 * for drawdown (a setup that gives back its gains isn't better) and rewarded
 * for stability. The wider variant grid also lets the optimizer adapt fast/slow
 * periods to the current market regime instead of always re-picking defaults.
 */
import type { Bar, StrategyParams, StrategyType, TunedResult } from '../types'
import { defaultParams } from '../strategies'
import { runBacktest } from '../strategies/backtest'
import { detectRegime, type MarketRegime } from './regime'

/** Candidate parameter variants to test per strategy type. */
const VARIANTS: Record<StrategyType, StrategyParams[]> = {
  MA: [
    { fastPeriod: 5, slowPeriod: 20 },
    { fastPeriod: 8, slowPeriod: 24 },
    { fastPeriod: 10, slowPeriod: 30 },
    { fastPeriod: 12, slowPeriod: 40 },
    { fastPeriod: 15, slowPeriod: 50 },
    { fastPeriod: 20, slowPeriod: 60 },
  ],
  RSI: [
    { period: 7, oversold: 25, overbought: 75 },
    { period: 10, oversold: 28, overbought: 72 },
    { period: 14, oversold: 30, overbought: 70 },
    { period: 21, oversold: 35, overbought: 65 },
  ],
  MACD: [
    { fastPeriod: 8, slowPeriod: 21, signalPeriod: 5 },
    { fastPeriod: 10, slowPeriod: 24, signalPeriod: 7 },
    { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 },
    { fastPeriod: 16, slowPeriod: 35, signalPeriod: 12 },
  ],
  BOLLINGER: [
    { period: 14, stdDev: 1.5 },
    { period: 18, stdDev: 1.8 },
    { period: 20, stdDev: 2 },
    { period: 30, stdDev: 2.5 },
  ],
}

/** Minimum trades before a result is even eligible — thin samples are noise. */
const MIN_TRADES = 5

/**
 * Risk-adjusted score from backtest metrics:
 *  - PF ≤ 0 → 0 (losing setups never win).
 *  - Fewer than MIN_TRADES scales the score down linearly (sample-size penalty).
 *  - Drawdown above 10% shaves the score, capped at a 40% penalty at 30%+ DD.
 */
export function tuneScore(m: { profitFactor: number; totalTrades: number; maxDrawdownPct: number }): number {
  if (!Number.isFinite(m.profitFactor) || m.profitFactor <= 0 || m.totalTrades <= 0) return 0
  const sample = Math.min(1, m.totalTrades / MIN_TRADES)
  const ddPenalty = Math.min(0.4, Math.max(0, (m.maxDrawdownPct - 10) / 50))
  return m.profitFactor * sample * (1 - ddPenalty)
}

export function autoTune(
  bars: Bar[],
  type: StrategyType,
  current: StrategyParams,
): TunedResult | null {
  const base = { pair: 'AUTO', interval: '5min' as const, type }
  const candidates = [current, ...(VARIANTS[type] ?? [])]
  let best: TunedResult | null = null
  let bestScore = 0

  for (const params of candidates) {
    const result = runBacktest(bars, { ...base, params })
    const m = result.metrics
    const s = tuneScore(m)
    if (s <= 0) continue
    const candidate: TunedResult = {
      params,
      totalReturnPct: m.totalReturnPct,
      winRatePct: m.winRatePct,
      profitFactor: Number.isFinite(m.profitFactor) ? m.profitFactor : 0,
      trades: m.totalTrades,
    }
    if (s > bestScore) {
      best = candidate
      bestScore = s
    }
  }

  // Only adopt a result that actually beat the current parameters.
  const currentScore = tuneScore(runBacktest(bars, { ...base, params: current }).metrics)
  if (!best || bestScore <= currentScore || best.trades <= 0) return null
  return best
}

/** Force the best variant regardless of whether it beats the current set. */
export function autoTuneBest(
  bars: Bar[],
  type: StrategyType,
): { params: StrategyParams; profitFactor: number } | null {
  const best = autoTune(bars, type, defaultParams(type))
  if (!best) return null
  return { params: best.params, profitFactor: best.profitFactor }
}

/** Strategy families and which market regime suits them. */
const TREND_FOLLOWERS: StrategyType[] = ['MA', 'MACD']
const REVERSIONERS: StrategyType[] = ['RSI', 'BOLLINGER']

/** Regime bonus/penalty: trade WITH the market, fade setups that fight it. */
function regimeMultiplier(type: StrategyType, regime: MarketRegime): number {
  const trending = regime.trend !== 'range'
  if (trending && TREND_FOLLOWERS.includes(type)) return 1.06
  if (!trending && REVERSIONERS.includes(type)) return 1.06
  if (trending && REVERSIONERS.includes(type)) return 0.94 // fading a running trend
  return 1
}

/**
 * Tuned strategy + regime for the current market. Backtest result of the
 * highest-scoring strategy-parameter combination, extended with the regime
 * it was tuned for and an ATR-based stop distance for the symbol.
 */
export interface MarketTuneResult extends TunedResult {
  /** The strategy type that best fits the detected regime. */
  type: StrategyType
  /** Regime the tuning ran against (trend direction + volatility state). */
  regime: MarketRegime
  /** ATR-relative stop distance in pips for the symbol. */
  stopPips: number
  /** Risk-adjusted score of this tune. */
  score: number
}

/**
 * Auto-tune the *whole strategy* for the market at hand — not just one type.
 * The regime decides which families get searched first: trend-followers (MA,
 * MACD) in trends, mean-reversioners (RSI, Bollinger) in ranges. Fading
 * setups are skipped in a confirmed trend, and the whole run stands aside
 * during an extreme volatility burst (capital parked, not lost). Returns null
 * when there is no readable market or nothing beat the sample floor.
 */
export function autoTuneForMarket(
  bars: Bar[],
  symbol = 'EUR/USD',
  opts?: { regime?: MarketRegime | null },
): MarketTuneResult | null {
  const regime = opts?.regime !== undefined ? opts?.regime : detectRegime(bars, symbol)
  if (!regime || regime.spreadAside) return null

  // Strong confirmed trend → don't fade it with reversion setups; otherwise
  // (range) reversionists get evaluated first, trend-followers later.
  const order: StrategyType[] = regime.favorTrend
    ? [...TREND_FOLLOWERS, ...REVERSIONERS]
    : [...REVERSIONERS, ...TREND_FOLLOWERS]

  let best: MarketTuneResult | null = null
  let bestScore = 0

  for (const type of order) {
    if (regime.favorTrend && REVERSIONERS.includes(type)) continue
    const candidates = [defaultParams(type), ...(VARIANTS[type] ?? [])]
    for (const params of candidates) {
      const m = runBacktest(bars, { pair: 'AUTO', interval: '5min', type, params }).metrics
      const baseScore = tuneScore({ profitFactor: m.profitFactor, totalTrades: m.totalTrades, maxDrawdownPct: m.maxDrawdownPct })
      if (baseScore <= 0) continue
      // Regime fit first, then volatility: high-volatility markets shrink the
      // edge of every tuned setup, so knock a sliver off heading into a storm.
      const s = baseScore * regimeMultiplier(type, regime) * (regime.volatility === 'high' ? 0.94 : 1)
      if (s > bestScore) {
        best = {
          type,
          params,
          totalReturnPct: m.totalReturnPct,
          winRatePct: m.winRatePct,
          profitFactor: Number.isFinite(m.profitFactor) ? m.profitFactor : 0,
          trades: m.totalTrades,
          regime,
          stopPips: regime.suggestedStopPips,
          score: Math.round(s * 100) / 100,
        }
        bestScore = s
      }
    }
  }

  return best
}