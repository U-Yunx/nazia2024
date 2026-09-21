/**
 * Pro-trader profiles — one-click "copy a pro trader" robot configurations.
 *
 * Each profile bundles a personality (style, stats, bio) with a full robot
 * configuration (risk patch + prefs patch) so copying a trader is a pure
 * one-click apply: the Trading page calls `setRisk(trader.risk)` and
 * `applyAll(trader.prefs)` and the robot starts behaving like theirs.
 *
 * The profiles encode genuinely different, coherent strategies:
 *   - The Banker — swing scale-out, tiny risk, banks early (peak-return on).
 *   - The Scalper — fast 5-min momentum, tight stops, many small wins.
 *   - The Trend Rider — 1-hour trend following with wide stops + trailing.
 *   - The Grinder — RSI mean-reversion, high win rate, small targets.
 *
 * Copying a pro trader is a subscriber perk: it unlocks after 30 subscribed
 * days (the UI gates it) so free users get a taste and paid users get the edge.
 */
import type { RobotPrefs } from './types'
import type { RiskConfig } from './trading/types'

export interface ProTrader {
  id: string
  name: string
  handle: string
  /** Avatar initials shown in the profile circle. */
  initials: string
  /** One-word style label (Scalping / Swing / Trend / Reversion). */
  style: string
  /** Short human bio shown on the profile card. */
  bio: string
  /** 30-day win rate shown on the card (illustrative tracker). */
  winRate: number
  /** Average monthly PnL on a $1,000 starting balance (illustrative). */
  avgMonthlyPnlUsd: number
  /** Followers count shown on the card (illustrative). */
  followers: number
  /** The robot configuration applied when the user copies this trader. */
  config: {
    risk: Partial<RiskConfig>
    prefs: Partial<RobotPrefs>
  }
}

export const PRO_TRADERS: ProTrader[] = [
  {
    id: 'elena-banker',
    name: 'Elena Marchetti',
    handle: '@thebanker',
    initials: 'EM',
    style: 'Swing',
    bio: 'Ex-prop desk. Banks half at 1R, moves to break-even, and closes winners the moment they return to their peak. Slow, steady, boring — on purpose.',
    winRate: 68,
    avgMonthlyPnlUsd: 74,
    followers: 18420,
    config: {
      risk: {
        riskPerTradePct: 0.5,
        maxOpenPositions: 6,
        defaultStopPips: 35,
        takeProfitRatio: 2.5,
        trailingStop: true,
        trailPips: 25,
        breakEvenPips: 12,
        trailActivationPips: 16,
        profitPullbackPct: 25,
        profitPullbackActivateUsd: 1,
        peakReturnClose: true,
        peakReturnGivebackPct: 8,
        drawdownClosePct: 18,
        maxDailyLossPct: 3,
        maxConsecutiveLosses: 3,
        adaptiveRisk: true,
        volatilityFilter: true,
        partialTakeProfit: true,
        partialClosePct: 50,
        partialTpRatio: 1,
      },
      prefs: {
        method: 'longterm',
        strategyMode: 'auto',
        autoPickPairs: true,
        pairCount: 4,
        tradeMode: 'sequential',
        maxPerPair: 1,
        maxOpenTrades: 4,
        sizingMode: 'risk',
        riskPerTradePct: 0.5,
        perTradeTakeProfitPips: 0,
        perTradeStopLossPips: 0,
      },
    },
  },
  {
    id: 'hiro-scalper',
    name: 'Hiroshi Nakamura',
    handle: '@tokyoscalp',
    initials: 'HN',
    style: 'Scalping',
    bio: 'Tokyo morning session only. Five-minute bars, momentum entries, tight 12-pip stops and a 2R target. Many small wins, very few big losses.',
    winRate: 72,
    avgMonthlyPnlUsd: 61,
    followers: 23710,
    config: {
      risk: {
        riskPerTradePct: 0.5,
        maxOpenPositions: 8,
        defaultStopPips: 12,
        takeProfitRatio: 2,
        trailingStop: true,
        trailPips: 8,
        breakEvenPips: 5,
        trailActivationPips: 6,
        profitPullbackPct: 30,
        profitPullbackActivateUsd: 1,
        peakReturnClose: false,
        drawdownClosePct: 15,
        maxDailyLossPct: 4,
        maxConsecutiveLosses: 5,
        adaptiveRisk: true,
        volatilityFilter: true,
      },
      prefs: {
        method: 'scalping',
        strategyMode: 'auto',
        autoPickPairs: true,
        pairCount: 6,
        tradeMode: 'concurrent',
        maxPerPair: 2,
        maxOpenTrades: 6,
        sizingMode: 'risk',
        riskPerTradePct: 0.5,
        perTradeTakeProfitPips: 0,
        perTradeStopLossPips: 12,
      },
    },
  },
  {
    id: 'sarah-trend',
    name: 'Sarah Vance',
    handle: '@trendrider',
    initials: 'SV',
    style: 'Trend',
    bio: 'One-hour MACD + moving-average trend following. Wide stops, wide targets, and a trailing stop that never lets a runner round-trip. Rides trends for days.',
    winRate: 55,
    avgMonthlyPnlUsd: 92,
    followers: 15230,
    config: {
      risk: {
        riskPerTradePct: 1,
        maxOpenPositions: 5,
        defaultStopPips: 45,
        takeProfitRatio: 3,
        trailingStop: true,
        trailPips: 30,
        breakEvenPips: 20,
        trailActivationPips: 25,
        profitPullbackPct: 35,
        profitPullbackActivateUsd: 2,
        peakReturnClose: true,
        peakReturnGivebackPct: 15,
        drawdownClosePct: 25,
        maxDailyLossPct: 5,
        maxConsecutiveLosses: 3,
        adaptiveRisk: true,
        volatilityFilter: true,
      },
      prefs: {
        method: 'longterm',
        strategyMode: 'manual',
        manualStrategy: 'MACD',
        autoPickPairs: true,
        pairCount: 3,
        tradeMode: 'sequential',
        maxPerPair: 1,
        maxOpenTrades: 3,
        sizingMode: 'risk',
        riskPerTradePct: 1,
        perTradeTakeProfitPips: 0,
        perTradeStopLossPips: 0,
      },
    },
  },
  {
    id: 'marco-grinder',
    name: 'Marco Reyes',
    handle: '@thegrinder',
    initials: 'MR',
    style: 'Reversion',
    bio: 'RSI mean-reversion on oversold bounces. High win rate, small targets, and a hard rule: never risk more than 0.75% per trade. Grinds up, week after week.',
    winRate: 78,
    avgMonthlyPnlUsd: 48,
    followers: 9810,
    config: {
      risk: {
        riskPerTradePct: 0.75,
        maxOpenPositions: 6,
        defaultStopPips: 18,
        takeProfitRatio: 1.5,
        trailingStop: false,
        trailPips: 0,
        breakEvenPips: 8,
        trailActivationPips: 12,
        profitPullbackPct: 20,
        profitPullbackActivateUsd: 1,
        peakReturnClose: false,
        drawdownClosePct: 12,
        maxDailyLossPct: 3,
        maxConsecutiveLosses: 6,
        adaptiveRisk: true,
        volatilityFilter: true,
        targetPerTradeUsd: 0,
        maxLossPerTradeUsd: 0,
      },
      prefs: {
        method: 'scalping',
        strategyMode: 'manual',
        manualStrategy: 'RSI',
        autoPickPairs: true,
        pairCount: 5,
        tradeMode: 'sequential',
        maxPerPair: 1,
        maxOpenTrades: 5,
        sizingMode: 'risk',
        riskPerTradePct: 0.75,
        perTradeTakeProfitPips: 15,
        perTradeStopLossPips: 18,
      },
    },
  },
]

/** Look a pro trader up by id. */
export function proTraderById(id: string): ProTrader | undefined {
  return PRO_TRADERS.find((t) => t.id === id)
}