/**
 * Account-safety tests: the near-zero emergency closeout (balance OR equity at
 * or below the floor → every position closes at market as 'margin' and the
 * robot stands down) and the sub-$1 trading lock (balance < $1 refuses every
 * entry, mirroring the disabled UI buttons).
 */
import { describe, expect, it } from 'vitest'
import {
  accountBlown,
  canOpen,
  createAccount,
  markToMarket,
  openPosition,
  runRobotCycle,
} from './engine'
import type { RatesMap } from './types'

// EUR/USD quotes in USD → usdPerUnit = 1; pipSize = 0.0001.
const rates: RatesMap = { 'EUR/USD': 1.1, 'GBP/USD': 1.27 }

/** Open a manual long on EUR/USD at 1.10 with a 20-pip stop. */
function openedLong(balance = 10_000, units = 1000) {
  const acc = createAccount(balance)
  const { state, error } = openPosition(
    acc,
    { symbol: 'EUR/USD', side: 'long', entryPrice: 1.1, stopPips: 20, takeProfitPips: 40, units },
    rates,
  )
  if (error) throw new Error(`test setup failed to open: ${error}`)
  return state
}

describe('sub-$1 trading lock', () => {
  it('allows entries at exactly $1.00 (boundary)', () => {
    const acc = createAccount(1.0)
    expect(canOpen(acc, rates).ok).toBe(true)
  })

  it('blocks entries just below $1.00 (boundary)', () => {
    const acc = createAccount(0.99)
    const gate = canOpen(acc, rates)
    expect(gate.ok).toBe(false)
    expect(gate.reason).toMatch(/below \$1/i)
  })

  it('blocks the robot cycle below $1 and logs the reason', () => {
    const acc = createAccount(0.5)
    const { state, events } = runRobotCycle(
      acc,
      [
        {
          symbol: 'EUR/USD',
          signal: 'buy',
          price: 1.1,
          rates,
          strategy: 'MA',
          stopPips: 20,
          takeProfitPips: 40,
          units: 1000,
        },
      ],
      { pairs: ['EUR/USD'], tradeMode: 'sequential', maxPerPair: 1, maxOpenTrades: 0 },
    )
    expect(state.positions).toHaveLength(0)
    expect(events.some((e) => /below \$1/i.test(e))).toBe(true)
  })

  it('blocks a signal flip below $1', () => {
    // A position opened while the account was healthy, whose balance has since
    // drained below $1, must not be re-entered on a reversal — canOpen refuses
    // the flip side of the same pair.
    const acc = { ...openedLong(), balance: 0.5 }
    expect(canOpen(acc, rates).ok).toBe(false)
  })
})

describe('near-zero emergency closeout', () => {
  it('closes every position as margin when the BALANCE hits the floor', () => {
    // A long opened on $10k; realized losses already dragged balance to $0.005.
    const acc = { ...openedLong(), balance: 0.005 }
    expect(accountBlown(acc, rates).blown).toBe(true)

    const { state, closed } = markToMarket(acc, rates)
    expect(closed).toHaveLength(1)
    expect(closed[0].closeReason).toBe('margin')
    expect(state.positions).toHaveLength(0)
    expect(state.risk.autoTrade).toBe(false)
  })

  it('closes everything as margin when EQUITY hits the floor (unrealized)', () => {
    // 1,000,000 units of EUR/USD: every 0.0001 price move = $100. At 1.09 the
    // position is −$10,000, so equity is $0 even though the realized balance
    // is still $10k — the closeout must fire on equity alone.
    const acc = openedLong(10_000, 1_000_000)
    const { state, closed } = markToMarket(acc, { ...rates, 'EUR/USD': 1.09 })
    expect(closed).toHaveLength(1)
    expect(closed[0].closeReason).toBe('margin')
    expect(state.balance).toBeLessThanOrEqual(0)
    expect(state.risk.autoTrade).toBe(false)
  })

  it('stands the robot down on a FLAT blown account too', () => {
    // Realized losses wiped the balance and nothing is open — the robot must
    // still stop (a dust balance can never auto-trade again).
    const base = createAccount(0.005)
    const acc = { ...base, risk: { ...base.risk, autoTrade: true } }
    const { state, closed } = markToMarket(acc, rates)
    expect(closed).toHaveLength(0)
    expect(state.risk.autoTrade).toBe(false)
  })

  it('overrides the fast-crash hold — a crash-held position is still closed', () => {
    // One giant mark against a huge position: the drawdown stop would normally
    // stand aside (crashHold), but once the account itself is blown there is
    // nothing left to ride out — the margin closeout flattens it regardless.
    const acc = openedLong(10_000, 1_000_000)
    const { state, closed } = markToMarket(acc, { ...rates, 'EUR/USD': 0.70 })
    expect(closed).toHaveLength(1)
    expect(closed[0].closeReason).toBe('margin')
    expect(state.positions).toHaveLength(0)
    expect(state.risk.autoTrade).toBe(false)
  })

  it('does NOT close out an account above the floor', () => {
    // Balance $0.011 (> $0.01 floor): locked below $1 but not blown — the
    // engine keeps the position and simply refuses new entries.
    const acc = { ...openedLong(), balance: 0.011 }
    expect(accountBlown(acc, rates).blown).toBe(false)
    const { closed } = markToMarket(acc, rates)
    expect(closed).toHaveLength(0)
  })

  it('leaves a healthy account completely untouched', () => {
    const acc = openedLong()
    const { state, closed } = markToMarket(acc, rates)
    expect(closed).toHaveLength(0)
    expect(state).toBe(acc) // identity preserved — no churn, no persistence write
    expect(state.risk.autoTrade).toBe(false)
  })
})