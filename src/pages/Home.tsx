/**
 * Home — the public landing page shown to visitors. Hero, live watchlist
 * snapshot, the four product pillars, live user stats and a CTA to sign up.
 */
import { Link } from 'react-router-dom'
import {
  ArrowRight,
  BarChart3,
  Bot,
  Download,
  LineChart,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Target,
  Trophy,
  Users,
} from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import { usePublicUserStats } from '../hooks/usePlatform'
import { useQuotes } from '../hooks/useMarketData'
import { useLeaderboard } from '../hooks/useLiveCommunity'
import { WATCHLIST } from '../lib/watchlist'
import { formatChange, formatPrice, formatUsd, timeAgo } from '../lib/format'
import { cn } from '../lib/cn'
import { useAndroidRelease } from '../lib/androidRelease'
import { Button, buttonClasses } from '../components/ui'

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
  const { entries } = useLeaderboard(6, 60_000)

  // The Android CTA becomes a real download the moment a signed APK has been
  // published (see scripts/publish-apk.mjs); until then it links to the build
  // guide on the Help page. No rebuild needed to flip between the two.
  const android = useAndroidRelease()

  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:py-16">
      {/* Hero */}
      <section className="relative overflow-hidden text-center">
        <div aria-hidden="true" className="pointer-events-none absolute inset-0">
          <div className="absolute -top-24 left-1/2 h-72 w-[560px] -translate-x-1/2 rounded-full bg-primary/20 blur-[110px]" />
          <div className="absolute -right-16 top-40 h-56 w-56 rounded-full bg-accent/12 blur-[90px]" />
          <div className="absolute -left-16 top-64 h-52 w-52 rounded-full bg-cyan/12 blur-[90px]" />
          <div className="absolute bottom-0 right-1/3 h-44 w-44 rounded-full bg-pink/6 blur-[90px]" />
        </div>
        <div className="relative">
        <div className="surface-premium mx-auto mb-5 inline-flex items-center gap-2 rounded-full border border-accent/30 px-4 py-1.5 text-xs font-medium text-accent">
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
                className="surface-premium surface-hover flex items-center justify-between rounded-xl border border-border/70 px-4 py-3.5"
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

      {/* Public profit-history leaderboard — masked handles, no PII */}
      <section className="mt-14">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 font-heading text-lg font-semibold text-foreground">
              <Trophy className="h-5 w-5 text-amber" aria-hidden="true" />
              Top profit history
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Highest single win ever banked by a registered trader. Handles are masked for privacy.
            </p>
          </div>
          <Link
            to={user ? '/trading' : '/auth'}
            className="flex items-center gap-1 text-sm text-accent hover:underline"
          >
            {user ? 'Open trading' : 'Start trading'} <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        </div>

        {entries.length === 0 ? (
          <div className="surface-premium rounded-xl border border-border/70 px-5 py-10 text-center">
            <Trophy className="mx-auto h-7 w-7 text-muted-foreground/60" aria-hidden="true" />
            <p className="mt-3 text-sm font-semibold text-foreground">No public profit history yet</p>
            <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-muted-foreground">
              The board fills up as registered traders bank their first wins. Start a robot on a free
              paper account and claim the top spot.
            </p>
          </div>
        ) : (
          <ol className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {entries.slice(0, 6).map((e, i) => (
              <li
                key={`${e.handle}-${i}`}
                className="surface-premium surface-hover flex items-center justify-between gap-3 rounded-xl border border-border/70 px-4 py-3.5"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <span
                    className={cn(
                      'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold tnum',
                      i === 0 ? 'bg-amber/20 text-amber' : 'bg-secondary text-muted-foreground',
                    )}
                  >
                    {i + 1}
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-foreground">{e.handle}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {e.events} win{e.events === 1 ? '' : 's'} · {timeAgo(e.last_seen)}
                    </p>
                  </div>
                </div>
                <p
                  className={cn(
                    'shrink-0 tnum font-mono text-base font-bold',
                    e.best_profit >= 0 ? 'text-up' : 'text-down',
                  )}
                >
                  {formatUsd(e.best_profit)}
                </p>
              </li>
            ))}
          </ol>
        )}
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
              className={cn(
                'surface-premium surface-hover group rounded-2xl border bg-gradient-to-b p-6',
                p.gradient,
              )}
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

      {/* Android app CTA */}
      <section className="mt-14">
        <div className="surface-premium surface-hover relative flex flex-col gap-5 overflow-hidden rounded-2xl border border-accent/25 p-6 sm:flex-row sm:items-center sm:justify-between sm:p-7">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -right-10 -top-16 h-40 w-40 rounded-full bg-accent/10 blur-[70px]"
          />
          <div className="relative flex items-start gap-4">
            <div className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-background/50 text-accent shadow-sm">
              <Smartphone className="h-5 w-5" aria-hidden="true" />
            </div>
            <div>
              <h2 className="font-heading text-lg font-semibold tracking-tight text-foreground">
                Get the Android app
              </h2>
              <p className="mt-1 max-w-md text-sm leading-relaxed text-muted-foreground">
                {android.release
                  ? `ANA24 ships as a native Android build of this exact app — same dashboard, same robot, and it keeps working offline. Download v${android.release.version} and install it straight from your phone.`
                  : 'ANA24 ships as a native Android build of this exact app — same dashboard, same robot, and it keeps working offline. Build the signed APK from the repo — no Play Store account needed.'}
              </p>
            </div>
          </div>
          {android.release && android.href ? (
            <div className="relative flex shrink-0 flex-wrap items-center gap-2">
              <a
                href={android.href}
                download={android.release.file}
                className={buttonClasses('primary')}
              >
                <Download className="h-4 w-4" aria-hidden="true" />
                Download APK
              </a>
              <Link to="/help#android">
                <Button variant="secondary">Install guide</Button>
              </Link>
            </div>
          ) : (
            <Link to="/help#android" className="relative shrink-0">
              <Button variant="secondary">
                Build the APK
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Button>
            </Link>
          )}
        </div>
      </section>

      {/* CTA */}
      <section className="surface-premium relative mt-16 overflow-hidden rounded-2xl border border-primary/25 p-8 text-center shadow-[0_24px_60px_-24px_color-mix(in_oklab,var(--color-primary)_45%,transparent)]">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -top-24 left-1/2 h-48 w-96 -translate-x-1/2 rounded-full bg-accent/12 blur-[80px]"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_50%_at_50%_0%,color-mix(in_oklab,var(--color-primary)_14%,transparent),transparent)]"
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
    <div className="surface-premium surface-hover rounded-xl border border-border/70 px-4 py-3.5">
      <p className="tnum font-mono text-xl font-bold tracking-tight text-foreground">{value}</p>
      <p className="mt-0.5 text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
    </div>
  )
}