/**
 * LiveProgressBar — global sticky live-progress bar.
 *
 * Rendered by Layout on EVERY page, pinned to the bottom of the viewport while
 * scrolling (sticky, so it settles above the footer at the page end and never
 * covers content). It shows the four local workspaces (Manual + Robot 1/2/3)
 * as compact chips — live P&L + run/hold duration, ticking every second — plus
 * a per-registered-user community feed (masked handles only). Expanding the bar
 * opens the full grid (the classic card view) alongside the community list.
 *
 * Reads the same persisted ledgers and robot run state as the workspaces
 * themselves (see LiveProgressGrid.buildLane), so it never desyncs or
 * double-writes an account. The collapsed state is remembered per browser.
 *
 * Auth-gated: rendered only for signed-in users (Layout skips mounting it while
 * signed out / while auth is still resolving, and the guard below is a second
 * line of defence). Anonymous visitors never see workspace P&L or the feed.
 */
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Activity, Bot, ChevronDown, ChevronUp, Hand, Radio, Users } from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import { useQuotes } from '../hooks/useMarketData'
import { useLiveTraders, type LiveTrader } from '../hooks/useLiveCommunity'
import { buildLanes, LiveProgressGrid, type Lane } from './trading/LiveProgressGrid'
import { WATCHLIST } from '../lib/watchlist'
import { formatUsd, timeAgo } from '../lib/format'
import { cn } from '../lib/cn'
import type { RatesMap } from '../lib/trading/types'
import { Badge } from './ui'

const COLLAPSE_KEY = 'ana24.live-bar-collapsed'

function loadCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1'
  } catch {
    return false
  }
}

export function LiveProgressBar() {
  const { user } = useAuth()
  const [now, setNow] = useState(() => Date.now())
  const [collapsed, setCollapsed] = useState(loadCollapsed)
  const { traders } = useLiveTraders(15_000)

  // Durations and countdowns keep moving every second.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  // Remember the collapsed state across reloads.
  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0')
    } catch {
      /* storage blocked — non-fatal */
    }
  }, [collapsed])

  const symbols = useMemo(() => WATCHLIST.map((p) => p.symbol), [])
  const { quotes } = useQuotes(15_000, symbols)
  const rates = useMemo<RatesMap>(() => {
    const r: RatesMap = {}
    for (const q of quotes ?? []) if (q.price != null) r[q.symbol] = q.price
    return r
  }, [quotes])

  const lanes = useMemo(() => buildLanes(rates, now, user?.id), [now, rates, user?.id])
  const activeLanes = lanes.filter((l) => l.running).length
  const communityLive = traders.filter((t) => t.open_trades > 0 || t.active_robots > 0)

  // Defence in depth (all hooks above run unconditionally, so hook order is
  // stable): never render the bar for an anonymous visitor.
  if (!user) return null

  return (
    <div className="sticky bottom-0 z-40">
      {!collapsed && (
        <div
          id="live-progress-panel"
          className="absolute inset-x-0 bottom-full"
          role="region"
          aria-label="Live progress details"
        >
          <div className="border-t border-border/70 bg-background/95 shadow-[0_-18px_48px_-24px_rgb(0_0_0/0.65)] backdrop-blur-xl">
            <div className="mx-auto max-w-7xl px-4 pb-3 pt-4 sm:px-6">
              <div className="max-h-[min(72vh,34rem)] overflow-y-auto">
                <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_19rem]">
                  {/* Your workspaces — the full grid */}
                  <div className="min-w-0">
                    <div className="mb-3 flex items-center justify-between gap-2">
                      <h2 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                        <Activity className="h-4 w-4 text-accent" aria-hidden="true" />
                        Your workspaces
                      </h2>
                      <Link
                        to="/trading"
                        className="cursor-pointer text-xs font-medium text-accent transition-colors duration-150 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                      >
                        Open trading hub →
                      </Link>
                    </div>
                    <LiveProgressGrid embedded />
                  </div>

                  {/* Registered users — masked community feed */}
                  <aside className="min-w-0" aria-label="Registered traders now">
                    <CommunityList traders={communityLive} signedIn={Boolean(user)} />
                  </aside>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* The bar itself */}
      <div className="surface-premium border-t border-border/70">
        <div className="mx-auto flex max-w-7xl items-center gap-2 px-3 py-2 sm:gap-3 sm:px-6">
          <div className="flex shrink-0 items-center gap-1.5">
            <Activity className="h-4 w-4 text-accent" aria-hidden="true" />
            <span className="hidden text-xs font-semibold text-foreground sm:inline">Live progress</span>
            <Badge className="ml-0.5 border-up/30 bg-up/10 text-up">
              <span className="h-1.5 w-1.5 animate-pulse-dot rounded-full bg-up" aria-hidden="true" />
              Live
            </Badge>
          </div>

          {/* Local workspace chips (scrollable on small screens) */}
          <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto py-0.5 [scrollbar-width:thin]">
            {lanes.map((lane) => (
              <LaneChip key={lane.slot} lane={lane} />
            ))}
            {activeLanes === 0 && (
              <p className="shrink-0 text-[11px] text-muted-foreground">
                All workspaces on standby — open the trading hub to start a robot.
              </p>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
            {communityLive.length > 0 && (
              <span className="hidden items-center gap-1 text-[11px] font-medium text-muted-foreground lg:flex">
                <Users className="h-3.5 w-3.5 text-accent" aria-hidden="true" />
                {communityLive.length} trader{communityLive.length === 1 ? '' : 's'} live
              </span>
            )}
            <button
              type="button"
              onClick={() => setCollapsed((v) => !v)}
              aria-expanded={!collapsed}
              aria-controls="live-progress-panel"
              aria-label={collapsed ? 'Show live progress' : 'Hide live progress'}
              className={cn(
                'inline-flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-border bg-secondary/40 text-foreground transition-colors duration-150 ease-out hover:bg-muted',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background active:scale-[0.97]',
              )}
            >
              {collapsed ? (
                <ChevronUp className="h-4 w-4" aria-hidden="true" />
              ) : (
                <ChevronDown className="h-4 w-4" aria-hidden="true" />
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/** Compact one-line workspace chip for the bar. */
function LaneChip({ lane }: { lane: Lane }) {
  const Icon = lane.kind === 'manual' ? Hand : Bot
  const pnl = lane.headlinePnl
  return (
    <Link
      to={lane.to}
      aria-label={`${lane.label} — ${lane.running ? (lane.kind === 'manual' ? 'open trades' : 'active') : 'standby'}${
        pnl != null ? `, P&L ${formatUsd(pnl)}` : ''
      }`}
      className={cn(
        'group flex shrink-0 cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-1.5 transition-all duration-150',
        'hover:border-accent/40 hover:bg-accent/5 active:scale-[0.97]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        lane.running ? 'border-up/30 bg-up/5' : 'border-border bg-secondary/40',
      )}
    >
      <span
        className={cn(
          'flex h-6 w-6 shrink-0 items-center justify-center rounded-full',
          lane.kind === 'manual' ? 'bg-accent/15 text-accent' : 'bg-cyan/15 text-cyan',
        )}
      >
        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      </span>
      <span className="text-xs font-semibold text-foreground">{lane.label}</span>
      {pnl != null ? (
        <span className={cn('tnum font-mono text-xs font-bold', pnl >= 0 ? 'text-up' : 'text-down')}>
          {formatUsd(pnl)}
        </span>
      ) : (
        <span className="text-xs text-muted-foreground">—</span>
      )}
      <span className="hidden text-[11px] text-muted-foreground md:inline">{lane.durationLabel}</span>
    </Link>
  )
}

/** Registered users' live progress — masked handles, live P&L and activity. */
function CommunityList({ traders, signedIn }: { traders: LiveTrader[]; signedIn: boolean }) {
  return (
    <div>
      <h3 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
        <Users className="h-4 w-4 text-accent" aria-hidden="true" />
        Traders now
      </h3>
      <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
        Registered users, live right now · names masked for privacy
      </p>

      {traders.length === 0 ? (
        <div className="mt-2 rounded-xl border border-dashed border-border bg-secondary/20 px-3 py-4 text-center">
          <Radio className="mx-auto h-4 w-4 text-muted-foreground/60" aria-hidden="true" />
          <p className="mt-1.5 text-xs font-medium text-foreground">No registered traders online right now</p>
          <p className="mx-auto mt-0.5 max-w-[16rem] text-[11px] leading-relaxed text-muted-foreground">
            {signedIn
              ? 'Start a robot or open a manual position and you will appear here.'
              : 'Sign in and start a robot to appear here.'}
          </p>
        </div>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {traders.slice(0, 6).map((t, i) => {
            const busy = t.open_trades > 0 || t.active_robots > 0
            return (
              <li
                key={`${t.handle}-${i}`}
                className="flex items-center justify-between gap-2 rounded-lg border border-border/60 bg-secondary/30 px-2.5 py-2"
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  {busy ? (
                    <Radio className="h-3 w-3 shrink-0 animate-pulse-dot text-up" aria-hidden="true" />
                  ) : (
                    <span className="h-3 w-3 shrink-0 rounded-full bg-muted" aria-hidden="true" />
                  )}
                  <span className="truncate text-xs font-medium text-foreground">{t.handle}</span>
                </span>
                <span className="flex shrink-0 items-center gap-2 tnum text-[11px]">
                  <span className={cn('font-mono font-semibold', t.pnl >= 0 ? 'text-up' : 'text-down')}>
                    {formatUsd(t.pnl)}
                  </span>
                  {t.open_trades > 0 && <span className="text-muted-foreground">{t.open_trades} open</span>}
                  {t.active_robots > 0 && <span className="text-muted-foreground">{t.active_robots} robot</span>}
                  <span className="hidden text-muted-foreground sm:inline">· {timeAgo(t.last_seen)}</span>
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}