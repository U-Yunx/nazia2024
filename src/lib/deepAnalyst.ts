/**
 * Deep Analyst — client-side context builder.
 *
 * The Deep Analyst Edge Function (`deep-analyst`) decides how to manage an
 * OPEN position (hold / bank / partial / trail / cut) using an LLM, with a
 * built-in deterministic engine as fallback. The LLM key lives server-side —
 * the browser never sees it. All this file does is turn a live `Position`
 * plus the current quote and (optionally) recent price history into a compact,
 * numeric fact sheet the function reasons over. Pure and unit-tested.
 */
import type { AccountState, Position, RatesMap, Side } from './trading/types'
import { pnlUsd, pipSize } from './trading/risk'
import type { Bar } from './types'
import { isPairOpen } from './marketHours'

export type AnalystVerdict =
  | 'hold'
  | 'take_profit'
  | 'partial_take_profit'
  | 'trail'
  | 'cut_loss'
  | 'reduce_risk'
  | 'stand_pat'
  /**
   * Entry-gate verdicts: returned only when the Deep Analyst is asked to vet a
   * NEW trade before the robot opens it (the `entry` mode of the Edge
   * Function). 'enter' = the AI approves opening the trade now; 'skip' = stand
   * the trade aside (the robot's strict AI veto).
   */
  | 'enter'
  | 'skip'

export interface AnalystLevel {
  label: string
  price: number | null
  note: string
}

export interface AnalystStrategy {
  verdict: AnalystVerdict
  action: string
  confidence: number
  targets: AnalystLevel[]
  stop: { price: number | null; note: string }
  reasoning: string[]
  risks: string[]
  timeframe: string
}

export interface DeepAnalystResponse {
  ok: boolean
  engine: 'gemini' | 'openai' | 'deterministic'
  model?: string
  ai_available?: boolean
  ai_requires_login?: boolean
  degraded?: boolean
  note?: string
  strategy: AnalystStrategy
}

/** Compact market facts sent to the Edge Function. */
export interface DeepAnalystContext {
  position: {
    id?: string
    symbol: string
    side: Side
    units: number
    entryPrice: number
    entryTime: string
    stopPrice: number
    takeProfitPrice: number
    targetProfitUsd?: number
    targetLossUsd?: number
    peakProfitUsd?: number
    partialTaken?: boolean
    strategy?: string
    entryProbability?: number
  }
  market: {
    mark: number
    pnlUsd: number
    pnlPct: number
    stopDistancePct: number
    targetDistancePct: number
    remainingRiskPips: number | null
    remainingRewardPips: number | null
    riskRewardRemaining: number | null
    timeOpenH: number
    pullbackFromPeakPct: number | null
    atrPct: number | null
    trendPct: number | null
    swingHigh: number | null
    swingLow: number | null
    marketOpen: boolean
    /** Recent closes (oldest → newest), for the LLM's own read of the tape. */
    series: { t: string; c: number }[]
  }
  account: {
    mode: AccountState['broker']
    balance: number
    equity: number
    riskPerTradePct: number
    trailingStop: boolean
    trailPips: number
    breakEvenPips: number
    profitPullbackPct: number
    partialTakeProfit: boolean
    partialClosePct: number
    partialTpRatio: number
  }
  strategyLabel?: string
}

/**
 * Fact sheet for the ENTRY-GATE mode of the Deep Analyst Edge Function: the
 * robot is about to open a NEW trade and needs a disciplined enter / skip
 * verdict. `entry` carries the planned trade plus the signal-strength
 * ingredients the robot already computed (score, momentum, RSI, trend,
 * volatility) so the AI — and the deterministic fallback — judge the same
 * setup the engine is about to act on.
 */
export interface DeepAnalystEntryContext {
  entry: {
    symbol: string
    side: Side
    price: number
    stopPips: number
    takeProfitPips: number
    units: number
    strategy?: string
    score?: number
    momentum?: number
    rsi?: number
    trend?: number
    volatilityPct?: number
  }
  market: {
    mark: number
    atrPct?: number | null
    trendPct?: number | null
    marketOpen?: boolean
  }
  account: DeepAnalystContext['account']
  strategyLabel?: string
}

const pct = (n: number): number => Math.round(n * 100) / 100
const round = (n: number, d = 2): number => Number(n.toFixed(d))

/** Simple ATR-style volatility: mean of (high−low)/close over the history. */
function atrPctOf(bars: Bar[]): number | null {
  const spreads: number[] = []
  for (const b of bars) {
    if (b.high > 0 && b.low > 0 && b.close > 0) {
      const spread = ((b.high - b.low) / b.close) * 100
      if (Number.isFinite(spread)) spreads.push(spread)
    }
  }
  if (spreads.length === 0) return null
  return pct(spreads.reduce((s, x) => s + x, 0) / spreads.length)
}

/** Price vs its N-bar simple average, as a %. */
function trendPctOf(bars: Bar[], n = 20): number | null {
  if (bars.length < n) return null
  const tail = bars.slice(-n)
  const last = tail[tail.length - 1]?.close
  const sma = tail.reduce((s, b) => s + b.close, 0) / n
  if (!last || sma <= 0) return null
  return pct(((last - sma) / sma) * 100)
}

/** Max high / min low over the recent window. */
function swingLevels(bars: Bar[], n = 40): { high: number | null; low: number | null } {
  const tail = bars.slice(-n)
  if (tail.length === 0) return { high: null, low: null }
  return {
    high: Math.max(...tail.map((b) => b.high)),
    low: Math.min(...tail.map((b) => b.low)),
  }
}

/**
 * Builds the fact sheet for the `deep-analyst` Edge Function from a live
 * position, its current mark, the account and (optionally) recent bars.
 * Pure — safe to unit test and safe to call on every render pass.
 */
export function buildDeepAnalystContext(
  position: Position,
  mark: number,
  account: AccountState,
  rates: RatesMap = {},
  history?: Bar[],
  strategyLabel?: string,
): DeepAnalystContext {
  const pnlWithRates = pnlUsd(position.side, position.entryPrice, mark, position.units, position.symbol, rates)
  const equity = account.balance + Math.max(pnlWithRates, 0)
  const pnlPct = position.entryEquity > 0 ? (pnlWithRates / position.entryEquity) * 100 : 0
  const pip = pipSize(position.symbol)

  // Distances from the CURRENT mark to stop/target, in the direction of the trade.
  const riskDir = position.side === 'long' ? 1 : -1
  const rawRisk = riskDir > 0 ? mark - position.stopPrice : position.stopPrice - mark
  const rawReward = riskDir > 0 ? position.takeProfitPrice - mark : mark - position.takeProfitPrice
  const remainingRiskPips = rawRisk > 0 ? rawRisk / pip : null
  const remainingRewardPips = rawReward > 0 ? rawReward / pip : null
  const riskRewardRemaining =
    remainingRiskPips != null && remainingRewardPips != null && remainingRiskPips > 0
      ? round(remainingRewardPips / remainingRiskPips)
      : null

  const timeOpenH =
    position.entryTime && Number.isFinite(Date.parse(position.entryTime))
      ? (Date.now() - Date.parse(position.entryTime)) / 3_600_000
      : 0

  const peak = position.peakProfitUsd ?? 0
  const pullbackFromPeakPct =
    peak > 0 && pnlWithRates >= 0 && pnlWithRates < peak ? pct(((peak - pnlWithRates) / peak) * 100) : null

  const bars = history ?? []
  const series = bars
    .slice(-40)
    .map((b) => ({ t: b.time, c: round(b.close) }))
    .filter((s) => Number.isFinite(s.c))

  const atrPct = atrPctOf(bars)
  const trendPct = trendPctOf(bars)
  const swings = swingLevels(bars)

  return {
    position: {
      id: position.id,
      symbol: position.symbol,
      side: position.side,
      units: position.units,
      entryPrice: position.entryPrice,
      entryTime: position.entryTime,
      stopPrice: position.stopPrice,
      takeProfitPrice: position.takeProfitPrice,
      targetProfitUsd: position.targetProfitUsd,
      targetLossUsd: position.targetLossUsd,
      peakProfitUsd: position.peakProfitUsd,
      partialTaken: position.partialTaken,
      strategy: position.strategy,
      entryProbability: position.entryProbability,
    },
    market: {
      mark,
      pnlUsd: round(pnlWithRates),
      pnlPct: pct(pnlPct),
      stopDistancePct: pct(
        position.entryPrice > 0 ? (Math.abs(position.stopPrice - position.entryPrice) / position.entryPrice) * 100 : 0,
      ),
      targetDistancePct: pct(
        position.entryPrice > 0
          ? (Math.abs(position.takeProfitPrice - position.entryPrice) / position.entryPrice) * 100
          : 0,
      ),
      remainingRiskPips: remainingRiskPips != null ? round(remainingRiskPips) : null,
      remainingRewardPips: remainingRewardPips != null ? round(remainingRewardPips) : null,
      riskRewardRemaining,
      timeOpenH: round(timeOpenH),
      pullbackFromPeakPct: pullbackFromPeakPct != null ? round(pullbackFromPeakPct) : null,
      atrPct,
      trendPct,
      swingHigh: swings.high != null ? round(swings.high, 5) : null,
      swingLow: swings.low != null ? round(swings.low, 5) : null,
      marketOpen: isPairOpen(position.symbol),
      series,
    },
    account: {
      mode: account.broker,
      balance: round(account.balance),
      equity: round(equity),
      riskPerTradePct: account.risk.riskPerTradePct,
      trailingStop: account.risk.trailingStop,
      trailPips: account.risk.trailPips,
      breakEvenPips: account.risk.breakEvenPips,
      profitPullbackPct: account.risk.profitPullbackPct,
      partialTakeProfit: account.risk.partialTakeProfit,
      partialClosePct: account.risk.partialClosePct,
      partialTpRatio: account.risk.partialTpRatio,
    },
    strategyLabel,
  }
}

// Re-exported for consumers that want the type without importing it separately.
export type { Side }
