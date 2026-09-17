/**
 * Engine unit tests: account lifecycle, position sizing / stops, SL-TP
 * enforcement, signal application and the multi-pair robot cycle.
 */
import { describe, expect, it } from 'vitest'
import {
  applySignal,
  canOpen,
  closeAllPositions,
  closePosition,
  createAccount,
  entryProfitProbability,
  equity,
  estimateProfitProbability,
  markToMarket,
  openPosition,
  probabilityGate,
  runRobotCycle,
  todayPnlUsd,
  unrealizedPnl,
} from './engine'
import type { RatesMap } from './types'

// EUR/USD quotes in USD → usdPerUnit = 1; pipSize = 0.0001.
const rates: RatesMap = { 'EUR/USD': 1.1, 'GBP/USD': 1.27 }

describe('createAccount', () => {
  it('starts with the given balance and no positions', () => {
    const acc = createAccount(10_000)
    expect(acc.balance).toBe(10_000)
    expect(acc.positions).toHaveLength(0)
    expect(acc.trades).toHaveLength(0)
    expect(acc.risk.maxOpenPositions).toBeGreaterThan(0)
  })
})

describe('equity', () => {
  it('equals balance when nothing is open', () => {
    const acc = createAccount(10_000)
    expect(equity(acc, rates)).toBe(10_000)
  })

  it('adds unrealized PnL on open positions', () => {
    const acc = createAccount(10_000)
    const { state } = openPosition(acc, {
      symbol: 'EUR/USD',
      side: 'long',
      entryPrice: 1.1,
      stopPips: 20,
      takeProfitPips: 40,
      units: 1000,
      strategy: 'manual',
    }, rates)
    // Price at 1.105 → +0.005 * 1000 units * 1 usd/unit = +5
    const eq = equity(state, { ...rates, 'EUR/USD': 1.105 })
    expect(eq).toBeCloseTo(10_005, 6)
    expect(unrealizedPnl(state, { ...rates, 'EUR/USD': 1.105 })).toBeCloseTo(5, 6)
  })
})

describe('openPosition', () => {
  it('opens a long with pip-based stop and target', () => {
    const acc = createAccount(10_000)
    const { state, error } = openPosition(acc, {
      symbol: 'EUR/USD',
      side: 'long',
      entryPrice: 1.1,
      stopPips: 20,
      takeProfitPips: 40,
      units: 1000,
      strategy: 'manual',
    }, rates)
    expect(error).toBeNull()
    expect(state.positions).toHaveLength(1)
    const p = state.positions[0]
    expect(p.side).toBe('long')
    expect(p.stopPrice).toBeCloseTo(1.098, 6)
    expect(p.takeProfitPrice).toBeCloseTo(1.104, 6)
  })

  it('rejects positions without a stop loss', () => {
    const acc = createAccount(10_000)
    const { error } = openPosition(acc, {
      symbol: 'EUR/USD',
      side: 'long',
      entryPrice: 1.1,
      stopPips: 0,
      takeProfitPips: 40,
      units: 1000,
    }, rates)
    expect(error).toMatch(/stop loss/i)
  })

  it('enforces a one-position-per-pair cap by default', () => {
    const acc = createAccount(10_000)
    const first = openPosition(acc, {
      symbol: 'EUR/USD', side: 'long', entryPrice: 1.1, stopPips: 20, takeProfitPips: 40, units: 1000,
    }, rates)
    expect(first.error).toBeNull()
    const second = openPosition(first.state, {
      symbol: 'EUR/USD', side: 'short', entryPrice: 1.1, stopPips: 20, takeProfitPips: 40, units: 1000,
    }, rates)
    expect(second.error).toMatch(/already open/i)
  })
})

describe('closePosition', () => {
  it('realizes PnL into the balance and journals the trade', () => {
    const acc = createAccount(10_000)
    const { state: opened } = openPosition(acc, {
      symbol: 'EUR/USD', side: 'long', entryPrice: 1.1, stopPips: 20, takeProfitPips: 40, units: 1000,
    }, rates)
    const pos = opened.positions[0]
    const { state, trade } = closePosition(opened, pos.id, {
      price: 1.104,
      reason: 'take_profit',
      rates,
    })
    expect(trade).not.toBeNull()
    expect(trade?.pnl).toBeCloseTo(4, 6)
    expect(state.balance).toBeCloseTo(10_004, 6)
    expect(state.positions).toHaveLength(0)
    expect(state.trades).toHaveLength(1)
  })
})

describe('markToMarket', () => {
  it('closes a long when the stop is hit', () => {
    const acc = createAccount(10_000)
    const { state: opened } = openPosition(acc, {
      symbol: 'EUR/USD', side: 'long', entryPrice: 1.1, stopPips: 20, takeProfitPips: 40, units: 1000,
    }, rates)
    const { closed } = markToMarket(opened, { ...rates, 'EUR/USD': 1.097 })
    expect(closed).toHaveLength(1)
    expect(closed[0].closeReason).toBe('stop_loss')
  })

  it('closes a short when the target is hit', () => {
    const acc = createAccount(10_000)
    const { state: opened } = openPosition(acc, {
      symbol: 'EUR/USD', side: 'short', entryPrice: 1.1, stopPips: 20, takeProfitPips: 40, units: 1000,
    }, rates)
    const { closed } = markToMarket(opened, { ...rates, 'EUR/USD': 1.096 })
    expect(closed).toHaveLength(1)
    expect(closed[0].closeReason).toBe('take_profit')
  })

  it('does not close a trade below the per-trade money target', () => {
    const acc = createAccount(10_000)
    acc.risk.targetPerTradeUsd = 100
    const { state: opened } = openPosition(acc, {
      symbol: 'EUR/USD', side: 'long', entryPrice: 1.1, stopPips: 20, takeProfitPips: 40, units: 1000,
    }, rates)
    const { closed } = markToMarket(opened, { ...rates, 'EUR/USD': 1.102 })
    expect(closed).toHaveLength(0)
  })

  it('closes a long when the per-trade money target is reached', () => {
    const acc = createAccount(10_000)
    acc.risk.targetPerTradeUsd = 2
    const { state: opened } = openPosition(acc, {
      symbol: 'EUR/USD', side: 'long', entryPrice: 1.1, stopPips: 20, takeProfitPips: 40, units: 1000,
    }, rates)
    const { closed } = markToMarket(opened, { ...rates, 'EUR/USD': 1.102 })
    expect(closed).toHaveLength(1)
    expect(closed[0].closeReason).toBe('target')
    expect(closed[0].pnl).toBeCloseTo(2, 5)
  })

  it('closes a short when the per-trade money target is reached', () => {
    const acc = createAccount(10_000)
    acc.risk.targetPerTradeUsd = 2
    const { state: opened } = openPosition(acc, {
      symbol: 'EUR/USD', side: 'short', entryPrice: 1.1, stopPips: 20, takeProfitPips: 40, units: 5000,
    }, rates)
    const { closed } = markToMarket(opened, { ...rates, 'EUR/USD': 1.098 })
    expect(closed).toHaveLength(1)
    expect(closed[0].closeReason).toBe('target')
  })

  it('fires the money target before the price take-profit is reached', () => {
    // Price TP is at 1.104 (40 pips); a $20 target is reached earlier at 1.102.
    const acc = createAccount(10_000)
    acc.risk.targetPerTradeUsd = 20
    const { state: opened } = openPosition(acc, {
      symbol: 'EUR/USD', side: 'long', entryPrice: 1.1, stopPips: 20, takeProfitPips: 40, units: 10_000,
    }, rates)
    const { closed } = markToMarket(opened, { ...rates, 'EUR/USD': 1.102 })
    expect(closed).toHaveLength(1)
    expect(closed[0].closeReason).toBe('target')
  })

  it('closes a trade at the robot per-trade $ loss cap', () => {
    const acc = createAccount(10_000)
    acc.risk.maxLossPerTradeUsd = 5
    const { state: opened } = openPosition(acc, {
      symbol: 'EUR/USD', side: 'long', entryPrice: 1.1, stopPips: 500, takeProfitPips: 40, units: 1000,
    }, rates)
    // pnl = -$5 at 1.095; the pip stop (1.05) is far below and never hit.
    const { closed } = markToMarket(opened, { ...rates, 'EUR/USD': 1.095 })
    expect(closed).toHaveLength(1)
    expect(closed[0].closeReason).toBe('stop_loss')
    expect(closed[0].pnl).toBeCloseTo(-5, 5)
  })

  it('closes a long at the pip profit target when profitUnit is pips', () => {
    // 10 pips on 1000 units of EUR/USD = 10 × 0.0001 × 1000 × 1 = $1.
    const acc = createAccount(10_000)
    acc.risk.profitUnit = 'pips'
    acc.risk.targetPerTradePips = 10
    const { state: opened } = openPosition(acc, {
      symbol: 'EUR/USD', side: 'long', entryPrice: 1.1, stopPips: 500, takeProfitPips: 40, units: 1000,
    }, rates)
    // pnl = $2 at 1.102 — the 10-pip target ($1) is reached first.
    const { closed } = markToMarket(opened, { ...rates, 'EUR/USD': 1.102 })
    expect(closed).toHaveLength(1)
    expect(closed[0].closeReason).toBe('target')
    expect(closed[0].pnl).toBeCloseTo(2, 5)
  })

  it('scales the pip target with position size', () => {
    // Same 10-pip target on 5000 units = 10 × 0.0001 × 5000 × 1 = $5 — so a
    // small favourable move (+$1.5 at 1.1003) does not close, but +$10 at
    // 1.102 ($5 target) does. The price take-profit sits at 1.104, so the
    // $ target fires first.
    const acc = createAccount(10_000)
    acc.risk.profitUnit = 'pips'
    acc.risk.targetPerTradePips = 10
    const { state: opened } = openPosition(acc, {
      symbol: 'EUR/USD', side: 'long', entryPrice: 1.1, stopPips: 500, takeProfitPips: 40, units: 5000,
    }, rates)
    const { closed } = markToMarket(opened, { ...rates, 'EUR/USD': 1.1003 })
    expect(closed).toHaveLength(0)
    const { closed: hit } = markToMarket(opened, { ...rates, 'EUR/USD': 1.102 })
    expect(hit).toHaveLength(1)
    expect(hit[0].closeReason).toBe('target')
    expect(hit[0].pnl).toBeCloseTo(10, 5)
  })

  it('closes a short at the pip loss cap when profitUnit is pips', () => {
    // 20 pips loss on 500 units = 20 × 0.0001 × 500 × 1 = $1 cap.
    const acc = createAccount(10_000)
    acc.risk.profitUnit = 'pips'
    acc.risk.maxLossPerTradePips = 20
    const { state: opened } = openPosition(acc, {
      symbol: 'EUR/USD', side: 'short', entryPrice: 1.1, stopPips: 500, takeProfitPips: 40, units: 500,
    }, rates)
    // pnl = -$1.25 at 1.1025 — the $1 pip loss cap is breached first.
    const { closed } = markToMarket(opened, { ...rates, 'EUR/USD': 1.1025 })
    expect(closed).toHaveLength(1)
    expect(closed[0].closeReason).toBe('stop_loss')
    expect(closed[0].pnl).toBeCloseTo(-1.25, 5)
  })

  it('honours a per-order $ profit target (robot risk stays off)', () => {
    const acc = createAccount(10_000)
    const { state: opened } = openPosition(acc, {
      symbol: 'EUR/USD', side: 'long', entryPrice: 1.1, stopPips: 20, takeProfitPips: 40, units: 1000,
      targetProfitUsd: 4,
    }, rates)
    // pnl = $4 at 1.104 — exactly the pip TP price; the $ rule fires first.
    const { closed } = markToMarket(opened, { ...rates, 'EUR/USD': 1.104 })
    expect(closed).toHaveLength(1)
    expect(closed[0].closeReason).toBe('target')
    expect(closed[0].pnl).toBeCloseTo(4, 5)
  })

  it('honours a per-order $ loss cap on a short', () => {
    const acc = createAccount(10_000)
    const { state: opened } = openPosition(acc, {
      symbol: 'EUR/USD', side: 'short', entryPrice: 1.1, stopPips: 500, takeProfitPips: 40, units: 1000,
      targetLossUsd: 2,
    }, rates)
    // pnl = -$5 at 1.105 (loss cap 2 exceeded); stop at 1.15 never hit.
    const { closed } = markToMarket(opened, { ...rates, 'EUR/USD': 1.105 })
    expect(closed).toHaveLength(1)
    expect(closed[0].closeReason).toBe('stop_loss')
    expect(closed[0].pnl).toBeCloseTo(-5, 5)
  })
})

describe('applySignal', () => {
  it('opens a long on a buy signal and flips on a sell', () => {
    let acc = createAccount(10_000)
    const buy = applySignal(acc, {
      symbol: 'EUR/USD', signal: 'buy', price: 1.1, rates,
      strategy: 'RSI', stopPips: 20, takeProfitPips: 40, units: 1000,
    })
    expect(buy.state.positions).toHaveLength(1)
    expect(buy.state.positions[0].side).toBe('long')

    const flip = applySignal(buy.state, {
      symbol: 'EUR/USD', signal: 'sell', price: 1.1, rates,
      strategy: 'RSI', stopPips: 20, takeProfitPips: 40, units: 1000,
    })
    expect(flip.state.positions).toHaveLength(1)
    expect(flip.state.positions[0].side).toBe('short')
  })

  it('ignores neutral signals', () => {
    const acc = createAccount(10_000)
    const res = applySignal(acc, {
      symbol: 'EUR/USD', signal: 'neutral', price: 1.1, rates,
      strategy: 'RSI', stopPips: 20, takeProfitPips: 40, units: 1000,
    })
    expect(res.state.positions).toHaveLength(0)
    expect(res.events).toHaveLength(0)
  })
})

describe('canOpen / daily loss limit', () => {
  it('blocks new entries once the daily loss limit is reached', () => {
    const acc = createAccount(10_000)
    // Force a losing day: initialBalance 10k, 5% limit → -500 blocks.
    const loser = {
      ...acc,
      balance: 9_400,
      trades: [
        {
          id: 't1',
          symbol: 'EUR/USD',
          side: 'long' as const,
          units: 10_000,
          entryPrice: 1.1,
          entryTime: new Date().toISOString(),
          exitPrice: 1.08,
          exitTime: new Date().toISOString(),
          stopPrice: 1.098,
          takeProfitPrice: 1.12,
          entryEquity: 10_000,
          pnl: -600,
          pnlPct: -6,
          closeReason: 'stop_loss' as const,
          strategy: 'manual',
          status: 'closed' as const,
        },
      ],
    }
    expect(todayPnlUsd(loser, rates)).toBeLessThan(-500)
    expect(canOpen(loser, rates).ok).toBe(false)
  })

  it('allows entries when under the limit', () => {
    const acc = createAccount(10_000)
    expect(canOpen(acc, rates).ok).toBe(true)
  })
})

describe('closeAllPositions', () => {
  it('flattens every open position at the current price', () => {
    const acc = createAccount(10_000)
    const first = openPosition(acc, {
      symbol: 'EUR/USD', side: 'long', entryPrice: 1.1, stopPips: 20, takeProfitPips: 40, units: 1000,
    }, rates)
    const second = openPosition(first.state, {
      symbol: 'GBP/USD', side: 'short', entryPrice: 1.27, stopPips: 20, takeProfitPips: 40, units: 1000,
    }, rates)
    const { state, closed } = closeAllPositions(second.state, rates)
    expect(closed).toHaveLength(2)
    expect(state.positions).toHaveLength(0)
  })
})

describe('runRobotCycle', () => {
  it('opens qualifying pairs and skips neutral signals', () => {
    const acc = createAccount(10_000)
    const { state, events } = runRobotCycle(acc, [
      {
        symbol: 'EUR/USD', signal: 'buy', price: 1.1, rates,
        strategy: 'MA', stopPips: 20, takeProfitPips: 40, units: 1000,
      },
      {
        symbol: 'GBP/USD', signal: 'neutral', price: 1.27, rates,
        strategy: 'MA', stopPips: 20, takeProfitPips: 40, units: 1000,
      },
    ], { pairs: ['EUR/USD', 'GBP/USD'], tradeMode: 'sequential', maxPerPair: 1, maxOpenTrades: 0 })
    expect(state.positions).toHaveLength(1)
    expect(events.some((e) => e.includes('Opened EUR/USD'))).toBe(true)
  })

  it('respects the global max-open-trades cap', () => {
    const acc = createAccount(10_000)
    const { state, events } = runRobotCycle(acc, [
      {
        symbol: 'EUR/USD', signal: 'buy', price: 1.1, rates,
        strategy: 'MA', stopPips: 20, takeProfitPips: 40, units: 1000,
      },
      {
        symbol: 'GBP/USD', signal: 'buy', price: 1.27, rates,
        strategy: 'MA', stopPips: 20, takeProfitPips: 40, units: 1000,
      },
    ], { pairs: ['EUR/USD', 'GBP/USD'], tradeMode: 'sequential', maxPerPair: 1, maxOpenTrades: 1 })
    expect(state.positions).toHaveLength(1)
    expect(events.some((e) => e.includes('Deferred GBP/USD'))).toBe(true)
  })
})

describe('profit probability gate', () => {
  it('estimates >50% for a strong setup with trend + momentum', () => {
    const prob = estimateProfitProbability({
      score: 78,
      momentum: 0.8,
      rsi: 35,
      trend: 1,
      volatilityPct: 0.8,
      stopPips: 20,
      takeProfitPips: 40,
    })
    expect(prob).not.toBeNull()
    expect(prob as number).toBeGreaterThan(0.5)
  })

  it('estimates <50% for a weak signal', () => {
    const prob = estimateProfitProbability({
      score: 30,
      momentum: 0.2,
      rsi: 55,
      trend: -1,
      volatilityPct: 4.2,
      stopPips: 40,
      takeProfitPips: 10,
    })
    expect(prob).not.toBeNull()
    expect(prob as number).toBeLessThan(0.5)
  })

  it('returns null when no ingredients are supplied (legacy behaviour)', () => {
    expect(estimateProfitProbability({})).toBeNull()
  })

  it('opens a trade on a >50% probability and stamps the trade', () => {
    const acc = createAccount(10_000)
    const { state, events } = runRobotCycle(acc, [
      {
        symbol: 'EUR/USD', signal: 'buy', price: 1.1, rates,
        strategy: 'MA', stopPips: 20, takeProfitPips: 40, units: 1000,
        score: 80,
      },
    ], { pairs: ['EUR/USD'], tradeMode: 'sequential', maxPerPair: 1, maxOpenTrades: 0 })
    expect(state.positions).toHaveLength(1)
    expect(state.positions[0].entryProbability).toBeGreaterThan(0.5)
    expect(events.some((e) => e.includes('Opened EUR/USD'))).toBe(true)
  })

  it('skips a trade at exactly 50% probability', () => {
    const acc = createAccount(10_000)
    const { state, events } = runRobotCycle(acc, [
      {
        symbol: 'EUR/USD', signal: 'buy', price: 1.1, rates,
        strategy: 'MA', stopPips: 20, takeProfitPips: 40, units: 1000,
        profitProbability: 0.5,
      },
    ], { pairs: ['EUR/USD'], tradeMode: 'sequential', maxPerPair: 1, maxOpenTrades: 0 })
    expect(state.positions).toHaveLength(0)
    expect(events.some((e) => e.includes('Skipped EUR/USD'))).toBe(true)
  })

  it('skips a trade below 50% probability and logs the reason', () => {
    const acc = createAccount(10_000)
    const { state, events } = runRobotCycle(acc, [
      {
        symbol: 'EUR/USD', signal: 'buy', price: 1.1, rates,
        strategy: 'MA', stopPips: 20, takeProfitPips: 40, units: 1000,
        score: 25,
      },
    ], { pairs: ['EUR/USD'], tradeMode: 'sequential', maxPerPair: 1, maxOpenTrades: 0 })
    expect(state.positions).toHaveLength(0)
    expect(events.some((e) => e.includes('Skipped EUR/USD'))).toBe(true)
  })

  it('probabilityGate mirrors the threshold check', () => {
    expect(probabilityGate({ symbol: 'EUR/USD', signal: 'buy', price: 1.1, rates, stopPips: 20, takeProfitPips: 40, units: 1000, profitProbability: 0.5 }).ok).toBe(false)
    expect(probabilityGate({ symbol: 'EUR/USD', signal: 'buy', price: 1.1, rates, stopPips: 20, takeProfitPips: 40, units: 1000, profitProbability: 0.51 }).ok).toBe(true)
    expect(entryProfitProbability({ symbol: 'EUR/USD', signal: 'buy', price: 1.1, rates, stopPips: 20, takeProfitPips: 40, units: 1000, profitProbability: 0.62 })).toBeCloseTo(0.62, 3)
  })

  it('carries the entry probability onto the closed trade', () => {
    const acc = createAccount(10_000)
    const { state: opened } = openPosition(acc, {
      symbol: 'EUR/USD', side: 'long', entryPrice: 1.1, stopPips: 20, takeProfitPips: 40, units: 1000,
      profitProbability: 0.61,
    }, rates)
    const pos = opened.positions[0]
    expect(pos.entryProbability).toBeCloseTo(0.61, 3)
    const { trade } = closePosition(opened, pos.id, { price: 1.104, reason: 'take_profit', rates })
    expect(trade?.entryProbability).toBeCloseTo(0.61, 3)
  })
})