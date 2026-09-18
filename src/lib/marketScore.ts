/**
 * Per-pair quote scoring for the watchlist. Gives the Markets page an honest,
 * bar-free "probability of profit" estimate so rows can be ordered by active
 * market first, then setup strength. The score borrows the same family of
 * factors as the bar-based `bestStrategy` scoring (momentum conviction,
 * direction consistency, volatility penalty) but derives them from the live
 * quote alone, so the public page needs no per-symbol bar fetches.
 */
import type { Quote } from './types'
import { isPairOpen } from './marketHours'

export interface MarketScore {
  /** True when the pair's market session is open right now. */
  active: boolean
  /** 5–99 probability-of-profit estimate; 0 when there is no live quote yet. */
  probability: number
}

export type MarketSort = 'rank' | 'momentum' | 'az'

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

export function scorePair(symbol: string, q?: Quote | null): MarketScore {
  if (!q) return { active: isPairOpen(symbol), probability: 0 }
  const active = q.is_market_open != null ? q.is_market_open : isPairOpen(symbol)
  const price = q.price

  const prev = q.previous_close ?? 0
  const pct = q.percent_change ?? (prev > 0 && q.change != null ? (q.change / prev) * 100 : 0)
  const absPct = Math.abs(pct)

  let score = 50
  // Momentum conviction — a real move on the latest bar confirms the setup
  // (scaled the same way as the bar-based score): up to +18 pts for a 3% move.
  score += Math.min(24, absPct * 6)
  // Direction consistency: signed change and signed % agreeing adds trust.
  if (pct !== 0 && q.change != null && pct * q.change >= 0) score += 4
  // Volatility penalty: an unusually wide intraday range is whipsaw-prone and
  // caps conviction, no matter how pretty the move looks.
  const rangePct =
    q.high != null && q.low != null && price != null && price > 0 ? ((q.high - q.low) / price) * 100 : 0
  if (rangePct > 2) score -= Math.min(15, (rangePct - 2) * 4)

  return { active, probability: price != null ? Math.round(clamp(score, 5, 99)) : 0 }
}

export interface MarketRow {
  symbol: string
  quote?: Quote | null
}

/**
 * Sorted copy of the watchlist rows.
 *  - 'rank': active markets first, then highest probability of profit, then A–Z.
 *  - 'momentum': strongest 24h move (absolute %) first.
 *  - 'az': alphabetical.
 */
export function sortMarketRows(rows: MarketRow[], sort: MarketSort): MarketRow[] {
  const copy = [...rows]
  copy.sort((a, b) => {
    if (sort === 'az') return a.symbol.localeCompare(b.symbol)
    if (sort === 'momentum') {
      const ma = Math.abs(a.quote?.percent_change ?? 0)
      const mb = Math.abs(b.quote?.percent_change ?? 0)
      if (mb !== ma) return mb - ma
      return a.symbol.localeCompare(b.symbol)
    }
    // 'rank'
    const sa = scorePair(a.symbol, a.quote)
    const sb = scorePair(b.symbol, b.quote)
    if (sa.active !== sb.active) return sa.active ? -1 : 1
    if (sb.probability !== sa.probability) return sb.probability - sa.probability
    return a.symbol.localeCompare(b.symbol)
  })
  return copy
}