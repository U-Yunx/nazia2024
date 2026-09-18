/**
 * Strategy catalog: supported types, human labels, default parameters and the
 * interval options the robot and backtester share.
 */
import type { Interval, StrategyConfig, StrategyParams, StrategyType, TradingMethod } from '../types'

export const STRATEGY_TYPES: StrategyType[] = ['MA', 'RSI', 'MACD', 'BOLLINGER']

/**
 * Indicator presets tuned per trading method. Scalping lives on fast 5-min
 * bars, so it uses fresh, short-lookback parameters (quick crosses, tight
 * bands) to act within the day. Long-term works on slow 1-hour bars, so it
 * uses trend parameters (longer averages, wider channels) that ignore the
 * intraday noise and ride the higher-timeframe move.
 */
export const METHOD_PARAMS: Record<TradingMethod, Record<StrategyType, StrategyParams>> = {
  scalping: {
    MA: { fastPeriod: 5, slowPeriod: 15 },
    RSI: { period: 7, oversold: 30, overbought: 70 },
    MACD: { fastPeriod: 8, slowPeriod: 17, signalPeriod: 5 },
    BOLLINGER: { period: 15, stdDev: 1.8 },
  },
  longterm: {
    MA: { fastPeriod: 20, slowPeriod: 50 },
    RSI: { period: 21, oversold: 30, overbought: 70 },
    MACD: { fastPeriod: 16, slowPeriod: 26, signalPeriod: 9 },
    BOLLINGER: { period: 30, stdDev: 2.5 },
  },
}

/** Fresh, method-tuned parameters for a strategy type. */
export function strategyParamsFor(type: StrategyType, method: TradingMethod): StrategyParams {
  return { ...METHOD_PARAMS[method][type] }
}

export interface StrategyMeta {
  name: string
  shortLabel: string
  description: string
  defaultParams: StrategyParams
}

export const STRATEGY_META: Record<StrategyType, StrategyMeta> = {
  MA: {
    name: 'Moving Average Cross',
    shortLabel: 'MA Cross',
    description: 'Buy when the fast MA crosses above the slow MA, sell on the reverse cross.',
    defaultParams: { fastPeriod: 10, slowPeriod: 30 },
  },
  RSI: {
    name: 'RSI Reversal',
    shortLabel: 'RSI',
    description: 'Buy when RSI recovers from oversold, sell when it rolls over from overbought.',
    defaultParams: { period: 14, oversold: 30, overbought: 70 },
  },
  MACD: {
    name: 'MACD Momentum',
    shortLabel: 'MACD',
    description: 'Trade momentum shifts as the MACD histogram crosses its signal line.',
    defaultParams: { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 },
  },
  BOLLINGER: {
    name: 'Bollinger Mean Reversion',
    shortLabel: 'Bollinger',
    description: 'Buy when price pierces the lower band, sell when it pierces the upper band.',
    defaultParams: { period: 20, stdDev: 2 },
  },
}

export const INTERVALS: { value: Interval; label: string }[] = [
  { value: '1min', label: '1 min' },
  { value: '5min', label: '5 min' },
  { value: '15min', label: '15 min' },
  { value: '30min', label: '30 min' },
  { value: '1h', label: '1 hour' },
  { value: '4h', label: '4 hours' },
  { value: '1day', label: '1 day' },
]

export function intervalLabel(interval: Interval): string {
  return INTERVALS.find((i) => i.value === interval)?.label ?? interval
}

/** Fresh default parameters for a strategy type. */
export function defaultParams(type: StrategyType): StrategyParams {
  return { ...STRATEGY_META[type].defaultParams }
}

/** A ready-to-run default strategy config for a symbol. */
export function defaultStrategy(pair: string, interval: Interval, type: StrategyType): StrategyConfig {
  return { pair, interval, type, params: defaultParams(type) }
}