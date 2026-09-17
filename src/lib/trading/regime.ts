/**
 * Market-regime detection for the robot's auto-tuning.
 *
 * Classifies a pair's recent bars into a trend state (up / down / range via
 * Wilder ADX + SMA-20 position) and a volatility state (low / normal / high via
 * ATR-14 as a % of price vs. its own trailing baseline). The robot uses this:
 *
 *   - to prefer trend-followers (MA, MACD) in trends and mean-reversioners
 *     (RSI, Bollinger) in ranges, instead of always treating every strategy
 *     as equally valid on every market,
 *   - to widen stops when volatility is high and stand aside on extreme
 *     bursts (capital parked, not lost),
 *   - to scale the suggested stop distance from ATR instead of a fixed pip
 *     count, so stops adapt to the market actually being traded.
 */
import type { Bar } from '../types'
import { atr, sma } from '../strategies/indicators'
import { pipSize } from './risk'

export type TrendRegime = 'up' | 'down' | 'range'
export type VolatilityRegime = 'low' | 'normal' | 'high'

/** Bars needed before regime detection is stable (ADX needs ~2× period + warm-up). */
export const MIN_REGIME_BARS = 60
/** ADX at/above this = a tradeable trend (below = range). */
export const ADX_TREND = 24
/** ATR multiple used for the suggested stop distance. */
export const ATR_STOP_MULTIPLIER = 1.6
/** Volatility ratio at/above this = extreme burst → stand aside. */
export const SPREAD_ASIDE_RATIO = 2.4

export interface MarketRegime {
  trend: TrendRegime
  volatility: VolatilityRegime
  /** Wilder ADX(14), 0–100 — trend strength. */
  adx: number
  /** ATR14 as a % of the latest close. */
  atrPct: number
  /** Current ATR% divided by its trailing baseline (1 = average conditions). */
  volatilityRatio: number
  /** True when the regime favours trend-following strategies (MA/MACD). */
  favorTrend: boolean
  /** True when the regime favours mean-reversion strategies (RSI/Bollinger). */
  favorReversion: boolean
  /** Extreme volatility burst — the optimizer should stand aside, not chase. */
  spreadAside: boolean
  /** ATR-relative stop distance in pips (clamped 8–250). */
  suggestedStopPips: number
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

const median = (vals: number[]): number => {
  if (vals.length === 0) return 0
  const sorted = [...vals].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** Wilder's ADX(14) — trend strength 0–100. 0 when there isn't enough data. */
export function computeAdx(bars: Bar[], period = 14): number {
  if (bars.length < period * 2 + 2) return 0
  const trueRanges: number[] = []
  const plusDm: number[] = []
  const minusDm: number[] = []
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i]
    const p = bars[i - 1]
    const up = b.high - p.high
    const dn = p.low - b.low
    trueRanges.push(Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close)))
    plusDm.push(up > dn && up > 0 ? up : 0)
    minusDm.push(dn > up && dn > 0 ? dn : 0)
  }
  let atrSum = trueRanges.slice(0, period).reduce((s, v) => s + v, 0) / period
  let plusSum = plusDm.slice(0, period).reduce((s, v) => s + v, 0) / period
  let minusSum = minusDm.slice(0, period).reduce((s, v) => s + v, 0) / period
  const dx: number[] = []
  for (let i = period; i < trueRanges.length; i++) {
    atrSum = (atrSum * (period - 1) + trueRanges[i]) / period
    plusSum = (plusSum * (period - 1) + plusDm[i]) / period
    minusSum = (minusSum * (period - 1) + minusDm[i]) / period
    const denom = plusSum + minusSum
    dx.push(denom > 0 ? (100 * Math.abs(plusSum - minusSum)) / denom : 0)
  }
  if (dx.length === 0) return 0
  const tail = dx.slice(-period)
  return Math.round(tail.reduce((s, v) => s + v, 0) / tail.length)
}

/** Mean-reverting volatility series history: current volatility vs its own 20-bar baseline. */
function atrPctHistory(bars: Bar[]): { current: number; ratio: number; baseline: number } | null {
  const last = bars.length - 1
  const atrVals = atr(bars, 14)
  const close = bars[last].close
  const currentAtr = atrVals[last] ?? 0
  if (currentAtr <= 0 || !(close > 0)) return null
  const series: number[] = []
  for (let i = 20; i <= last; i++) {
    const a = atrVals[i]
    const c = bars[i].close
    if (a != null && a > 0 && c != null && c > 0) series.push((a / c) * 100)
  }
  const current = (currentAtr / close) * 100
  const recent = series.slice(-20)
  const baseline = recent.length > 0 ? median(recent) : current
  return { current, ratio: baseline > 0 ? current / baseline : 4, baseline }
}

/**
 * Classify the current market regime for one symbol. Returns null when there
 * aren't enough bars yet — callers fall back to regime-agnostic behaviour.
 */
export function detectRegime(bars: Bar[], symbol = 'EUR/USD'): MarketRegime | null {
  if (!Array.isArray(bars) || bars.length < MIN_REGIME_BARS) return null
  const closes = bars.map((b) => b.close)
  const last = bars.length - 1
  const close = closes[last]
  if (!(close > 0)) return null

  const vols = atrPctHistory(bars)
  if (!vols) return null
  const { current: atrPct, ratio: volatilityRatio } = vols

  let volatility: VolatilityRegime = 'normal'
  if (volatilityRatio >= 1.8 || atrPct >= 2.5) volatility = 'high'
  else if (volatilityRatio <= 0.7 && atrPct <= 0.9) volatility = 'low'

  const adx = computeAdx(bars)
  const sma20Vals = sma(closes, 20)
  const sma20 = sma20Vals[last]
  const trending = adx >= ADX_TREND
  const trend: TrendRegime =
    trending && sma20 != null && close > sma20
      ? 'up'
      : trending && sma20 != null && close < sma20
        ? 'down'
        : 'range'

  const spreadAside = volatilityRatio >= SPREAD_ASIDE_RATIO && atrPct >= 1
  const clearMarket = !spreadAside

  return {
    trend,
    volatility,
    adx,
    atrPct: Math.round(atrPct * 100) / 100,
    volatilityRatio: Math.round(volatilityRatio * 100) / 100,
    favorTrend: trend !== 'range' && clearMarket,
    favorReversion: trend === 'range' && clearMarket,
    spreadAside,
    suggestedStopPips: clamp(Math.round(((atr(bars, 14)[last] ?? 0) / pipSize(symbol)) * ATR_STOP_MULTIPLIER), 8, 250),
  }
}