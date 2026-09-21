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

describe('profit pull-back lock', () => {
  it('tracks the peak unrealized PnL and closes a winner past the give-back', () => {
    // 1000 units EUR/USD: pnl = (price − 1.1) × 1000. Lock at 25% → a $2 peak
    // must close once PnL retraces to $1.50 (1.1015).
    const acc = createAccount(10_000)
    acc.risk.trailingStop = false
    acc.risk.profitPullbackPct = 25
    const { state: opened } = openPosition(acc, {
      symbol: 'EUR/USD', side: 'long', entryPrice: 1.1, stopPips: 20, takeProfitPips: 40, units: 1000,
    }, rates)

    // Price rises to 1.102 → peak $2 recorded, nothing closes.
    const up = markToMarket(opened, { ...rates, 'EUR/USD': 1.102 })
    expect(up.closed).toHaveLength(0)
    expect(up.state.positions[0].peakProfitUsd).toBeCloseTo(2, 5)

    // Price holds above the lock threshold (1.1015 → $1.50) — still open.
    const hold = markToMarket(up.state, { ...rates, 'EUR/USD': 1.102 })
    expect(hold.closed).toHaveLength(0)

    // Price retraces to 1.1015 → PnL $1.50 ≤ peak × 0.75 → locked in.
    const locked = markToMarket(hold.state, { ...rates, 'EUR/USD': 1.1015 })
    expect(locked.closed).toHaveLength(1)
    expect(locked.closed[0].closeReason).toBe('pullback')
    expect(locked.closed[0].pnl).toBeCloseTo(1.5, 5)
    expect(locked.state.positions).toHaveLength(0)
  })

  it('keeps a winner open until the take-profit when the lock is off', () => {
    const acc = createAccount(10_000)
    acc.risk.trailingStop = false
    // Pull-back explicitly off — no peak tracking, no give-back close.
    acc.risk.profitPullbackPct = 0
    const { state: opened } = openPosition(acc, {
      symbol: 'EUR/USD', side: 'long', entryPrice: 1.1, stopPips: 20, takeProfitPips: 40, units: 1000,
    }, rates)
    const up = markToMarket(opened, { ...rates, 'EUR/USD': 1.102 })
    const back = markToMarket(up.state, { ...rates, 'EUR/USD': 1.101 })
    expect(back.closed).toHaveLength(0)
    expect(back.state.positions[0].peakProfitUsd).toBeUndefined()
    // The price take-profit still works as usual.
    const tp = markToMarket(back.state, { ...rates, 'EUR/USD': 1.104 })
    expect(tp.closed).toHaveLength(1)
    expect(tp.closed[0].closeReason).toBe('take_profit')
  })

  it('never arms below the $1 activation — a small blip up then down stays open', () => {
    // 1000 units EUR/USD: pnl = (price − 1.1) × 1000. A $0.60 peak (1.1006)
    // is under the $1 activation, so a 25%+ give-back must NOT close it.
    const acc = createAccount(10_000)
    acc.risk.trailingStop = false
    acc.risk.profitPullbackPct = 25
    const { state: opened } = openPosition(acc, {
      symbol: 'EUR/USD', side: 'long', entryPrice: 1.1, stopPips: 20, takeProfitPips: 40, units: 1000,
    }, rates)
    // Peak $0.60 — below the $1 arming line.
    const up = markToMarket(opened, { ...rates, 'EUR/USD': 1.1006 })
    expect(up.state.positions[0].peakProfitUsd).toBeCloseTo(0.6, 5)
    // Give-back beyond 25% of the (un-armed) peak — still held.
    const back = markToMarket(up.state, { ...rates, 'EUR/USD': 1.1002 })
    expect(back.closed).toHaveLength(0)
    expect(back.state.positions).toHaveLength(1)
  })

  it('arms at the $1 activation and closes on 25% give-back from the peak', () => {
    // Peak $1.20 (1.1012) > $1 → armed; retrace to $0.90 (1.1009) is 25% back
    // from the peak → the lock fires.
    const acc = createAccount(10_000)
    acc.risk.trailingStop = false
    acc.risk.profitPullbackPct = 25
    acc.risk.profitPullbackActivateUsd = 1
    const { state: opened } = openPosition(acc, {
      symbol: 'EUR/USD', side: 'long', entryPrice: 1.1, stopPips: 20, takeProfitPips: 40, units: 1000,
    }, rates)
    const up = markToMarket(opened, { ...rates, 'EUR/USD': 1.1012 })
    expect(up.closed).toHaveLength(0)
    expect(up.state.positions[0].peakProfitUsd).toBeCloseTo(1.2, 5)
    // Lock level = 1.2 × 0.75 = $0.90 — exactly hit at 1.1009.
    const locked = markToMarket(up.state, { ...rates, 'EUR/USD': 1.1009 })
    expect(locked.closed).toHaveLength(1)
    expect(locked.closed[0].closeReason).toBe('pullback')
    expect(locked.closed[0].pnl).toBeCloseTo(0.9, 5)
  })

  it('defaults the pull-back lock to 25% with a $1 activation', () => {
    const acc = createAccount(10_000)
    expect(acc.risk.profitPullbackPct).toBe(25)
    expect(acc.risk.profitPullbackActivateUsd).toBe(1)
  })

  it('never fires on a position that never went green', () => {
    const acc = createAccount(10_000)
    acc.risk.trailingStop = false
    acc.risk.profitPullbackPct = 25
    const { state: opened } = openPosition(acc, {
      symbol: 'EUR/USD', side: 'long', entryPrice: 1.1, stopPips: 20, takeProfitPips: 40, units: 1000,
    }, rates)
    // Price never rose above entry — peak stays 0, so pull-back can't close it.
    const res = markToMarket(opened, { ...rates, 'EUR/USD': 1.099 })
    expect(res.closed).toHaveLength(0)
    expect(res.state.positions).toHaveLength(1)
  })

  it('lets the take-profit win before the pull-back fires', () => {
    const acc = createAccount(10_000)
    acc.risk.trailingStop = false
    acc.risk.profitPullbackPct = 25
    const { state: opened } = openPosition(acc, {
      symbol: 'EUR/USD', side: 'long', entryPrice: 1.1, stopPips: 20, takeProfitPips: 40, units: 1000,
      targetProfitUsd: 10,
    }, rates)
    // TP at 1.104 is crossed while the position is still well above its lock:
    // $4 gain, peak $4 — no give-back yet — so it banks as take-profit.
    const res = markToMarket(opened, { ...rates, 'EUR/USD': 1.104 })
    expect(res.closed).toHaveLength(1)
    expect(res.closed[0].closeReason).toBe('take_profit')
  })
})

describe('drawdown stop (25%) with fast-crash hold', () => {
  // 6000-pip stop on EUR/USD = stop at 0.50, far below any price these tests
  // visit, so the % drawdown rule (not the raw stop) is what's under test.
  const openLong = (acc = createAccount(10_000)) =>
    openPosition(acc, {
      symbol: 'EUR/USD', side: 'long', entryPrice: 1.1, stopPips: 6000, takeProfitPips: 40, units: 1000,
    }, rates).state

  it('closes a position that bleeds slowly down across −25% (gradual)', () => {
    const opened = openLong()
    // Small steps (< 25% each) — a slow bleed, never a crash.
    let state = opened
    for (const price of [1.08, 1.02, 0.95, 0.87]) {
      const res = markToMarket(state, { ...rates, 'EUR/USD': price })
      expect(res.closed).toHaveLength(0) // −21% at 0.87 is still inside the band
      state = res.state
    }
    // 0.82 → −25.45% from entry, reached in a 5.9% step → drawdown stop fires.
    const { closed, state: out } = markToMarket(state, { ...rates, 'EUR/USD': 0.82 })
    expect(closed).toHaveLength(1)
    expect(closed[0].closeReason).toBe('drawdown')
    expect(out.positions).toHaveLength(0)
  })

  it('keeps a trade open when the whole band is crossed in ONE fast mark (crash)', () => {
    const opened = openLong()
    // Entry 1.10 → 0.70 in a single observation: step −36%, down −36% — a
    // fast, long crash. It must NOT be sold at the bottom.
    const { closed, state } = markToMarket(opened, { ...rates, 'EUR/USD': 0.70 })
    expect(closed).toHaveLength(0)
    expect(state.positions).toHaveLength(1)
    expect(state.positions[0].crashHold).toBe(true)
    expect(state.positions[0].lastMarkPrice).toBeCloseTo(0.70, 5)

    // Deeper still (small step) — the crash-held position rides it out.
    const deeper = markToMarket(state, { ...rates, 'EUR/USD': 0.66 })
    expect(deeper.closed).toHaveLength(0)
    expect(deeper.state.positions).toHaveLength(1)

    // A real recovery all the way to the take-profit still banks the win.
    const recovered = markToMarket(deeper.state, { ...rates, 'EUR/USD': 1.104 })
    expect(recovered.closed).toHaveLength(1)
    expect(recovered.closed[0].closeReason).toBe('take_profit')
  })

  it('still honours the hard stop on a crash-held position', () => {
    const opened = openLong()
    const crashed = markToMarket(opened, { ...rates, 'EUR/USD': 0.70 })
    expect(crashed.state.positions[0].crashHold).toBe(true)
    // The real stop (0.50) is never suspended — a cataclysmic drop still cuts.
    const stopped = markToMarket(crashed.state, { ...rates, 'EUR/USD': 0.49 })
    expect(stopped.closed).toHaveLength(1)
    expect(stopped.closed[0].closeReason).toBe('stop_loss')
  })

  it('holds a fast crash to the upside on a short', () => {
    const acc = createAccount(10_000)
    const { state: opened } = openPosition(acc, {
      symbol: 'EUR/USD', side: 'short', entryPrice: 1.1, stopPips: 6000, takeProfitPips: 40, units: 1000,
    }, rates)
    // One mark +32% against the short — fast and long — so it is held open.
    const { closed, state } = markToMarket(opened, { ...rates, 'EUR/USD': 1.45 })
    expect(closed).toHaveLength(0)
    expect(state.positions[0].crashHold).toBe(true)
  })

  it('does nothing when the drawdown stop is off (drawdownClosePct = 0)', () => {
    const acc = createAccount(10_000)
    acc.risk.drawdownClosePct = 0
    const { state: opened } = openPosition(acc, {
      symbol: 'EUR/USD', side: 'long', entryPrice: 1.1, stopPips: 6000, takeProfitPips: 40, units: 1000,
    }, rates)
    let r = opened
    for (const price of [0.95, 0.85, 0.72]) {
      const res = markToMarket(r, { ...rates, 'EUR/USD': price })
      expect(res.closed).toHaveLength(0)
      r = res.state
    }
    // −34.5% and still held — the feature is opt-in.
    expect(r.positions).toHaveLength(1)
    expect(r.positions[0].crashHold).toBeUndefined()
  })
})

describe('partial take-profit / scale-out', () => {
  // EUR/USD long @ 1.1, 20-pip stop → stop 1.098, stop distance 0.002.
  // partialTpRatio 1 → first target 1.102; full TP (40 pips) at 1.104.
  const open = (acc = createAccount(10_000), units = 1000) => {
    acc.risk.trailingStop = false // isolate the scale-out from the trail
    acc.risk.partialTakeProfit = true
    acc.risk.partialClosePct = 50
    acc.risk.partialTpRatio = 1
    return openPosition(acc, {
      symbol: 'EUR/USD', side: 'long', entryPrice: 1.1, stopPips: 20, takeProfitPips: 40, units,
    }, rates).state
  }

  it('banks half at the first target and keeps the rest open at break-even', () => {
    const opened = open()
    // First target (1.102 = 1R) → close 500 of 1000 units, stop → 1.1.
    const first = markToMarket(opened, { ...rates, 'EUR/USD': 1.102 })
    expect(first.closed).toHaveLength(1)
    expect(first.closed[0].closeReason).toBe('take_profit')
    expect(first.closed[0].units).toBe(500)
    expect(first.closed[0].pnl).toBeCloseTo(1, 5) // (1.102−1.1) × 500 × 1
    expect(first.state.balance).toBeCloseTo(10_001, 5)
    expect(first.state.positions).toHaveLength(1)
    const rest = first.state.positions[0]
    expect(rest.units).toBe(500)
    expect(rest.partialTaken).toBe(true)
    expect(rest.stopPrice).toBeCloseTo(1.1, 6) // moved to break-even
    expect(rest.takeProfitPrice).toBeCloseTo(1.104, 6) // full target kept
  })

  it('the remaining units ride to the full take-profit', () => {
    const opened = open()
    const first = markToMarket(opened, { ...rates, 'EUR/USD': 1.102 })
    expect(first.closed).toHaveLength(1)
    // Remainder closes at the full TP (1.104): (1.104−1.1) × 500 × 1 = $2.
    const second = markToMarket(first.state, { ...rates, 'EUR/USD': 1.104 })
    expect(second.closed).toHaveLength(1)
    expect(second.closed[0].closeReason).toBe('take_profit')
    expect(second.closed[0].units).toBe(500)
    expect(second.closed[0].pnl).toBeCloseTo(2, 5)
    expect(second.state.positions).toHaveLength(0)
    expect(second.state.trades).toHaveLength(2) // partial + full, both banked
  })

  it('only banks the first target once', () => {
    const opened = open()
    const first = markToMarket(opened, { ...rates, 'EUR/USD': 1.102 })
    expect(first.closed).toHaveLength(1)
    // Price stays at/above the first target — no second partial close.
    const again = markToMarket(first.state, { ...rates, 'EUR/USD': 1.103 })
    expect(again.closed).toHaveLength(0)
    expect(again.state.positions[0].partialTaken).toBe(true)
    expect(again.state.positions[0].units).toBe(500)
    // …but the full target still closes the remainder normally.
    const full = markToMarket(again.state, { ...rates, 'EUR/USD': 1.104 })
    expect(full.closed).toHaveLength(1)
    expect(full.closed[0].closeReason).toBe('take_profit')
  })

  it('is off by default — the whole position rides to one take-profit', () => {
    const acc = createAccount(10_000)
    const { state: opened } = openPosition(acc, {
      symbol: 'EUR/USD', side: 'long', entryPrice: 1.1, stopPips: 20, takeProfitPips: 40, units: 1000,
    }, rates)
    // At the would-be first target nothing closes…
    const mid = markToMarket(opened, { ...rates, 'EUR/USD': 1.102 })
    expect(mid.closed).toHaveLength(0)
    expect(mid.state.positions).toHaveLength(1)
    // …and the full target closes all 1000 units.
    const full = markToMarket(opened, { ...rates, 'EUR/USD': 1.104 })
    expect(full.closed).toHaveLength(1)
    expect(full.closed[0].units).toBe(1000)
    expect(full.closed[0].pnl).toBeCloseTo(4, 5)
  })

  it('closes the whole position when the partial % is 100', () => {
    const acc = createAccount(10_000)
    acc.risk.trailingStop = false
    acc.risk.partialTakeProfit = true
    acc.risk.partialClosePct = 100
    const { state: opened } = openPosition(acc, {
      symbol: 'EUR/USD', side: 'long', entryPrice: 1.1, stopPips: 20, takeProfitPips: 40, units: 1000,
    }, rates)
    const res = markToMarket(opened, { ...rates, 'EUR/USD': 1.102 })
    expect(res.closed).toHaveLength(1)
    expect(res.closed[0].units).toBe(1000)
    expect(res.state.positions).toHaveLength(0)
  })

  it('scale-out works on the short side (first target below entry)', () => {
    const acc = createAccount(10_000)
    acc.risk.trailingStop = false
    acc.risk.partialTakeProfit = true
    acc.risk.partialClosePct = 50
    acc.risk.partialTpRatio = 1
    const { state: opened } = openPosition(acc, {
      symbol: 'EUR/USD', side: 'short', entryPrice: 1.1, stopPips: 20, takeProfitPips: 40, units: 1000,
    }, rates)
    // Short @ 1.1, stop 1.102, first target 1.098, full TP 1.096.
    const first = markToMarket(opened, { ...rates, 'EUR/USD': 1.098 })
    expect(first.closed).toHaveLength(1)
    expect(first.closed[0].closeReason).toBe('take_profit')
    expect(first.closed[0].pnl).toBeCloseTo(1, 5) // (1.1−1.098) × 500 × 1
    const rest = first.state.positions[0]
    expect(rest.units).toBe(500)
    expect(rest.partialTaken).toBe(true)
    expect(rest.stopPrice).toBeCloseTo(1.1, 6) // break-even
    const full = markToMarket(first.state, { ...rates, 'EUR/USD': 1.096 })
    expect(full.closed).toHaveLength(1)
    expect(full.closed[0].pnl).toBeCloseTo(2, 5)
    expect(full.state.positions).toHaveLength(0)
  })

  it('keeps a 1-unit position intact — the rule needs units to split', () => {
    const acc = createAccount(10_000)
    acc.risk.trailingStop = false
    acc.risk.partialTakeProfit = true
    const { state: opened } = openPosition(acc, {
      symbol: 'EUR/USD', side: 'long', entryPrice: 1.1, stopPips: 20, takeProfitPips: 40, units: 1,
    }, rates)
    // No split possible at 1 unit — the position just rides to the full TP.
    const mid = markToMarket(opened, { ...rates, 'EUR/USD': 1.102 })
    expect(mid.closed).toHaveLength(0)
    const full = markToMarket(opened, { ...rates, 'EUR/USD': 1.104 })
    expect(full.closed).toHaveLength(1)
    expect(full.closed[0].units).toBe(1)
  })
})