/** Temporary walkthrough harness (deleted after the run) — prints the same
 *  comparison the CapComparisonCard shows, on three phase-shifted pairs. */
import { describe, it } from 'vitest'
import type { Bar, StrategyConfig } from '../types'
import { trendingWavesBars } from '../trading/testBars'
import { capAdvice, comparePerPairCaps } from './capComparison'

/**
 * Correlated pairs: the same trending-wave series shifted in time (so each pair
 * crosses at its own bar) plus a small pair-specific drift — like three forex
 * pairs sharing one style on the same session.
 */
function pairBars(offset: number, drift = 0): Bar[] {
  return trendingWavesBars(220 + offset)
    .slice(offset)
    .map((b, i) => {
      const shift = drift * i * 0.02
      return { ...b, close: b.close + shift, high: b.high + shift, low: b.low + shift }
    })
}

const STRATEGY: StrategyConfig = {
  pair: 'EUR/USD',
  interval: '5min',
  type: 'MA',
  params: { fastPeriod: 8, slowPeriod: 21 },
}

describe('walkthrough', () => {
  it('prints the cap comparison the Backtester card shows', () => {
    const barsBySymbol: Record<string, Bar[]> = {
      'EUR/USD': pairBars(0),
      'GBP/USD': pairBars(7, 0.6),
      'USD/JPY': pairBars(15, -0.5),
    }
    const settings = {
      pairs: Object.keys(barsBySymbol),
      tradeMode: 'concurrent' as const,
      maxPerPair: 4,
      maxOpenTrades: 9,
      costPerTrade: 2.5,
    }
    const fmt = (n: number, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : '—')
    const chip = (r: { sequence: ('long' | 'short')[] }) =>
      r.sequence.map((s) => (s === 'long' ? 'L' : 'S')).join(',')

    console.log('\n== Positions per pair — compared (live book, $2.50/round trip) ==')
    console.log('cap | mode        | fill order     | trades | net profit | return  | max DD | win rate')
    for (const r of comparePerPairCaps(barsBySymbol, STRATEGY, settings)) {
      const m = r.result.metrics
      console.log(
        `${r.cap}   | ${r.zigZag ? 'conc·zig-zag' : r.tradeMode === 'sequential' ? 'sequential ' : 'concurrent '} | ${chip(r).padEnd(11)} | ${String(m.totalTrades).padStart(5)}  | ${fmt(m.netProfit).padStart(9)} | ${fmt(m.totalReturnPct).padStart(6)}% | ${fmt(m.maxDrawdownPct).padStart(5)}% | ${fmt(m.winRatePct, 0).padStart(3)}%`,
      )
    }

    console.log('\n== Cap 4: alternating book vs one-way stack (same bars, $2.50/round trip) ==')
    for (const zigZag of [false, true]) {
      const r = comparePerPairCaps(barsBySymbol, STRATEGY, settings, { caps: [4], zigZag })[0]
      const m = r.result.metrics
      console.log(
        `zig-zag ${zigZag ? 'ON ' : 'OFF'} | fill ${chip(r).padEnd(11)} | trades ${String(m.totalTrades).padStart(4)} | net ${fmt(m.netProfit)} | shorts ${r.result.trades.filter((t) => t.side === 'short').length}`,
      )
    }
  })
})