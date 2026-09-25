import { describe, it, expect } from 'vitest'
import { closePosition, createAccount, markToMarket, openPosition, reverseOrderLeg, runRobotCycle } from './engine'
import type { RatesMap, RobotConfig, RobotCycleInput } from './types'

const RATES: RatesMap = { 'EUR/USD': 1.085, 'GBP/USD': 1.27, 'USD/JPY': 151.2 }

function input(symbol: string, signal: RobotCycleInput['signal'] = 'buy', price?: number): RobotCycleInput {
  return {
    symbol,
    signal,
    price: price ?? RATES[symbol] ?? 1.0,
    rates: RATES,
    strategy: 'RSI · 5min',
    stopPips: 20,
    takeProfitPips: 40,
    units: 1000,
  }
}

function config(overrides: Partial<RobotConfig> = {}): RobotConfig {
  return { pairs: ['EUR/USD', 'GBP/USD', 'USD/JPY'], tradeMode: 'sequential', maxPerPair: 1, maxOpenTrades: 3, ...overrides }
}

describe('runRobotCycle — multi-pair watchlist', () => {
  it('opens a trade on every qualifying pair in one cycle (sequential, no caps hit)', () => {
    const { state, events } = runRobotCycle(
      createAccount(10_000),
      [input('EUR/USD', 'buy'), input('GBP/USD', 'sell'), input('USD/JPY', 'neutral')],
      config(),
    )
    expect(state.positions).toHaveLength(2)
    expect(state.positions.map((p) => p.symbol).sort()).toEqual(['EUR/USD', 'GBP/USD'])
    expect(events.some((e) => e.startsWith('Opened EUR/USD long'))).toBe(true)
    expect(events.some((e) => e.startsWith('Opened GBP/USD short'))).toBe(true)
  })

  it('does not open on neutral signals and skips pairs with no signal', () => {
    const { state } = runRobotCycle(createAccount(10_000), [input('EUR/USD', 'neutral')], config())
    expect(state.positions).toHaveLength(0)
  })
})

describe('runRobotCycle — concurrent entries on one pair', () => {
  it('allows up to maxPerPair open positions on the same pair', () => {
    const cfg = config({ tradeMode: 'concurrent', maxPerPair: 2, maxOpenTrades: 5 })
    const first = runRobotCycle(createAccount(10_000), [input('EUR/USD', 'buy')], cfg)
    expect(first.state.positions).toHaveLength(1)

    // Second qualifying signal on the same pair while the first is still open.
    const second = runRobotCycle(first.state, [input('EUR/USD', 'buy')], cfg)
    expect(second.state.positions).toHaveLength(2)
    expect(second.state.positions.every((p) => p.symbol === 'EUR/USD')).toBe(true)
  })

  it('skips (never over-fills) a pair already at maxPerPair', () => {
    const cfg = config({ tradeMode: 'concurrent', maxPerPair: 2, maxOpenTrades: 5 })
    let state = createAccount(10_000)
    state = runRobotCycle(state, [input('EUR/USD', 'buy')], cfg).state
    state = runRobotCycle(state, [input('EUR/USD', 'buy')], cfg).state

    const third = runRobotCycle(state, [input('EUR/USD', 'buy')], cfg)
    expect(third.state.positions).toHaveLength(2) // still 2 — no over-fill
    expect(third.events.some((e) => e.includes('per-pair cap 2 reached'))).toBe(true)
  })
})

describe('runRobotCycle — sequential mode', () => {
  it('keeps at most one position per pair (second signal on same pair is skipped)', () => {
    const cfg = config({ tradeMode: 'sequential', maxPerPair: 1 })
    let state = createAccount(10_000)
    state = runRobotCycle(state, [input('EUR/USD', 'buy')], cfg).state
    expect(state.positions).toHaveLength(1)

    const again = runRobotCycle(state, [input('EUR/USD', 'buy')], cfg)
    expect(again.state.positions).toHaveLength(1)
    expect(again.events.some((e) => e.includes('per-pair cap 1 reached'))).toBe(true)
  })
})

describe('reverse-order (zig-zag) legs above 2 per pair', () => {
  it('keeps legs 1 and 2 on the signal side and alternates every leg after that', () => {
    // Buy signal, cap 4 → long, long, short, long, short…
    expect(reverseOrderLeg('long', 0, 4)).toBe('long')
    expect(reverseOrderLeg('long', 1, 4)).toBe('long')
    expect(reverseOrderLeg('long', 2, 4)).toBe('short')
    expect(reverseOrderLeg('long', 3, 4)).toBe('long')
    expect(reverseOrderLeg('long', 4, 5)).toBe('short')
    // Sell signal mirrors the pattern.
    expect(reverseOrderLeg('short', 2, 4)).toBe('long')
    expect(reverseOrderLeg('short', 3, 4)).toBe('short')
  })

  it('never reverses with a cap of 2 or less — the cap gates the rule', () => {
    for (const cap of [1, 2]) {
      for (const leg of [0, 1, 2, 3]) {
        expect(reverseOrderLeg('long', leg, cap)).toBe('long')
        expect(reverseOrderLeg('short', leg, cap)).toBe('short')
      }
    }
  })

  it('fills a 4-per-pair cap as long, long, short, long across cycles', () => {
    const cfg = config({ tradeMode: 'concurrent', maxPerPair: 4, maxOpenTrades: 6 })
    let state = createAccount(10_000)
    const events: string[] = []
    for (let i = 0; i < 4; i++) {
      const run = runRobotCycle(state, [input('EUR/USD', 'buy')], cfg)
      state = run.state
      events.push(...run.events)
    }
    expect(state.positions.map((p) => p.side)).toEqual(['long', 'long', 'short', 'long'])
    // Every leg — reversed ones included — keeps its own stop protection, on
    // the correct side of its entry.
    expect(state.positions.every((p) => p.stopPrice > 0)).toBe(true)
    expect(state.positions.filter((p) => p.side === 'short')).toHaveLength(1)
    expect(state.positions.filter((p) => p.side === 'short')[0].stopPrice).toBeGreaterThan(1.085)
    expect(events.some((e) => e.includes('reverse order — leg 3 of 4'))).toBe(true)
    // The cap still bites: a fifth qualifying signal opens nothing.
    const fifth = runRobotCycle(state, [input('EUR/USD', 'buy')], cfg)
    expect(fifth.state.positions).toHaveLength(4)
    expect(fifth.events.some((e) => e.includes('per-pair cap 4 reached'))).toBe(true)
  })

  it('mirrors the pattern for a sell signal (short, short, long)', () => {
    const cfg = config({ tradeMode: 'concurrent', maxPerPair: 3, maxOpenTrades: 4 })
    let state = createAccount(10_000)
    for (let i = 0; i < 3; i++) {
      state = runRobotCycle(state, [input('EUR/USD', 'sell')], cfg).state
    }
    expect(state.positions.map((p) => p.side)).toEqual(['short', 'short', 'long'])
  })

  it('counts the legs actually open on the pair, so a closed leg shifts the pattern', () => {
    const cfg = config({ tradeMode: 'concurrent', maxPerPair: 4, maxOpenTrades: 6 })
    let state = createAccount(10_000)
    state = runRobotCycle(state, [input('EUR/USD', 'buy')], cfg).state // leg 1 — long
    state = runRobotCycle(state, [input('EUR/USD', 'buy')], cfg).state // leg 2 — long
    state = runRobotCycle(state, [input('EUR/USD', 'buy')], cfg).state // leg 3 — short
    // Close the short (third) leg → two longs remain, so the NEXT leg is
    // leg index 2 again and refills the reversed slot.
    const third = state.positions[2]
    expect(third.side).toBe('short')
    state = closePosition(state, third.id, { price: 1.085, reason: 'manual', rates: RATES }).state
    const next = runRobotCycle(state, [input('EUR/USD', 'buy')], cfg)
    expect(next.state.positions.map((p) => p.side)).toEqual(['long', 'long', 'short'])
  })
})

describe('runRobotCycle — global maxOpenTrades cap', () => {
  it('defers qualifying pairs once the global cap is reached', () => {
    const cfg = config({ tradeMode: 'concurrent', maxPerPair: 2, maxOpenTrades: 2 })
    const { state, events } = runRobotCycle(
      createAccount(10_000),
      [input('EUR/USD', 'buy'), input('GBP/USD', 'buy'), input('USD/JPY', 'buy')],
      cfg,
    )
    expect(state.positions).toHaveLength(2) // global cap of 2
    expect(events.some((e) => e.includes('global cap 2 reached'))).toBe(true)
  })
})

describe('runRobotCycle — partial pair failure isolation', () => {
  it('continues the cycle when one pair fails (invalid price)', () => {
    const { state, events } = runRobotCycle(
      createAccount(10_000),
      [input('EUR/USD', 'buy', 0), input('GBP/USD', 'buy')], // EUR/USD price invalid
      config(),
    )
    expect(state.positions).toHaveLength(1)
    expect(state.positions[0].symbol).toBe('GBP/USD')
    expect(events.some((e) => e.startsWith('EUR/USD:'))).toBe(true)
  })

  it('stands the whole robot down when the daily loss gate trips (account-wide)', () => {
    let state = createAccount(10_000)
    // Force the daily loss limit by opening and closing a losing position first.
    const opened = openPosition(
      state,
      { symbol: 'EUR/USD', side: 'long', entryPrice: RATES['EUR/USD'] ?? 1.085, stopPips: 20, takeProfitPips: 40, units: 10_000, strategy: 'X' },
      RATES,
    )
    state = opened.state
    // Price tanks → realized loss trips the 5% daily loss gate (-$1050 < -$500).
    const { state: closedState } = markToMarket(state, { ...RATES, 'EUR/USD': 0.98 })
    state = closedState
    expect(state.balance).toBeLessThan(10_000)

    const { state: next, events } = runRobotCycle(
      state,
      [input('EUR/USD', 'buy'), input('GBP/USD', 'buy')],
      config(),
    )
    // The gate is account-wide by design: no pair opens until tomorrow, and the
    // cycle reports it instead of failing.
    expect(next.positions).toHaveLength(0)
    expect(events.some((e) => e.includes('Daily loss limit'))).toBe(true)
  })
})