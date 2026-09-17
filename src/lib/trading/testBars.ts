/** Deterministic bar fixtures shared by the trading-module tests. */
import type { Bar } from '../types'

export function barsFromCloses(closes: number[], spread = 0.3): Bar[] {
  return closes.map((close, i) => ({
    time: `2026-01-01T00:${String(i % 60).padStart(2, '0')}:00Z`,
    open: close,
    high: close + spread,
    low: close - spread,
    close,
  }))
}

/** Deterministic PRNG so the decision tests are reproducible in CI. */
function seeded(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

/** Uptrend: steady climb with small deterministic noise. */
export function uptrendBars(n: number): Bar[] {
  const closes: number[] = []
  for (let i = 0; i < n; i++) closes.push(100 + i * 0.4 + Math.sin(i) * 0.05)
  return barsFromCloses(closes, 0.3)
}

/**
 * Trending waves: strong up-pushes that still pull back enough for fast/slow
 * MA crossovers to fire — a market with a clear direction AND tradable
 * entries/exits (unlike the monotone `uptrendBars`, which rarely crosses).
 */
export function trendingWavesBars(n: number): Bar[] {
  const closes: number[] = [100]
  for (let i = 1; i < n; i++) {
    const phase = i % 24
    const step = phase < 12 ? 0.7 : -0.45
    closes.push(closes[i - 1] + step)
  }
  return barsFromCloses(closes, 0.4)
}

/** Range: mean-reverting walk around 100 — directionless by construction. */
export function rangeBars(n: number): Bar[] {
  const rnd = seeded(42)
  const closes: number[] = [100]
  for (let i = 1; i < n; i++) {
    closes.push(closes[i - 1] + (100 - closes[i - 1]) * 0.15 + (rnd() - 0.5) * 1.2)
  }
  return barsFromCloses(closes, 0.3)
}

/** Volatility burst: `count` wide-range bars appended to a calm base series. */
export function burstBars(baseLength: number, count: number): Bar[] {
  const base = rangeBars(baseLength)
  const out = [...base]
  const lastClose = base[base.length - 1].close
  for (let i = 0; i < count; i++) {
    const close = lastClose + (i % 2 === 0 ? 1 : -0.4)
    out.push({ time: `2026-01-01T01:${String(i).padStart(2, '0')}:00Z`, open: close, high: close + 5, low: close - 5, close })
  }
  return out
}