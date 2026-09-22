/**
 * LiveProgressGrid — at-a-glance live overview for the /trading hub.
 *
 * One card per workspace (Manual + Robot 1/2/3). Each card shows that lane's
 * live mark-to-market PnL — the running robot's session PnL (equity vs the
 * run's start baseline), otherwise the sum of open positions — and how long it
 * has been running / holding positions. Durations tick every second, prices
 * move with the shared Realtime feed.
 *
 * The grid is purely observational: it reads the same persisted ledgers
 * (loadLocal per slot) and robot run state (run start / session start / run
 * end) that the workspaces themselves write on every change, so it can never
 * desync or double-write an account. Live OANDA / MetaTrader slots are never
 * persisted — they're shown as live-broker lanes with a pointer to the tab
 * instead of stale numbers. Every card links to its workspace.
 */
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Activity, Bot, Hand, Pause, Play, Timer, TrendingDown, TrendingUp } from 'lucide-react'
import { useAuth } from '../../hooks/useAuth'
import { useQuotes } from '../../hooks/useMarketData'
import { equity } from '../../lib/trading/engine'
import { pnlUsd } from '../../lib/trading/risk'
import { loadLocal } from '../../lib/trading/persistence'
import { loadRunEnd, loadRunStart, loadSessionStart } from '../../lib/trading/robotState'
import { WATCHLIST } from '../../lib/watchlist'
import { formatUsd } from '../../lib/format'
import { cn } from '../../lib/cn'
import type { BrokerMode, Position, RatesMap } from '../../lib/trading/types'
import { Badge } from '../ui'

/** Broker-mode key per slot (mirrors usePaperAccount's modeKeyForRobot). */
const MODE_KEY = 'fx-toolkit.broker-mode'
function modeKeyFor(slot: number): string {
  if (slot === 0) return `${MODE_KEY}.manual`
  return slot > 1 ? `${MODE_KEY}.slot-${slot}` : MODE_KEY
}

function readMode(slot: number): BrokerMode {
  try {
    const saved = localStorage.getItem(modeKeyFor(slot))
    if (saved === 'oanda' || saved === 'mt' || saved === 'managed') return saved
  } catch {
    /* noop */
  }
  return 'paper'
}

/** Compact human duration: "45s", "12m 03s", "1h 05m", "2d 3h". */
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const d = Math.floor(s / 86_400)
  const h = Math.floor((s % 86_400) / 3_600)
  const m = Math.floor((s % 3_600) / 60)
  const sec = s % 60
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`
  if (m > 0) return `${m}m ${String(sec).padStart(2, '0')}s`
  return `${sec}s`
}

interface LanePositionRow {
  id: string
  symbol: string
  side: 'long' | 'short'
  pnl: number
  durationMs: number
}

export interface Lane {
  slot: number
  kind: 'manual' | 'robot'
  label: string
  to: string
  /** Non-null when the slot trades a live external broker (never persisted). */
  liveBroker: BrokerMode | null
  running: boolean
  openCount: number
  headlinePnl: number | null
  pnlLabel: string
  durationLabel: string
  /** Seconds left in an auto-run window (null when no end is set). */
  countdownSec: number | null
  hint: string | null
  positions: LanePositionRow[]
}

function positionRow(p: Position, now: number, rates: RatesMap): LanePositionRow {
  const mark = rates[p.symbol] ?? p.entryPrice
  const pnl = pnlUsd(p.side, p.entryPrice, mark, p.units, p.symbol, rates)
  const opened = new Date(p.entryTime).getTime()
  return {
    id: p.id,
    symbol: p.symbol,
    side: p.side,
    pnl,
    durationMs: Number.isFinite(opened) ? Math.max(0, now - opened) : 0,
  }
}

/**
 * Build one lane's snapshot from the persisted ledger + robot run state.
 * `userScope` is the robotState key scope for the slot (mirrors Trading.tsx).
 */
function buildLane(slot: number, now: number, rates: RatesMap, userScope: string | undefined): Lane {
  const kind: Lane['kind'] = slot === 0 ? 'manual' : 'robot'
  const label = kind === 'manual' ? 'Manual' : `Robot ${slot}`
  const base: Lane = {
    slot,
    kind,
    label,
    to: kind === 'manual' ? '/trading' : `/trading?robot=${slot}`,
    liveBroker: null,
    running: false,
    openCount: 0,
    headlinePnl: null,
    pnlLabel: 'Open P&L',
    durationLabel: '—',
    countdownSec: null,
    hint: null,
    positions: [],
  }

  const mode = readMode(slot)
  if (mode === 'oanda' || mode === 'mt') {
    // Live broker mirrors are never persisted locally — show a pointer instead
    // of stale paper numbers.
    return {
      ...base,
      liveBroker: mode,
      running: loadLocal(slot)?.risk.autoTrade ?? false,
      hint: 'Live broker account — open this tab to see its positions and P&L.',
    }
  }

  const account = loadLocal(slot)
  if (!account) {
    return {
      ...base,
      hint:
        kind === 'manual'
          ? 'No manual account yet — open this tab to create one.'
          : 'No account yet — open this tab to create one.',
    }
  }

  const rows = account.positions
    .filter((p) => (kind === 'robot' ? Boolean(p.strategy) && p.strategy !== 'manual' : !p.strategy || p.strategy === 'manual'))
    .map((p) => positionRow(p, now, rates))
  const openPnl = rows.reduce((sum, r) => sum + r.pnl, 0)
  const longest = rows.reduce((max, r) => Math.max(max, r.durationMs), 0)
  const running = kind === 'robot' ? account.risk.autoTrade : rows.length > 0

  // Headline PnL: the running robot's session PnL (equity vs the run baseline),
  // otherwise the sum of open positions (keeps settling after a stop).
  let headlinePnl: number | null = null
  let pnlLabel = 'Open P&L'
  if (kind === 'robot' && running && userScope) {
    const sessionStart = loadSessionStart(userScope)
    if (sessionStart != null) {
      headlinePnl = equity(account, rates) - sessionStart
      pnlLabel = 'Session P&L'
    }
  }
  if (headlinePnl == null) headlinePnl = openPnl

  let durationLabel = '—'
  let countdownSec: number | null = null
  if (kind === 'robot' && running && userScope) {
    const start = loadRunStart(userScope)
    const end = loadRunEnd(userScope)
    if (start != null && start <= now) durationLabel = `Run ${fmtDuration(now - start)}`
    if (end != null) countdownSec = Math.max(0, Math.round((end - now) / 1000))
    if (durationLabel === '—') durationLabel = 'Running'
  } else if (longest > 0) {
    durationLabel = `Held ${fmtDuration(longest)}`
  }

  return {
    ...base,
    running,
    openCount: rows.length,
    headlinePnl,
    pnlLabel,
    durationLabel,
    countdownSec,
    positions: rows,
    hint:
      running && rows.length === 0
        ? kind === 'robot'
          ? 'Robot is live — scanning for setups…'
          : 'No open manual trades yet — use the order form on the tab.'
        : rows.length === 0
          ? kind === 'robot'
            ? 'No open positions — start the robot to trade on signals.'
            : 'No open trades — place an order from the manual tab.'
          : null,
  }
}

/** All four local lanes (Manual + Robot 1/2/3) for the current visitor, using
 *  the same per-slot scope keys Trading.tsx uses (slot 1 keeps the legacy key).
 *  Shared by the /trading hub grid and the global live-progress bar. */
export function buildLanes(rates: RatesMap, now: number, userId: string | undefined): Lane[] {
  const scopeFor = (slot: number): string | undefined => {
    if (slot === 1) return userId
    if (slot > 1) return userId ? `${userId}:slot-${slot}` : `slot-${slot}`
    return undefined
  }
  return [0, 1, 2, 3].map((slot) => buildLane(slot, now, rates, scopeFor(slot)))
}

export function LiveProgressGrid({ embedded = false }: { embedded?: boolean }) {
  const { user } = useAuth()
  const [now, setNow] = useState(() => Date.now())

  // Re-tick every second so durations and countdowns keep moving.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const symbols = useMemo(() => WATCHLIST.map((p) => p.symbol), [])
  const { quotes } = useQuotes(15_000, symbols)
  const rates = useMemo<RatesMap>(() => {
    const r: RatesMap = {}
    for (const q of quotes ?? []) if (q.price != null) r[q.symbol] = q.price
    return r
  }, [quotes])

  const lanes = useMemo(() => buildLanes(rates, now, user?.id), [now, rates, user?.id])

  return (
    <section aria-label="Live trading progress" className={cn('space-y-3', embedded && 'space-y-0')}>
      {!embedded && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
            <Activity className="h-4 w-4 text-accent" aria-hidden="true" />
            Live progress
            <Badge className="ml-0.5 border-up/30 bg-up/10 text-up">
              <span className="h-1.5 w-1.5 animate-pulse-dot rounded-full bg-up" aria-hidden="true" />
              Live
            </Badge>
          </h2>
          <p className="text-[11px] text-muted-foreground">
            P&amp;L marked to the latest quotes · durations tick every second
          </p>
        </div>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {lanes.map((lane) => (
          <LaneCard key={lane.slot} lane={lane} />
        ))}
      </div>
    </section>
  )
}

function LaneCard({ lane }: { lane: Lane }) {
  const Icon = lane.kind === 'manual' ? Hand : Bot
  const pnl = lane.headlinePnl

  return (
    <Link
      to={lane.to}
      aria-label={`${lane.label} — ${lane.running ? (lane.kind === 'manual' ? 'open trades' : 'active') : 'standby'}${
        pnl != null ? `, P&L ${formatUsd(pnl)}` : ''
      }`}
      className={cn(
        'group flex flex-col gap-3 rounded-xl border border-border bg-secondary/30 p-4 transition-all duration-150',
        'hover:border-accent/40 hover:bg-accent/5 active:scale-[0.99]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <span
            className={cn(
              'flex h-7 w-7 shrink-0 items-center justify-center rounded-full',
              lane.kind === 'manual' ? 'bg-accent/15 text-accent' : 'bg-cyan/15 text-cyan',
            )}
          >
            <Icon className="h-4 w-4" aria-hidden="true" />
          </span>
          {lane.label}
        </span>
        {lane.liveBroker ? (
          <Badge className="border-amber/40 bg-amber/10 text-amber">Live · {lane.liveBroker}</Badge>
        ) : lane.running ? (
          <Badge className="border-up/30 bg-up/10 text-up">
            <Play className="h-3 w-3" aria-hidden="true" />
            {lane.kind === 'manual' ? 'Open' : 'Active'}
          </Badge>
        ) : (
          <Badge className="border-border bg-muted text-muted-foreground">
            <Pause className="h-3 w-3" aria-hidden="true" />
            Standby
          </Badge>
        )}
      </div>

      {lane.liveBroker ? (
        <p className="text-xs leading-relaxed text-muted-foreground">{lane.hint}</p>
      ) : (
        <>
          <div className="flex items-end justify-between gap-2">
            <div className="min-w-0">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{lane.pnlLabel}</p>
              {pnl != null ? (
                <p className={cn('flex items-center gap-1 font-mono text-xl font-bold tnum', pnl >= 0 ? 'text-up' : 'text-down')}>
                  {pnl >= 0 ? <TrendingUp className="h-4 w-4 shrink-0" aria-hidden="true" /> : <TrendingDown className="h-4 w-4 shrink-0" aria-hidden="true" />}
                  <span className="truncate">{formatUsd(pnl)}</span>
                </p>
              ) : (
                <p className="font-mono text-xl font-bold text-muted-foreground">—</p>
              )}
            </div>
            {lane.openCount > 0 && (
              <span className="shrink-0 rounded-md border border-border bg-secondary/40 px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                {lane.openCount} open
              </span>
            )}
          </div>

          <div className="flex items-center justify-between gap-2 border-t border-border/60 pt-2 text-[11px] text-muted-foreground">
            <span className="flex min-w-0 items-center gap-1.5">
              <Timer className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true" />
              <span className="truncate">{lane.durationLabel}</span>
            </span>
            {lane.countdownSec != null && (
              <span className="shrink-0 font-mono tnum text-foreground">{fmtDuration(lane.countdownSec * 1000)} left</span>
            )}
          </div>

          {lane.positions.length > 0 ? (
            <ul className="space-y-1.5">
              {lane.positions.slice(0, 3).map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate font-medium text-foreground">{p.symbol}</span>
                    <span
                      className={cn(
                        'shrink-0 rounded px-1 py-px text-[10px] font-semibold',
                        p.side === 'long' ? 'bg-up/15 text-up' : 'bg-down/15 text-down',
                      )}
                    >
                      {p.side === 'long' ? 'LONG' : 'SHORT'}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2 tnum">
                    <span className={cn('font-mono font-semibold', p.pnl >= 0 ? 'text-up' : 'text-down')}>{formatUsd(p.pnl)}</span>
                    <span className="w-16 text-right text-muted-foreground">{fmtDuration(p.durationMs)}</span>
                  </span>
                </li>
              ))}
              {lane.positions.length > 3 && (
                <li className="text-[11px] text-muted-foreground">
                  +{lane.positions.length - 3} more position{lane.positions.length - 3 === 1 ? '' : 's'}
                </li>
              )}
            </ul>
          ) : lane.hint ? (
            <p className="text-xs leading-relaxed text-muted-foreground">{lane.hint}</p>
          ) : null}
        </>
      )}
    </Link>
  )
}