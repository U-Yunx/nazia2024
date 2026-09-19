/**
 * Home — the public landing page shown to visitors. Hero, live watchlist
 * snapshot, the four product pillars, live user stats and a CTA to sign up.
 */
import { Link } from 'react-router-dom'
import {
  ArrowRight,
  BarChart3,
  Bot,
  LineChart,
  ShieldCheck,
  Sparkles,
  Target,
  Users,
} from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import { usePublicUserStats } from '../hooks/usePlatform'
import { useQuotes } from '../hooks/useMarketData'
import { WATCHLIST } from '../lib/watchlist'
import { formatChange, formatPrice } from '../lib/format'
import { cn } from '../lib/cn'
import { Button } from '../components/ui'

const PILLARS = [
  {
    icon: Bot,
    title: 'Robot trading',
    desc: 'Run fully automated strategies on a paper account first, then connect a real broker when you are ready.',
    gradient: 'from-primary/25 to-primary/5 border-primary/20',
  },
  {
    icon: Target,
    title: 'Auto-tune & backtest',
    desc: 'Stress-test any strategy against historical data and let the optimizer pick your best parameters.',
    gradient: 'from-cyan/20 to-cyan/5 border-cyan/20',
  },
  {
    icon: LineChart,
    title: 'Live signals',
    desc: 'Real-time watchlist quotes and indicator-driven signals across forex and crypto pairs.',
    gradient: 'from-amber/20 to-amber/5 border-amber/20',
  },
  {
    icon: ShieldCheck,
    title: 'Risk first',
    desc: 'Per-trade risk limits, trailing stops and daily loss caps protect your balance automatically.',
    gradient: 'from-up/20 to-up/5 border-up/20',
  },
]

export function Home() {
  const { user } = useAuth()
  const { stats } = usePublicUserStats()
  const { quotes } = useQuotes()

  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:py-16">
      {/* Hero */}
      <section className="relative overflow-hidden text-center">
        <div aria-hidden="true" className="pointer-events-none absolute inset-0">
          <div className="absolute -top-24 left-1/2 h-72 w-[560px] -translate-x-1/2 rounded-full bg-primary/22 blur-[110px]" />
          <div className="absolute -right-16 top-40 h-56 w-56 rounded-full bg-accent/14 blur-[90px]" />
          <div className="absolute -left-16 top-64 h-52 w-52 rounded-full bg-cyan/14 blur-[90px]" />
          <div className="absolute bottom-0 right-1/3 h-44 w-44 rounded-full bg-pink/8 blur-[90px]" />
        </div>
        <div className="relative">
        <div className="mx-auto mb-5 inline-flex items-center gap-2 rounded-full border border-accent/30 bg-accent/10 px-4 py-1.5 text-xs font-medium text-accent">
          <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
          AI-assisted trading, risk-first by design
        </div>
        <h1 className="mx-auto max-w-3xl font-heading text-4xl font-bold tracking-tight text-foreground sm:text-5xl">
          Trade markets with a robot that respects your{' '}
          <span className="text-gradient">risk limits</span>
        </h1>
        <p className="mx-auto mt-4 max-w-2xl text-base leading-relaxed text-muted-foreground sm:text-lg">
          ANA24 runs proven strategies on a free paper account, backtests them against history, and
          streams live signals across forex and crypto — then connects to your real broker only when
          you say so.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Link to={user ? '/trading' : '/auth'}>
            <Button size="lg">
              {user ? 'Open trading robot' : 'Start free paper trading'}
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Button>
          </Link>
          <Link to="/packages">
            <Button variant="secondary" size="lg">
              See packages
            </Button>
          </Link>
        </div>

        {/* Stats */}
        <div className="mx-auto mt-10 grid max-w-2xl grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Traders" value={stats.registered.toLocaleString()} />
          <Stat label="Active 24h" value={stats.active_24h.toLocaleString()} />
          <Stat label="Active 7d" value={stats.active_7d.toLocaleString()} />
          <Stat label="Active 30d" value={stats.active_30d.toLocaleString()} />
        </div>
        </div>
      </section>

      {/* Live watchlist snapshot */}
      <section className="mt-14">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-heading text-lg font-semibold text-foreground">Live markets</h2>
          <Link to="/markets" className="flex items-center gap-1 text-sm text-accent hover:underline">
            All pairs <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {WATCHLIST.slice(0, 6).map((p) => {
            const q = quotes?.find((x) => x.symbol === p.symbol)
            const change = q?.percent_change ?? q?.change ?? 0
            return (
              <div
                key={p.symbol}
                className="surface surface-hover flex items-center justify-between rounded-xl border border-border/70 px-4 py-3.5"
              >
                <div>
                  <p className="text-sm font-medium text-foreground">{p.symbol}</p>
                  <p className="text-xs text-muted-foreground">{p.name}</p>
                </div>
                <div className="text-right">
                  <p className="tnum font-mono text-sm">{formatPrice(q?.price)}</p>
                  <p className={cn('tnum font-mono text-xs', change < 0 ? 'text-down' : 'text-up')}>
                    {formatChange(change)}
                  </p>
                </div>
              </div>
            )
          })}
        </div>
      </section>

      {/* Pillars */}
      <section className="mt-16">
        <h2 className="mb-6 text-center font-heading text-2xl font-bold tracking-tight text-foreground">
          Everything you need to trade smarter
        </h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {PILLARS.map((p) => (
            <div
              key={p.title}
              className={cn('surface-hover group rounded-2xl border bg-gradient-to-b p-6', p.gradient)}
            >
              <div className="mb-4 inline-flex h-10 w-10 items-center justify-center rounded-xl border border-border/60 bg-background/50 text-accent shadow-sm transition-transform duration-200 ease-out group-hover:scale-105">
                <p.icon className="h-5 w-5" aria-hidden="true" />
              </div>
              <h3 className="font-heading text-lg font-semibold tracking-tight text-foreground">{p.title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{p.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="relative mt-16 overflow-hidden rounded-2xl border border-border/70 bg-gradient-to-r from-primary/15 via-primary/5 to-primary/15 p-8 text-center shadow-card">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -top-24 left-1/2 h-48 w-96 -translate-x-1/2 rounded-full bg-accent/10 blur-[80px]"
        />
        <div className="relative">
        <BarChart3 className="mx-auto mb-4 h-8 w-8 text-accent" aria-hidden="true" />
        <h2 className="font-heading text-2xl font-bold tracking-tight text-foreground">Start with a free paper account</h2>
        <p className="mx-auto mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">
          No card, no risk. Run one robot on paper trading today, backtest your ideas, and upgrade
          only when you're ready for live markets.
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <Link to={user ? '/trading' : '/auth'}>
            <Button size="lg">
              <Users className="h-4 w-4" aria-hidden="true" />
              Create free account
            </Button>
          </Link>
          <Link to="/help">
            <Button variant="ghost" size="lg">
              Read the docs
            </Button>
          </Link>
        </div>
        </div>
      </section>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="surface surface-hover rounded-xl border border-border/70 px-4 py-3.5">
      <p className="tnum font-mono text-xl font-bold tracking-tight text-foreground">{value}</p>
      <p className="mt-0.5 text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
    </div>
  )
}