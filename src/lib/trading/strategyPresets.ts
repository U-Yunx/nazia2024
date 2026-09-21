/**
 * One-click robot strategy presets.
 *
 * `PRO_STRATEGY` encodes the exit/entry behaviour of long-running, stable
 * professional trading robots (the "bank half, let the rest run" family):
 *   - Partial take-profit: close 50% at 1R, move the stop to break-even,
 *     let the remaining half ride to the full target with a trailing stop.
 *   - ATR-aware stop distance (volatility filter stands aside in spikes).
 *   - Trailing + break-even protection so winners can't round-trip.
 *   - Profit-pullback lock: bank gains when a winner gives back 30% from peak.
 *   - Consecutive-loss circuit breaker + adaptive de-risking so a cold streak
 *     shrinks size instead of blowing the account.
 *   - Concurrent multi-pair trading (2 per pair, up to 6 open) for more
 *     trade throughput across the watchlist.
 *
 * Applying a preset is a pure patch: the UI calls `setRisk(preset.risk)` and
 * `applyAll(preset.prefs)` and the robot picks it up on the next cycle.
 */
import type { RobotPrefs, TradingMethod } from '../types'
import type { RiskConfig } from './types'

export interface StrategyPreset {
  id: string
  name: string
  tagline: string
  /** Human-readable summary shown next to the Apply button. */
  description: string
  /** Patch applied to the paper account's RiskConfig. */
  risk: Partial<RiskConfig>
  /** Patch applied to the robot prefs (kept partial so user pairs survive). */
  prefs: Partial<RobotPrefs>
}

/** The scale-out exit values that define the Pro preset (exported for tests). */
export const PRO_PARTIAL = {
  partialTakeProfit: true,
  partialClosePct: 50,
  partialTpRatio: 1,
}

/**
 * Pro preset — tuned per trading method. Scalping uses tighter stops/trails on
 * fast 5-min bars; long-term uses wider stops/trails on 1-hour bars to ride
 * the higher-timeframe trend. Both share the same scale-out + break-even +
 * trailing + risk-guard skeleton.
 */
export function proStrategyPreset(method: TradingMethod): StrategyPreset {
  const scalping = method === 'scalping'
  return {
    id: 'pro',
    name: 'Pro Scale-Out',
    tagline: scalping ? 'Scalp 2 legs per trade' : 'Ride trends, bank early',
    description: scalping
      ? 'Banks 50% at 1R, break-even stop, then trails the rest — with ATR-aware stops, a 30% give-back lock and a loss circuit breaker. More pairs, more trades, capped risk.'
      : 'Banks 50% at 1R, break-even stop, then trails the rest on 1-hour bars — with ATR-aware stops, a 30% give-back lock and a loss circuit breaker. Built for multi-day trends.',
    risk: {
      ...PRO_PARTIAL,
      riskPerTradePct: scalping ? 0.5 : 1,
      maxOpenPositions: 8,
      defaultStopPips: scalping ? 12 : 40,
      takeProfitRatio: scalping ? 2 : 2.5,
      trailingStop: true,
      trailPips: scalping ? 8 : 25,
      breakEvenPips: scalping ? 6 : 15,
      trailActivationPips: scalping ? 8 : 20,
      profitPullbackPct: 30,
      profitPullbackActivateUsd: 1,
      drawdownClosePct: 20,
      maxDailyLossPct: 5,
      maxConsecutiveLosses: 4,
      adaptiveRisk: true,
      volatilityFilter: true,
      costPerTradeUsd: 0,
    },
    prefs: {
      strategyMode: 'auto',
      autoPickPairs: true,
      pairCount: scalping ? 5 : 3,
      tradeMode: 'concurrent',
      maxPerPair: 2,
      maxOpenTrades: 6,
      profitPullbackPct: 30,
      sizingMode: 'risk',
      riskPerTradePct: scalping ? 0.5 : 1,
    },
  }
}

/** All presets, keyed by id — used by the Apply control on the Trading page. */
export function strategyPresets(): StrategyPreset[] {
  return [proStrategyPreset('scalping'), proStrategyPreset('longterm')]
}

/** Look a preset up by id (falls back to the scalping Pro preset). */
export function presetById(id: string): StrategyPreset | undefined {
  return strategyPresets().find((p) => p.id === id)
}
