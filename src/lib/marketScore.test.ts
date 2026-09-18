import { describe, expect, it } from 'vitest'
import type { Quote } from './types'
import { isMetalPair, isCryptoPair, WATCHLIST } from './watchlist'
import { isPairOpen } from './marketHours'
import { scorePair, sortMarketRows } from './marketScore'

function quote(symbol: string, price: number, pct: number | null, extra: Partial<Quote> = {}): Quote {
  return { symbol, price, change: pct != null ? price * (pct / 100) : null, percent_change: pct, datetime: null, ...extra } as Quote
}

describe('watchlist metals', () => {
  it('includes the gold/silver/platinum/palladium universe', () => {
    const symbols = WATCHLIST.map((p) => p.symbol)
    for (const s of ['XAU/USD', 'XAU/EUR', 'XAU/JPY', 'XAG/USD', 'XPT/USD', 'XPD/USD', 'XAU/CHF']) {
      expect(symbols).toContain(s)
    }
  })

  it('classifies metals separately from forex and crypto', () => {
    expect(isMetalPair('XAU/USD')).toBe(true)
    expect(isMetalPair('xag/usd')).toBe(true)
    expect(isMetalPair('EUR/USD')).toBe(false)
    expect(isCryptoPair('BTC/USD')).toBe(true)
    expect(isCryptoPair('XAU/USD')).toBe(false)
  })
})

describe('marketScore', () => {
  it('returns 0 probability when there is no quote yet', () => {
    expect(scorePair('XAU/USD', null).probability).toBe(0)
  })

  it('uses the quote is_market_open flag when present', () => {
    const q = quote('XAU/USD', 2600, 0.1, { is_market_open: false })
    expect(scorePair('XAU/USD', q).active).toBe(false)
  })

  it('blends momentum, consistency and volatility into a 5–99 score', () => {
    const strongBullish = quote('XAU/USD', 2600, 0.8)
    const quiet = quote('EUR/USD', 1.09, 0.02)
    const wild = quote('GBP/JPY', 190, 1.2, { high: 195, low: 185 })
    const s1 = scorePair('XAU/USD', strongBullish).probability
    const s2 = scorePair('EUR/USD', quiet).probability
    const s3 = scorePair('GBP/JPY', wild).probability
    expect(s1).toBeGreaterThan(s2)
    expect(s3).toBeLessThan(scorePair('GBP/JPY', quote('GBP/JPY', 190, 1.2)).probability)
    for (const s of [s1, s2, s3]) {
      expect(s).toBeGreaterThanOrEqual(5)
      expect(s).toBeLessThanOrEqual(99)
    }
  })

  it('rank sort puts open markets and stronger setups first', () => {
    const rows = [
      { symbol: 'EUR/USD', quote: quote('EUR/USD', 1.09, 0.02, { is_market_open: true }) },
      { symbol: 'BTC/USD', quote: quote('BTC/USD', 100, 0.8, { is_market_open: true }) },
      { symbol: 'XAU/USD', quote: quote('XAU/USD', 2600, 2.1, { is_market_open: false }) },
    ]
    const sorted = sortMarketRows(rows, 'rank').map((r) => r.symbol)
    expect(sorted[0]).toBe('BTC/USD') // open + high score beats calm open pair
    expect(sorted).toContain('EUR/USD')
    expect(sorted[2]).toBe('XAU/USD') // closed market sinks to the bottom
  })

  it('momentum sort orders by absolute % move', () => {
    const rows = [
      { symbol: 'EUR/USD', quote: quote('EUR/USD', 1.09, 0.4) },
      { symbol: 'XAU/USD', quote: quote('XAU/USD', 2600, -1.4) },
      { symbol: 'BTC/USD', quote: quote('BTC/USD', 50, 0.1) },
    ]
    expect(sortMarketRows(rows, 'momentum').map((r) => r.symbol)).toEqual(['XAU/USD', 'EUR/USD', 'BTC/USD'])
    expect(sortMarketRows(rows, 'az').map((r) => r.symbol)).toEqual(['BTC/USD', 'EUR/USD', 'XAU/USD'])
  })

  it('metals follow forex market hours (session-bounded, never 24/7)', () => {
    expect(typeof isPairOpen('XAU/USD')).toBe('boolean')
    expect(isPairOpen('BTC/USD')).toBe(true)
    // XAU must NOT be treated as crypto (which would make it always-open).
    expect(isCryptoPair('XAU/USD')).toBe(false)
  })
})