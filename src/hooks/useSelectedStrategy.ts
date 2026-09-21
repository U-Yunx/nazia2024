/**
 * The strategy a trading workspace is currently configured with (pair,
 * interval, type, params). Persisted to localStorage so the choice survives
 * reloads.
 *
 * `useSelectedStrategy` is scoped: pass a scope key ('manual', 'robot-2', …)
 * so manual trading and every robot keep their own independent strategy
 * settings. With no scope the legacy key is used, so Robot 1 (and any caller
 * that predates scoping) keeps its saved strategy.
 */
import { useCallback, useEffect, useState } from 'react'
import type { StrategyConfig } from '../lib/types'
import { defaultParams } from '../lib/strategies'

const KEY = 'ana24.selected-strategy'

/** localStorage key for a scope's selected strategy (undefined = legacy key). */
export function strategyKeyFor(scope?: string): string {
  return scope ? `${KEY}.${scope}` : KEY
}

export const DEFAULT_STRATEGY: StrategyConfig = {
  pair: 'EUR/USD',
  interval: '5min',
  type: 'RSI',
  params: defaultParams('RSI'),
}

function loadStrategy(key: string): StrategyConfig {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return DEFAULT_STRATEGY
    const p = JSON.parse(raw) as Partial<StrategyConfig>
    const type = p.type === 'MA' || p.type === 'RSI' || p.type === 'MACD' || p.type === 'BOLLINGER' ? p.type : 'RSI'
    return {
      pair: p.pair && typeof p.pair === 'string' ? p.pair : DEFAULT_STRATEGY.pair,
      interval:
        p.interval === '1min' || p.interval === '5min' || p.interval === '15min' || p.interval === '30min' || p.interval === '1h' || p.interval === '4h' || p.interval === '1day'
          ? p.interval
          : DEFAULT_STRATEGY.interval,
      type,
      params: p.params && typeof p.params === 'object' ? p.params : defaultParams(type),
    }
  } catch {
    return DEFAULT_STRATEGY
  }
}

export function useSelectedStrategy(scope?: string) {
  const key = strategyKeyFor(scope)
  const [strategy, setStrategy] = useState<StrategyConfig>(() => loadStrategy(key))

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(strategy))
    } catch {
      /* noop */
    }
  }, [strategy, key])

  const updateStrategy = useCallback((next: Partial<StrategyConfig>) => {
    setStrategy((prev) => {
      const merged = { ...prev, ...next }
      // Changing the strategy type resets params to the type's defaults.
      if (next.type && next.type !== prev.type) {
        merged.params = defaultParams(next.type)
      }
      return merged
    })
  }, [])

  return [strategy, updateStrategy] as const
}