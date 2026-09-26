/**
 * deepAnalysis — institutional-grade analytics over robot history.
 *
 * Performance.tsx shows raw numbers (P&L, sessions, win rate). This module
 * derives the risk-adjusted layer on top of the same data: Sharpe / Sortino /
 * Calmar ratios, maximum drawdown with its full curve, daily volatility,
 * profit factor, expectancy, per-strategy breakdowns, and a composite health
 * score for the robot.
 *
 * All functions are pure and unit-tested — no Supabase access here.
 */
import type { RobotHistoryPoint, RobotSessionRow } from './robotHistory'

export interface DrawdownPoint {
  time: string
  drawdownPct: number
}

export interface DeepMetrics {
  startEquity: number
  endEquity: number
  returnPct: number
  peak: number
  maxDrawdownPct: number
  /** Annualized volatility of daily returns, percent. */
  volatilityPct: number
  /** Risk-free-free Sharpe, annualized. null when there aren't 2 returns. */
  sharpe: number | null
  /** Downside-deviation variant of Sharpe. */
  sortino: number | null
  /** Annualized return / max drawdown. */
  calmar: number | null
  /** Point-to-point drawdown series (0 = at peak, negative = under water). */
  drawdownSeries: DrawdownPoint[]
  days: number
}

/**
 * Sort history points by time, then compute the daily-return risk metrics.
 * Returns null when there aren't at least 2 usable equity points.
 */
export function computeDeepMetrics(history: RobotHistoryPoint[]): DeepMetrics | null {
  const points = [...history]
    .filter((p) => Number.isFinite(p.equity) && p.equity > 0)
    .sort((a, b) => a.recorded_at.localeCompare(b.recorded_at))
  if (points.length < 2) return null

  const startEquity = points[0].equity
  const endEquity = points[points.length - 1].equity

  // Peak-and-trough drawdown series over the raw equity curve.
  let peak = startEquity
  let maxDrawdownPct = 0
  const drawdownSeries: DrawdownPoint[] = []
  for (const p of points) {
    if (p.equity > peak) peak = p.equity
    const dd = peak > 0 ? ((p.equity - peak) / peak) * 100 : 0
    if (dd < maxDrawdownPct) maxDrawdownPct = dd
    drawdownSeries.push({ time: p.recorded_at, drawdownPct: dd })
  }

  // Daily buckets → daily returns. This keeps the Sharpe honest regardless of
  // how frequently the recorder sampled the equity.
  const byDay = new Map<string, number>()
  for (const p of points) byDay.set(p.recorded_at.slice(0, 10), p.equity)
  const daily = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  const returns: number[] = []
  for (let i = 1; i < daily.length; i++) {
    const prev = daily[i - 1][1]
    if (prev > 0) returns.push(daily[i][1] / prev - 1)
  }

  const days = Math.max(daily.length - 1, 1)
  const sharpe = returns.length >= 2 ? annualizedSharpe(returns, 252, false) : null
  const sortino = returns.length >= 2 ? annualizedSharpe(returns, 252, true) : null

  const totalReturn = startEquity > 0 ? endEquity / startEquity - 1 : 0
  const annualizedReturn = totalReturn > -1 ? Math.pow(1 + totalReturn, 252 / days) - 1 : -1
  const calmar = maxDrawdownPct < 0 && annualizedReturn > -1 ? annualizedReturn / Math.abs(maxDrawdownPct / 100) : null

  return {
    startEquity,
    endEquity,
    returnPct: totalReturn * 100,
    peak,
    maxDrawdownPct,
    volatilityPct: annualizedVolatility(returns),
    sharpe,
    sortino,
    calmar,
    drawdownSeries,
    days,
  }
}

function annualizedSharpe(returns: number[], periodsPerYear: number, downsideOnly: boolean): number {
  const usable = downsideOnly ? returns.filter((r) => r < 0) : returns
  if (usable.length === 0) return 0
  const mean = usable.reduce((s, r) => s + r, 0) / usable.length
  const variance = usable.reduce((s, r) => s + (r - mean) ** 2, 0) / usable.length
  const dev = Math.sqrt(variance)
  if (dev === 0) return 0
  const fullMean = returns.reduce((s, r) => s + r, 0) / returns.length
  return (fullMean / dev) * Math.sqrt(periodsPerYear)
}

function annualizedVolatility(returns: number[]): number {
  if (returns.length === 0) return 0
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length
  return Math.sqrt(variance) * Math.sqrt(252) * 100
}

/* ------------------------------ Session stats ------------------------------ */

export interface StrategyBreakdown {
  strategy: string
  sessions: number
  wins: number
  losses: number
  netPnl: number
  winRate: number | null
  profitFactor: number | null
}

export interface SessionStats {
  total: number
  finished: number
  wins: number
  losses: number
  winRate: number | null
  grossProfit: number
  grossLoss: number
  profitFactor: number | null
  netPnl: number
  avgWin: number
  avgLoss: number
  expectancy: number | null
  bestSession: RobotSessionRow | null
  worstSession: RobotSessionRow | null
  byStrategy: StrategyBreakdown[]
}

/** Aggregate session-level performance, including a per-strategy breakdown. */
export function computeSessionStats(sessions: RobotSessionRow[]): SessionStats {
  const finished = sessions.filter((s) => s.status === 'finished')
  const pnls = finished.map((s) => s.pnl ?? 0)
  const wins = pnls.filter((p) => p > 0)
  const losses = pnls.filter((p) => p < 0)
  const grossProfit = wins.reduce((s, p) => s + p, 0)
  const grossLoss = Math.abs(losses.reduce((s, p) => s + p, 0))
  const netPnl = finished.reduce((s, row) => s + (row.pnl ?? 0), 0)
  const winRate = finished.length > 0 ? (wins.length / finished.length) * 100 : null
  // Profit factor: ratio when there are losses; null signals "no losing
  // sessions yet" (page renders it as ∞) rather than a misleading 0.
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : null
  const avgWin = wins.length > 0 ? grossProfit / wins.length : 0
  const avgLoss = losses.length > 0 ? grossLoss / losses.length : 0
  const expectancy =
    finished.length > 0 ? (winRate ?? 0) / 100 * avgWin - (1 - (winRate ?? 0) / 100) * avgLoss : null

  // Group by strategy — sessions without a named strategy fall under "—".
  const groups = new Map<string, RobotSessionRow[]>()
  for (const s of finished) {
    const key = s.strategy || '—'
    const list = groups.get(key) ?? []
    list.push(s)
    groups.set(key, list)
  }
  const byStrategy: StrategyBreakdown[] = [...groups.entries()]
    .map(([strategy, rows]) => {
      const w = rows.filter((r) => (r.pnl ?? 0) > 0).length
      const l = rows.filter((r) => (r.pnl ?? 0) < 0).length
      const gp = rows.filter((r) => (r.pnl ?? 0) > 0).reduce((s, r) => s + (r.pnl ?? 0), 0)
      const gl = Math.abs(rows.filter((r) => (r.pnl ?? 0) < 0).reduce((s, r) => s + (r.pnl ?? 0), 0))
      const net = rows.reduce((s, r) => s + (r.pnl ?? 0), 0)
      return {
        strategy,
        sessions: rows.length,
        wins: w,
        losses: l,
        netPnl: net,
        winRate: rows.length > 0 ? (w / rows.length) * 100 : null,
        profitFactor: gl > 0 ? gp / gl : gp > 0 ? null : null,
      }
    })
    .sort((a, b) => b.netPnl - a.netPnl)

  const best = finished.length > 0 ? finished.reduce((a, b) => ((a.pnl ?? 0) > (b.pnl ?? 0) ? a : b)) : null
  const worst = finished.length > 0 ? finished.reduce((a, b) => ((a.pnl ?? 0) < (b.pnl ?? 0) ? a : b)) : null

  return {
    total: sessions.length,
    finished: finished.length,
    wins: wins.length,
    losses: losses.length,
    winRate,
    grossProfit,
    grossLoss,
    profitFactor,
    netPnl,
    avgWin,
    avgLoss,
    expectancy,
    bestSession: best,
    worstSession: worst,
    byStrategy,
  }
}

/* ------------------------------- Health score ------------------------------ */

export interface HealthScore {
  score: number
  label: 'Elite' | 'Strong' | 'Developing' | 'Risky'
  strengths: string[]
  watchouts: string[]
}

/**
 * Composite 0–100 score for the robot: edge (win rate + profit factor),
 * reward for risk taken (Calmar-style drawdown control), and proof (trade
 * count). Null inputs (no data yet) yield a neutral 0-score scaffold.
 */
export function robotHealthScore(
  metrics: DeepMetrics | null,
  stats: SessionStats | null,
): HealthScore {
  const strengths: string[] = []
  const watchouts: string[] = []

  if (!metrics || !stats || stats.finished === 0) {
    return { score: 0, label: 'Developing', strengths: [], watchouts: ['Run the robot to start scoring its performance.'] }
  }

  let score = 50

  // Edge — win rate and profit factor.
  const wr = stats.winRate ?? 0
  if (wr >= 55) {
    score += 15
    strengths.push(`Win rate ${wr.toFixed(1)}% shows consistent edge.`)
  } else if (wr >= 45) {
    score += 5
  } else {
    score -= 10
    watchouts.push(`Win rate ${wr.toFixed(1)}% — check if losses outweigh wins.`)
  }
  const pf = stats.profitFactor
  if (pf != null && pf >= 1.5) {
    score += 10
    strengths.push(`Profit factor ${pf.toFixed(2)} — winners pay for losers 1.5×.`)
  } else if (pf != null && pf >= 1) {
    score += 3
  } else if (pf != null) {
    score -= 10
    watchouts.push('Profit factor below 1.0 — the robot is losing more than it wins.')
  }

  // Reward for risk — drawdown containment.
  const dd = Math.abs(metrics.maxDrawdownPct)
  if (dd <= 5) {
    score += 10
    strengths.push(`Max drawdown ${dd.toFixed(1)}% is tightly contained.`)
  } else if (dd <= 12) {
    score += 4
  } else {
    score -= 10
    watchouts.push(`Max drawdown ${dd.toFixed(1)}% is deep for the capital deployed.`)
  }
  if (metrics.calmar != null && metrics.calmar >= 1) {
    score += 10
    strengths.push(`Calmar ${metrics.calmar.toFixed(2)} — strong return per unit of drawdown.`)
  }

  // Proof — sample size.
  const n = stats.finished
  if (n >= 30) {
    score += 5
    strengths.push(`${n} finished sessions — results are becoming statistically meaningful.`)
  } else if (n >= 10) {
    score += 2
  } else {
    watchouts.push(`Only ${n} finished sessions — treat these numbers as early, not conclusive.`)
  }

  score = Math.max(0, Math.min(100, Math.round(score)))
  const label = score >= 80 ? 'Elite' : score >= 60 ? 'Strong' : score >= 35 ? 'Developing' : 'Risky'
  return { score, label, strengths, watchouts }
}
