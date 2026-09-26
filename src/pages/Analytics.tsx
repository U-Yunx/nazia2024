/**
 * Analytics — the risk-adjusted layer over robot history. Derives Sharpe /
 * Sortino / Calmar, the drawdown curve, profit factor, expectancy, per-strategy
 * breakdowns and a composite health score from the same sessions and equity
 * history that Performance shows as raw numbers.
 */
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Activity, Gauge, Play, ShieldAlert, TrendingUp } from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import { loadRobotHistory, type RobotPerformance } from '../lib/trading/robotHistory'
import {
  computeDeepMetrics,
  computeSessionStats,
  robotHealthScore,
  type DrawdownPoint,
} from '../lib/trading/deepAnalysis'
import { formatDateTime, formatUsd } from '../lib/format'
import { cn } from '../lib/cn'
import { Button, Card, CardContent, CardHeader, CardTitle, EmptyState, PageHeader, Skeleton } from '../components/ui'
import { MetricsCards, type MetricItem } from '../components/MetricsCards'
import { EquityChart } from '../components/EquityChart'

const fmtPct = (v: number | null | undefined, dp = 1) => (v == null ? '—' : `${v.toFixed(dp)}%`)
const fmtRatio = (v: number | null | undefined, dp = 2) => (v == null ? '—' : v.toFixed(dp))
const fmtInf = (v: number | null | undefined, hasData: boolean, dp = 2) =>
  v == null ? (hasData ? '∞' : '—') : v.toFixed(dp)

function toneFor(value: number, upAt: number, downAt: number): MetricItem['tone'] {
  return value >= upAt ? 'up' : value <= downAt ? 'down' : 'accent'
}

/* ------------------------------ Health ring ------------------------------ */

function HealthRing({ score, label }: { score: number; label: string }) {
  const r = 52
  const c = 2 * Math.PI * r
  const pct = Math.min(100, Math.max(0, score))
  const offset = c * (1 - pct / 100)
  const tier = pct >= 60 ? 'text-up' : pct >= 35 ? 'text-accent' : 'text-down'
  const gradId = pct >= 60 ? 'ring-grad-up' : pct >= 35 ? 'ring-grad-accent' : 'ring-grad-down'
  return (
    <div
      className="relative h-36 w-36 shrink-0"
      role="img"
      aria-label={`Robot health score ${pct} out of 100 — ${label}`}
    >
      <svg viewBox="0 0 120 120" className="h-full w-full -rotate-90">
        <defs>
          <linearGradient id="ring-grad-up" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="var(--color-up)" />
            <stop offset="55%" stopColor="var(--color-teal)" />
            <stop offset="100%" stopColor="var(--color-cyan)" />
          </linearGradient>
          <linearGradient id="ring-grad-accent" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="var(--color-accent)" />
            <stop offset="55%" stopColor="var(--color-cyan)" />
            <stop offset="100%" stopColor="var(--color-violet)" />
          </linearGradient>
          <linearGradient id="ring-grad-down" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="var(--color-down)" />
            <stop offset="55%" stopColor="var(--color-pink)" />
            <stop offset="100%" stopColor="var(--color-amber)" />
          </linearGradient>
        </defs>
        <circle
          cx="60"
          cy="60"
          r={r}
          fill="none"
          stroke="currentColor"
          strokeOpacity={0.12}
          strokeWidth="10"
          className="text-muted-foreground"
        />
        <circle
          cx="60"
          cy="60"
          r={r}
          fill="none"
          stroke={`url(#${gradId})`}
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={offset}
          className="transition-all duration-700 ease-out"
          style={{ filter: `drop-shadow(0 0 6px var(--color-${gradId.includes('up') ? 'up' : gradId.includes('down') ? 'down' : 'accent'})40%)` }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className={cn('font-heading text-4xl font-bold tracking-tight', tier)}>{pct}</span>
        <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">{label}</span>
      </div>
    </div>
  )
}

/* ----------------------------- Drawdown chart ----------------------------- */

function DrawdownChart({ series, height = 260 }: { series: DrawdownPoint[]; height?: number }) {
  if (series.length === 0) {
    return (
      <div
        style={{ height }}
        className="flex w-full items-center justify-center rounded-lg border border-dashed border-border bg-secondary/10 text-sm text-muted-foreground"
      >
        Not enough equity history to trace a drawdown curve yet.
      </div>
    )
  }

  const W = 600
  const H = 200
  const padX = 40
  const padTop = 14
  const padBottom = 18
  const min = Math.min(0, ...series.map((p) => p.drawdownPct))
  const span = Math.max(Math.abs(min), 0.01)
  const x = (i: number) => padX + (i * (W - padX * 2)) / (series.length - 1)
  const y = (v: number) => padTop + ((0 - v) / span) * (H - padTop - padBottom)
  const line = series.map((p, i) => `${x(i).toFixed(1)},${y(p.drawdownPct).toFixed(1)}`).join(' ')
  const area = `${padX},${H - padBottom} ${line} ${W - padX},${H - padBottom}`
  const worstIdx = series.reduce((wi, p, i, arr) => (p.drawdownPct < arr[wi].drawdownPct ? i : wi), 0)
  const worst = series[worstIdx]
  const mid = y(-span / 2)

  return (
    <div style={{ height }} className="relative w-full rounded-lg border border-border/60 bg-secondary/10">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-full w-full"
        preserveAspectRatio="none"
        role="img"
        aria-label={`Drawdown curve — worst ${Math.abs(min).toFixed(1)}% below peak`}
      >
        <defs>
          <linearGradient id="dd-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-down)" stopOpacity="0.35" />
            <stop offset="100%" stopColor="var(--color-down)" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {/* 0% baseline and -worst/2 gridline */}
        <line x1={padX} y1={y(0)} x2={W - padX} y2={y(0)} stroke="var(--color-border)" strokeDasharray="3 4" />
        <line x1={padX} y1={mid} x2={W - padX} y2={mid} stroke="var(--color-border)" strokeOpacity={0.5} strokeDasharray="2 5" />
        <polygon points={area} fill="url(#dd-fill)" />
        <polyline points={line} fill="none" stroke="var(--color-down)" strokeWidth="1.75" strokeLinejoin="round" />
        <circle
          cx={x(worstIdx)}
          cy={y(worst.drawdownPct)}
          r="4"
          fill="var(--color-down)"
          stroke="var(--color-background)"
          strokeWidth="1.5"
        />
      </svg>
      <span className="pointer-events-none absolute left-2 top-1.5 text-[10px] font-medium text-muted-foreground">
        0%
      </span>
      <span className="pointer-events-none absolute bottom-2 left-2 text-[10px] font-medium text-muted-foreground">
        −{Math.abs(min).toFixed(1)}%
      </span>
    </div>
  )
}

/* --------------------------------- Page ---------------------------------- */

export function Analytics() {
  const { user } = useAuth()
  const [perf, setPerf] = useState<RobotPerformance | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!user) {
      setLoading(false)
      return
    }
    void loadRobotHistory(user.id).then((p) => {
      setPerf(p)
      setLoading(false)
    })
  }, [user?.id])

  const sessions = perf?.sessions ?? []
  const history = perf?.history ?? []
  const stats = computeSessionStats(sessions)
  const metrics = computeDeepMetrics(history)
  const health = robotHealthScore(metrics, stats)
  const hasData = sessions.length > 0 || history.length > 1

  const returnCards: MetricItem[] = [
    {
      label: 'Net return',
      value: metrics ? fmtPct(metrics.returnPct) : '—',
      tone: metrics ? (metrics.returnPct >= 0 ? 'up' : 'down') : 'neutral',
    },
    {
      label: 'Profit factor',
      value: fmtInf(stats.profitFactor, stats.finished > 0),
      tone: stats.profitFactor == null ? (stats.finished > 0 ? 'accent' : 'neutral') : stats.profitFactor >= 1.5 ? 'up' : stats.profitFactor >= 1 ? 'accent' : 'down',
    },
    {
      label: 'Win rate',
      value: fmtPct(stats.winRate, 1),
      tone: stats.winRate == null ? 'neutral' : stats.winRate >= 50 ? 'up' : 'down',
    },
    {
      label: 'Expectancy / session',
      value: stats.expectancy == null ? '—' : formatUsd(stats.expectancy),
      tone: stats.expectancy == null ? 'neutral' : stats.expectancy >= 0 ? 'up' : 'down',
    },
  ]

  const riskCards: MetricItem[] = [
    { label: 'Sharpe (annualized)', value: fmtRatio(metrics?.sharpe), tone: metrics?.sharpe != null ? toneFor(metrics.sharpe, 1, 0) : 'neutral' },
    { label: 'Sortino (annualized)', value: fmtRatio(metrics?.sortino), tone: metrics?.sortino != null ? toneFor(metrics.sortino, 1, 0) : 'neutral' },
    { label: 'Calmar', value: fmtRatio(metrics?.calmar), tone: metrics?.calmar != null ? toneFor(metrics.calmar, 1, 0.5) : 'neutral' },
    {
      label: 'Volatility (annualized)',
      value: metrics ? fmtPct(metrics.volatilityPct, 1) : '—',
      tone: metrics ? (metrics.volatilityPct <= 15 ? 'up' : metrics.volatilityPct >= 25 ? 'down' : 'accent') : 'neutral',
    },
    {
      label: 'Max drawdown',
      value: metrics ? fmtPct(metrics.maxDrawdownPct, 1) : '—',
      tone: metrics ? (Math.abs(metrics.maxDrawdownPct) <= 5 ? 'up' : Math.abs(metrics.maxDrawdownPct) >= 12 ? 'down' : 'accent') : 'neutral',
    },
    { label: 'Finished sessions', value: String(stats.finished), tone: stats.finished >= 30 ? 'up' : stats.finished >= 10 ? 'accent' : 'neutral' },
    {
      label: 'Best session',
      value: stats.bestSession ? formatUsd(stats.bestSession.pnl ?? 0) : '—',
      tone: stats.bestSession ? 'up' : 'neutral',
    },
    {
      label: 'Worst session',
      value: stats.worstSession ? formatUsd(stats.worstSession.pnl ?? 0) : '—',
      tone: stats.worstSession ? 'down' : 'neutral',
    },
  ]

  return (
    <div className="space-y-6">
      <PageHeader
        title="Analytics"
        description="Risk-adjusted performance, drawdown analysis and a health score derived from your robot's trading history."
      />

      {/* Health score hero */}
      <Card>
        <CardContent>
          {loading ? (
            <div className="flex flex-col gap-6 sm:flex-row sm:items-center">
              <Skeleton className="h-36 w-36 rounded-full" />
              <div className="flex-1 space-y-3">
                <Skeleton className="h-5 w-48" />
                <Skeleton className="h-4 w-full max-w-md" />
                <Skeleton className="h-4 w-full max-w-sm" />
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-6 sm:flex-row sm:items-center">
              <HealthRing score={health.score} label={health.label} />
              <div className="flex-1">
                <div className="flex flex-wrap items-center gap-3">
                  <h3 className="font-heading text-lg font-semibold tracking-tight text-foreground">
                    Robot health score
                  </h3>
                  <span className="text-xs text-muted-foreground">
                    {stats.finished} finished sessions · {metrics ? `${metrics.days} day${metrics.days === 1 ? '' : 's'} of equity data` : 'no equity data yet'}
                  </span>
                </div>
                {health.strengths.length === 0 && health.watchouts.length === 0 ? (
                  <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                    Not enough history to score yet — run the robot or a backtest and this panel fills in.
                  </p>
                ) : (
                  <div className="mt-4 grid gap-2 sm:grid-cols-2">
                    {health.strengths.map((s) => (
                      <p key={s} className="flex items-start gap-2 text-sm leading-snug text-up">
                        <TrendingUp className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                        {s}
                      </p>
                    ))}
                    {health.watchouts.map((w) => (
                      <p key={w} className="flex items-start gap-2 text-sm leading-snug text-down">
                        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                        {w}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {loading ? (
        <div className="space-y-6">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : !hasData ? (
        <EmptyState
          icon={<Gauge className="h-6 w-6" aria-hidden="true" />}
          title="No analytics to show yet"
          message="Run the trading robot for a while (or run a backtest) and the health score, risk ratios and drawdown curve will build themselves from the recorded history."
          action={
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Link to="/trading">
                <Button size="sm">
                  <Play className="h-3.5 w-3.5" aria-hidden="true" />
                  Open the robot
                </Button>
              </Link>
              <Link to="/backtester">
                <Button size="sm" variant="secondary">
                  Run a backtest
                </Button>
              </Link>
            </div>
          }
        />
      ) : (
        <>
          {/* Return profile — headline numbers first */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-accent" aria-hidden="true" />
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Return profile</h2>
            </div>
            <MetricsCards items={returnCards} />
          </div>

          {/* Risk & proof */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-accent" aria-hidden="true" />
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Risk &amp; proof</h2>
            </div>
            <MetricsCards items={riskCards} />
          </div>

          {/* Equity + drawdown */}
          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Equity curve</CardTitle>
                <span className="text-xs text-muted-foreground">
                  {history.length > 0
                    ? `${history.length} points · ${formatDateTime(history[0].recorded_at)} → ${formatDateTime(history[history.length - 1].recorded_at)}`
                    : 'no recorded equity points'}
                </span>
              </CardHeader>
              <CardContent>
                <EquityChart points={history.map((h) => ({ time: h.recorded_at, equity: h.equity }))} height={260} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Drawdown curve</CardTitle>
                <span className="text-xs text-muted-foreground">
                  {metrics ? `Peak ${formatUsd(metrics.peak)} · trough ${formatUsd(metrics.endEquity)}` : '—'}
                </span>
              </CardHeader>
              <CardContent>
                <DrawdownChart series={metrics?.drawdownSeries ?? []} height={260} />
              </CardContent>
            </Card>
          </div>

          {/* Per-strategy breakdown */}
          {stats.byStrategy.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>By strategy</CardTitle>
                <span className="text-xs text-muted-foreground">How each strategy contributed to the net result</span>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[640px] text-sm">
                    <caption className="sr-only">Performance breakdown by strategy</caption>
                    <thead>
                      <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                        <th scope="col" className="pb-2 pr-4 font-medium">Strategy</th>
                        <th scope="col" className="pb-2 pr-4 text-right font-medium">Sessions</th>
                        <th scope="col" className="pb-2 pr-4 text-right font-medium">Wins</th>
                        <th scope="col" className="pb-2 pr-4 text-right font-medium">Losses</th>
                        <th scope="col" className="pb-2 pr-4 text-right font-medium">Win rate</th>
                        <th scope="col" className="pb-2 pr-4 text-right font-medium">Net P&amp;L</th>
                        <th scope="col" className="pb-2 text-right font-medium">Profit factor</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.byStrategy.map((row) => (
                        <tr key={row.strategy} className="border-b border-border/50 last:border-b-0">
                          <th scope="row" className="py-2.5 pr-4 text-left font-medium text-foreground">
                            {row.strategy}
                          </th>
                          <td className="tnum py-2.5 pr-4 text-right font-mono">{row.sessions}</td>
                          <td className="tnum py-2.5 pr-4 text-right font-mono text-up">{row.wins}</td>
                          <td className="tnum py-2.5 pr-4 text-right font-mono text-down">{row.losses}</td>
                          <td className="tnum py-2.5 pr-4 text-right font-mono">{fmtPct(row.winRate, 0)}</td>
                          <td
                            className={cn(
                              'tnum py-2.5 pr-4 text-right font-mono font-semibold',
                              row.netPnl >= 0 ? 'text-up' : 'text-down',
                            )}
                          >
                            {formatUsd(row.netPnl)}
                          </td>
                          <td className="tnum py-2.5 text-right font-mono">{fmtInf(row.profitFactor, row.sessions > 0)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  )
}
