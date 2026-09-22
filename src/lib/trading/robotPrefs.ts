/**
 * Robot trading-style preferences (scalping vs long-term) plus the mapping
 * from a style to sensible interval + risk defaults. Persisted to localStorage.
 *
 * Position sizing has two modes:
 *  - 'risk' (default) — every trade is sized from `riskPerTradePct` % of
 *    current equity and the trade's own stop distance; no lot pick is needed
 *    to start the robot.
 *  - 'fixed' — the robot opens every trade at the picked `lot` (0.01-step
 *    micro lots of the account's contract size); `lot` = 0 keeps Start locked.
 * Older settings written before this feature (integer `lot`, no `sizingMode`)
 * migrate to 'fixed' when a lot was picked and to 'risk' otherwise, so nothing
 * already configured changes behaviour.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Interval, RobotPrefs, StrategyMode, StrategyType, TradingMethod } from '../types'
import { MIN_LOT, normalizeLots } from './lots'
import type { RiskConfig } from './types'

const KEY = 'ana24.robot-prefs'
/** Hard ceiling for the "max pairs per trade" pref — a sane multiple of any
 *  watchlist size, so a stale/typo'd value can never freeze the robot. */
const MAX_PAIRS_CAP = 50
/** Namespaced key for a scope: slot 0 is the MANUAL trading workspace (its own
 *  method/strategy settings, separate from every robot); slot 1 keeps the
 *  legacy key so existing users keep their saved configuration; slots 2..N get
 *  their own key so each robot can trade with its own method, pairs, sizing
 *  and limits. */
export function prefsKeyForSlot(slot: number): string {
  if (slot === 0) return `${KEY}.manual`
  return slot > 1 ? `${KEY}.slot-${slot}` : KEY
}
export const MIN_RISK_PCT = 0.05
export const MAX_RISK_PCT = 10
/** Concrete fallback so optional RobotPrefs fields never leak `undefined`. */
const DEFAULT_RISK_PCT = 1

const DEFAULTS: RobotPrefs = {
  method: 'scalping',
  strategyMode: 'auto',
  manualStrategy: 'MA',
  durationMinutes: null,
  pairs: [],
  autoPickPairs: false,
  pairCount: 5,
  perTradeTakeProfitPips: 0,
  perTradeStopLossPips: 0,
  overallMaxProfitUsd: 0,
  overallMaxLossUsd: 0,
  tradeMode: 'sequential',
  maxPerPair: 1,
  maxOpenTrades: 0,
  // 0 = trade every eligible pair (up to the tier's pair cap).
  maxPairsPerTrade: 0,
  profitPullbackPct: 25,
  // Risk-based sizing by default — no lot pick required to start.
  sizingMode: 'risk',
  riskPerTradePct: 1,
  // 0 = no fixed lot picked yet (fixed mode refuses to start until ≥ 0.01).
  lot: 0,
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

/** Clamp the per-trade risk % to the sane 0.05–10 band. */
export function clampRiskPct(pct: number): number {
  if (!Number.isFinite(pct)) return DEFAULT_RISK_PCT
  return Math.min(MAX_RISK_PCT, Math.max(MIN_RISK_PCT, pct))
}

const STRATEGY_TYPES_SET: ReadonlySet<string> = new Set(['MA', 'RSI', 'MACD', 'BOLLINGER'])

/** True when the value is one of the switched strategy types. */
export function isStrategyType(v: unknown): v is StrategyType {
  return typeof v === 'string' && STRATEGY_TYPES_SET.has(v)
}

export function loadRobotPrefs(slot = 1): RobotPrefs {
  try {
    const raw = localStorage.getItem(prefsKeyForSlot(slot))
    if (!raw) return DEFAULTS
    const p = JSON.parse(raw) as Partial<RobotPrefs>
    // Legacy save: a previously picked integer lot keeps meaning "fixed lot";
    // never-picked (0) and brand-new prefs fall back to the risk default.
    const legacyLotPicked = typeof p.lot === 'number' && p.lot >= 1
    return {
      method: p.method === 'longterm' ? 'longterm' : 'scalping',
      strategyMode: p.strategyMode === 'manual' ? 'manual' : 'auto',
      manualStrategy: isStrategyType(p.manualStrategy) ? p.manualStrategy : 'MA',
      durationMinutes: typeof p.durationMinutes === 'number' ? p.durationMinutes : null,
      pairs: Array.isArray(p.pairs) ? p.pairs : [],
      autoPickPairs: p.autoPickPairs === true,
      pairCount: Math.min(10, Math.max(1, num(p.pairCount, DEFAULTS.pairCount))),
      perTradeTakeProfitPips: Math.max(0, num(p.perTradeTakeProfitPips, 0)),
      perTradeStopLossPips: Math.max(0, num(p.perTradeStopLossPips, 0)),
      overallMaxProfitUsd: Math.max(0, num(p.overallMaxProfitUsd, 0)),
      overallMaxLossUsd: Math.max(0, num(p.overallMaxLossUsd, 0)),
      tradeMode: p.tradeMode === 'concurrent' ? 'concurrent' : 'sequential',
      maxPerPair: Math.max(1, Math.round(num(p.maxPerPair, DEFAULTS.maxPerPair))),
      // 0 = unlimited (no global cap); any positive number is a hard cap.
      maxOpenTrades: Math.max(0, Math.round(num(p.maxOpenTrades, DEFAULTS.maxOpenTrades))),
      // 0 = no cap; positive = at most N distinct pairs per cycle (clamped to
      // the watchlist size so a stale pref can never freeze the robot).
      maxPairsPerTrade: Math.min(
        MAX_PAIRS_CAP,
        Math.max(0, Math.round(num(p.maxPairsPerTrade, DEFAULTS.maxPairsPerTrade))),
      ),
      // Profit-pullback lock % — clamp to a sane 0–90 so a typo can't trap a
      // winner into closing almost immediately.
      profitPullbackPct: Math.min(90, Math.max(0, num(p.profitPullbackPct, DEFAULTS.profitPullbackPct))),
      sizingMode: p.sizingMode === 'fixed' ? 'fixed' : legacyLotPicked ? 'fixed' : 'risk',
      riskPerTradePct: clampRiskPct(num(p.riskPerTradePct, DEFAULT_RISK_PCT)),
      // Fixed lot: fractional, snapped to the 0.01 step (0 = none picked yet).
      lot: normalizeLots(num(p.lot, DEFAULTS.lot)),
    }
  } catch {
    return DEFAULTS
  }
}

export function useRobotPrefs(slot = 1) {
  const [prefs, setPrefs] = useState<RobotPrefs>(() => loadRobotPrefs(slot))
  // Re-load the slot's saved config if the active robot slot changes (e.g. the
  // user navigates between /trading?robot=1 and ?robot=2 without a remount).
  const mountedSlot = useRef(slot)
  useEffect(() => {
    if (mountedSlot.current !== slot) {
      mountedSlot.current = slot
      setPrefs(loadRobotPrefs(slot))
    }
  }, [slot])
  const update = useCallback((patch: Partial<RobotPrefs>) => {
    setPrefs((prev) => {
      const next = { ...prev, ...patch }
      try {
        localStorage.setItem(prefsKeyForSlot(slot), JSON.stringify(next))
      } catch {
        /* noop */
      }
      return next
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slot])
  return {
    prefs,
    /** Replace every field at once (used by the one-click settings presets). */
    applyAll: (all: RobotPrefs) => update(all),
    setMethod: (m: TradingMethod) => update({ method: m }),
    setStrategyMode: (strategyMode: StrategyMode) => update({ strategyMode }),
    setManualStrategy: (manualStrategy: StrategyType) => update({ manualStrategy }),
    setDuration: (minutes: number | null) => update({ durationMinutes: minutes }),
    setPairs: (pairs: string[]) => update({ pairs }),
    togglePair: (symbol: string) => update({ pairs: toggleInList(prefs.pairs, symbol) }),
    setAutoPickPairs: (autoPickPairs: boolean) => update({ autoPickPairs }),
    setPairCount: (pairCount: number) => update({ pairCount }),
    setPerTradeTakeProfitPips: (perTradeTakeProfitPips: number) => update({ perTradeTakeProfitPips }),
    setPerTradeStopLossPips: (perTradeStopLossPips: number) => update({ perTradeStopLossPips }),
    setOverallMaxProfitUsd: (overallMaxProfitUsd: number) => update({ overallMaxProfitUsd }),
    setOverallMaxLossUsd: (overallMaxLossUsd: number) => update({ overallMaxLossUsd }),
    setTradeMode: (tradeMode: 'sequential' | 'concurrent') => update({ tradeMode }),
    setMaxPerPair: (maxPerPair: number) => update({ maxPerPair }),
    setMaxOpenTrades: (maxOpenTrades: number) => update({ maxOpenTrades }),
    setMaxPairsPerTrade: (maxPairsPerTrade: number) => update({ maxPairsPerTrade }),
    setProfitPullbackPct: (profitPullbackPct: number) => update({ profitPullbackPct }),
    setSizingMode: (sizingMode: 'risk' | 'fixed') => update({ sizingMode }),
    setRiskPerTradePct: (riskPerTradePct: number) => update({ riskPerTradePct: clampRiskPct(riskPerTradePct) }),
    // Fixed lot: snap to the 0.01 step (0 clears it / refuses to start).
    setLot: (lot: number) => update({ lot: normalizeLots(lot) }),
    // Keep the minimum visible for UI steppers.
    minLot: MIN_LOT,
  }
}

/** Add or remove a symbol from a list (used by the multi-pair robot selector). */
function toggleInList(list: string[], symbol: string): string[] {
  return list.includes(symbol) ? list.filter((s) => s !== symbol) : [...list, symbol]
}

/** The interval that suits a trading style. */
export function methodInterval(method: TradingMethod): Interval {
  return method === 'longterm' ? '1h' : '5min'
}

/** Risk + stop defaults that suit a trading style. */
export function methodRiskDefaults(method: TradingMethod): Pick<
  RiskConfig,
  'defaultStopPips' | 'takeProfitRatio' | 'riskPerTradePct'
> {
  return method === 'longterm'
    ? { defaultStopPips: 40, takeProfitRatio: 2.5, riskPerTradePct: 1 }
    : { defaultStopPips: 12, takeProfitRatio: 1.8, riskPerTradePct: 0.5 }
}

export function methodLabel(method: TradingMethod): string {
  return method === 'longterm' ? 'Long-term' : 'Scalping'
}