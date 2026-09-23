/**
 * Robots — the robot-slot command center.
 *
 * Every user gets up to three robot slots. Each slot owns its own paper /
 * managed ledger, its own saved configuration (method, pairs, sizing, risk,
 * limits) and its own activity feed — so you can run a scalper and a
 * long-term robot side by side without them sharing a balance or stepping on
 * each other's trades. Slot 1 keeps the classic single-robot behaviour (and
 * all existing saved data); slots 2 and 3 are namespaced copies.
 *
 * Unlike a plain list of links, this page IS the control surface: every slot
 * card shows live state (running / standby, balance, open positions, last
 * run, auto-run countdown) and the active slot embeds the full control room
 * right below the fleet — the same start confirmation, risk panel, positions
 * table and journal as /trading, so you can configure and run a robot without
 * leaving the page.
 */
import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Activity,
  Bot,
  ChevronRight,
  Clock,
  Layers,
  Loader2,
  Lock,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Wallet,
  X,
} from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../hooks/useAuth'
import { loadLocal } from '../lib/trading/persistence'
import { loadRobotPrefs, methodLabel } from '../lib/trading/robotPrefs'
import { loadActivityLog, loadLastRun, type ActivityEntry } from '../lib/trading/robotActivity'
import { loadRobotRunning, loadRunEnd } from '../lib/trading/robotState'
import { WATCHLIST } from '../lib/watchlist'
import { timeAgo, formatUsd } from '../lib/format'
import { cn } from '../lib/cn'
import { Badge, Button, Card, CardContent, PageHeader, Skeleton } from '../components/ui'
import type { AccountState } from '../lib/trading/types'

export const MAX_ROBOT_SLOTS = 3
const SLOTS = [1, 2, 3] as const

/** The slots a signed-in user may run (slot 1 is always available). */
export function robotSlots(): number[] {
  const slots: number[] = []
  for (let n = 1; n <= MAX_ROBOT_SLOTS; n++) slots.push(n)
  return slots
}

/** The localStorage/Supabase scope id for a robot slot — must match the
 *  control room (src/pages/Trading.tsx): slot 1 keeps the legacy per-user
 *  keys, slots 2..N are namespaced per user. */
function scopeIdFor(userId: string | undefined, slot: number): string | undefined {
  if (slot === 1) return userId
  return userId ? `${userId}:slot-${slot}` : `slot-${slot}`
}

function robotTarget(slot: number): string {
  return `/trading?robot=${slot}`
}

/** Server-side ledger row for a slot (authoritative balance when this browser
 *  has never opened the slot — e.g. it was started on another device). */
interface SlotRow {
  robot_number: number
  broker: string
  balance: number
  initial_balance: number
  updated_at: string | null
}

/** Live, per-slot snapshot merged from local state + the server ledger. */
interface SlotView {
  slot: number
  account: AccountState | null
  row: SlotRow | null
  running: boolean
  lastRun: number | null
  activity: ActivityEntry[]
  runEnd: number | null
}

function buildSlot(userId: string | undefined, slot: number, row: SlotRow | null): SlotView {
  const scope = scopeIdFor(userId, slot)
  const account = loadLocal(slot)
  return {
    slot,
    account,
    row,
    running: account?.risk.autoTrade === true || loadRobotRunning(scope),
    lastRun: loadLastRun(scope),
    activity: loadActivityLog(scope),
    runEnd: loadRunEnd(scope),
  }
}

function fmtDuration(minutes: number | null): string {
  if (minutes == null) return 'Until stopped'
  if (minutes < 60) return `${minutes} min`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m > 0 ? `${h}h ${m}m` : `${h}h`
}

// The control room is heavy (charts, engine, brokers), so it loads lazily only
// when a slot is expanded — the fleet itself stays light.
const TradingRoom = lazy(() => import('./Trading').then((m) => ({ default: m.Trading })))

export function Robots() {
  const { user } = useAuth()
  const [rows, setRows] = useState<SlotRow[] | null>(null)
  // The slot whose full control room is embedded below the fleet (null = none).
  const [activeSlot, setActiveSlot] = useState<number | null>(null)
  // Keep-alive control rooms. A slot's control room is mounted the first time
  // it is opened and STAYS mounted afterwards — inactive rooms are hidden, never
  // unmounted. This is what keeps a running robot alive when you switch slots:
  // its engine loop, quote stream, heartbeat and live-broker connection keep
  // running in the background, so opening Robot 2 never stops Robot 1.
  const [visitedSlots, setVisitedSlots] = useState<Set<number>>(() => new Set())
  const openSlot = (slot: number) => {
    setActiveSlot((cur) => (cur === slot ? null : slot))
    setVisitedSlots((prev) => {
      if (prev.has(slot)) return prev
      const next = new Set(prev)
      next.add(slot)
      return next
    })
  }

  // Authoritative server ledger rows (signed-in users only).
  const loadRows = () => {
    if (!user) {
      setRows([])
      return
    }
    void (async () => {
      const { data } = await supabase
        .from('paper_accounts')
        .select('robot_number, broker, balance, initial_balance, updated_at')
        .eq('user_id', user.id)
        .order('robot_number', { ascending: true })
      setRows((data as unknown as SlotRow[] | null) ?? [])
    })()
  }
  useEffect(loadRows, [user?.id])
  // Fresh snapshot every 10s + manual refresh — a robot can start or stop on
  // the control room (or in another tab), so the fleet should keep up.
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 10_000)
    return () => clearInterval(id)
  }, [])

  const bySlot = useMemo(() => {
    const m = new Map<number, SlotRow>()
    for (const r of rows ?? []) m.set(r.robot_number, r)
    return m
  }, [rows])

  const slots = useMemo<SlotView[]>(
    () => SLOTS.map((n) => buildSlot(user?.id, n, bySlot.get(n) ?? null)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [user?.id, bySlot, tick],
  )

  const fleet = useMemo(() => {
    const active = slots.filter((s) => s.running).length
    const openPositions = slots.reduce((sum, s) => sum + (s.account?.positions.length ?? 0), 0)
    const totalBalance = slots.reduce(
      (sum, s) => sum + (s.account?.balance ?? s.row?.balance ?? 0),
      0,
    )
    const totalTrades = slots.reduce((sum, s) => sum + (s.account?.trades.length ?? 0), 0)
    return { active, openPositions, totalBalance, totalTrades }
  }, [slots])

  // Newest entries across all slots, newest first.
  const recentActivity = useMemo(
    () =>
      slots
        .flatMap((s) => s.activity.map((e) => ({ ...e, slot: s.slot })))
        .sort((a, b) => b.t - a.t)
        .slice(0, 12),
    [slots],
  )

  const loading = rows == null

  return (
    <div className="space-y-6">
      <PageHeader
        title="Your robots"
        description="Every slot is a fully independent trading robot — its own paper or managed ledger, its own method, pairs, sizing, risk and limits. A scalper on slot 1 and a long-term swing robot on slot 2 never share a balance or touch each other's trades. Pick a slot below to run it right here."
        actions={
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setTick((t) => t + 1)
              loadRows()
            }}
            aria-label="Refresh robot statuses"
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            Refresh
          </Button>
        }
      />

      {/* Fleet summary */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Fleet summary">
        {[
          {
            label: 'Active robots',
            value: `${fleet.active} / ${SLOTS.length}`,
            icon: Play,
            tone: fleet.active > 0 ? 'text-up' : 'text-muted-foreground',
          },
          { label: 'Open positions', value: String(fleet.openPositions), icon: Layers, tone: 'text-accent' },
          { label: 'Combined balance', value: formatUsd(fleet.totalBalance), icon: Wallet, tone: 'text-accent' },
          { label: 'Total trades', value: String(fleet.totalTrades), icon: Activity, tone: 'text-accent' },
        ].map((s) => (
          <Card key={s.label}>
            <CardContent>
              <div className="flex items-center gap-3">
                <div className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-secondary/60', s.tone)}>
                  <s.icon className="h-4 w-4" aria-hidden="true" />
                </div>
                <div className="min-w-0">
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{s.label}</p>
                  <p className="truncate text-lg font-bold tnum">{s.value}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {loading && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-64 rounded-2xl" />
          ))}
        </div>
      )}

      {/* Robot slot cards */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {slots.map((s) => {
          const account = s.account
          const serverRow = s.row
          const prefs = loadRobotPrefs(s.slot)
          const hasAccount = Boolean(account) || Boolean(serverRow)
          const balance = account?.balance ?? serverRow?.balance
          const openPositions = account?.positions.length ?? 0
          const tradesCount = account?.trades.length ?? 0
          const expanded = activeSlot === s.slot
          const autoEndsSoon = s.running && s.runEnd != null && s.runEnd > Date.now()
          return (
            <Card
              key={s.slot}
              className={cn(
                'relative overflow-hidden transition-all duration-200 hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-lg',
                s.running && 'border-up/30',
                expanded && 'border-accent/60 ring-1 ring-accent/30',
              )}
            >
              {/* Slot accent rail */}
              <span
                aria-hidden="true"
                className={cn(
                  'absolute inset-y-0 left-0 w-1',
                  s.running ? 'bg-up' : hasAccount ? 'bg-accent/50' : 'bg-border',
                )}
              />
              <CardContent className="space-y-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2.5">
                    <span
                      className={cn(
                        'flex h-9 w-9 shrink-0 items-center justify-center rounded-full',
                        s.running ? 'bg-up/15 text-up' : 'bg-secondary/60 text-accent',
                      )}
                    >
                      <Bot className="h-4 w-4" aria-hidden="true" />
                    </span>
                    <div>
                      <h2 className="text-sm font-semibold text-foreground">
                        Robot {s.slot}
                        {s.slot === 1 && <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">(classic)</span>}
                      </h2>
                      <p className="text-[11px] text-muted-foreground">
                        {hasAccount ? `${methodLabel(prefs.method)} · ${prefs.tradeMode} mode` : 'Empty slot — open it to start'}
                      </p>
                    </div>
                  </div>
                  {s.running ? (
                    <Badge className="border-up/30 bg-up/15 text-up">
                      <span className="h-1.5 w-1.5 animate-pulse-dot rounded-full bg-up" aria-hidden="true" />
                      Active
                    </Badge>
                  ) : hasAccount ? (
                    <Badge className="border-border bg-muted text-muted-foreground">
                      <Pause className="h-3 w-3" aria-hidden="true" />
                      Standby
                    </Badge>
                  ) : (
                    <Badge className="border-border bg-muted text-muted-foreground">Free</Badge>
                  )}
                </div>

                {hasAccount ? (
                  <>
                    <div className="grid grid-cols-3 gap-2">
                      <div className="rounded-lg border border-border bg-secondary/30 px-2.5 py-2">
                        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Balance</p>
                        <p className="mt-0.5 truncate text-sm font-bold tnum text-foreground">{formatUsd(balance ?? 0)}</p>
                      </div>
                      <div className="rounded-lg border border-border bg-secondary/30 px-2.5 py-2">
                        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Open</p>
                        <p className="mt-0.5 truncate text-sm font-bold tnum text-foreground">{openPositions}</p>
                      </div>
                      <div className="rounded-lg border border-border bg-secondary/30 px-2.5 py-2">
                        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Trades</p>
                        <p className="mt-0.5 truncate text-sm font-bold tnum text-foreground">{tradesCount}</p>
                      </div>
                    </div>

                    <ul className="space-y-1.5 text-xs text-muted-foreground">
                      <li className="flex items-center justify-between gap-2">
                        <span>Strategy</span>
                        <span className="font-medium text-foreground">
                          {prefs.strategyMode === 'manual' ? 'Manual (one method)' : 'Auto — best method'}
                        </span>
                      </li>
                      <li className="flex items-center justify-between gap-2">
                        <span>Pairs</span>
                        <span className="font-medium text-foreground">
                          {prefs.autoPickPairs
                            ? `Top ${Math.min(prefs.pairCount, 10)} of ${WATCHLIST.length} (auto)`
                            : `${prefs.pairs.length > 0 ? prefs.pairs.length : 2} selected`}
                        </span>
                      </li>
                      <li className="flex items-center justify-between gap-2">
                        <span>Auto-run</span>
                        <span className="font-medium text-foreground">{fmtDuration(prefs.durationMinutes)}</span>
                      </li>
                    </ul>

                    <div className="flex items-center justify-between gap-2 border-t border-border pt-3">
                      <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                        <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                        {s.lastRun ? `Last run ${timeAgo(s.lastRun)}` : 'Never run'}
                      </span>
                      {autoEndsSoon && (
                        <span className="text-[11px] text-amber">
                          Ends {new Date(s.runEnd ?? 0).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-secondary/20 px-4 py-6 text-center">
                    <Plus className="h-5 w-5 text-accent" aria-hidden="true" />
                    <p className="text-xs text-muted-foreground">
                      This slot is free. Open it to create its own paper or managed account — the robot starts from
                      your chosen balance and keeps a separate journal and settings.
                    </p>
                  </div>
                )}

                {/* In-page control — expands the full control room for this slot. */}
                <Button variant={expanded ? 'secondary' : 'primary'} size="sm" className="w-full" onClick={() => openSlot(s.slot)}>
                  {expanded ? (
                    <>
                      <X className="h-4 w-4" aria-hidden="true" />
                      Collapse control room
                    </>
                  ) : hasAccount ? (
                    <>
                      <Play className="h-4 w-4" aria-hidden="true" />
                      Open &amp; control
                    </>
                  ) : (
                    <>
                      <Plus className="h-4 w-4" aria-hidden="true" />
                      Create this robot
                    </>
                  )}
                </Button>
              </CardContent>
            </Card>
          )
        })}
      </div>

      {/* Embedded control rooms — the real Trading UI, no navigation needed.
          Keep-alive: each opened slot's room stays mounted (hidden while
          inactive), so a running robot never stops when you switch slots.
          Collapsed rooms are hidden, not unmounted. */}
      {[...visitedSlots].map((slot) => {
        const isActive = activeSlot === slot
        return (
          <section
            key={slot}
            hidden={!isActive}
            aria-label={`Robot ${slot} control room`}
            className="space-y-3"
          >
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm text-muted-foreground">
                <ChevronRight className="mr-1 inline h-4 w-4 text-accent" aria-hidden="true" />
                Controlling <span className="font-semibold text-foreground">Robot {slot}</span> — every change
                saves to this slot only. For a distraction-free view, open it full-screen:
              </p>
              <Link to={robotTarget(slot)} className="shrink-0">
                <Button variant="secondary" size="sm">
                  Full screen
                  <ChevronRight className="h-4 w-4" aria-hidden="true" />
                </Button>
              </Link>
            </div>
            <Suspense
              fallback={
                <div className="flex min-h-[40vh] items-center justify-center" role="status" aria-label="Loading control room">
                  <Loader2 className="h-6 w-6 animate-spin text-accent" aria-hidden="true" />
                </div>
              }
            >
              <TradingRoom slot={slot} />
            </Suspense>
          </section>
        )
      })}

      {/* Recent fleet activity */}
      <Card>
        <CardContent>
          <h2 className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-foreground">
            <Activity className="h-4 w-4 text-accent" aria-hidden="true" />
            Recent fleet activity
          </h2>
          {recentActivity.length > 0 ? (
            <ul className="max-h-56 space-y-1.5 overflow-y-auto pr-1">
              {recentActivity.map((e, i) => (
                <li
                  key={`${i}-${e.t}-${e.slot}`}
                  className="flex items-start gap-2 rounded-md bg-muted/40 px-3 py-1.5 font-mono text-xs tnum"
                >
                  <Badge className="shrink-0 border-accent/40 bg-accent/10 px-1.5 text-[10px] text-accent">
                    R{e.slot}
                  </Badge>
                  <span className="shrink-0 whitespace-nowrap text-muted-foreground">{timeAgo(e.t)}</span>
                  <span>{e.m}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border bg-secondary/20 px-4 py-8 text-center">
              <Bot className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
              <p className="text-sm font-medium text-foreground">No robot activity yet</p>
              <p className="max-w-sm text-xs text-muted-foreground">
                Start any robot from its slot above and every signal, trade and stop will land here — plus in the
                slot's own activity feed inside its control room.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* How slots work */}
      <div className="rounded-xl border border-border bg-secondary/30 p-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Lock className="h-4 w-4 text-accent" aria-hidden="true" />
          How slots work
        </h2>
        <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
          <li>
            <span className="font-semibold text-foreground">Independent ledgers.</span> Each slot owns its own balance
            and trade journal — robot 2 starts from a fresh balance and its trades never mix with robot 1's.
          </li>
          <li>
            <span className="font-semibold text-foreground">Independent settings.</span> Method, pairs, sizing, risk and
            session limits are saved per slot, so you can run a scalper and a long-term robot side by side.
          </li>
          <li>
            <span className="font-semibold text-foreground">Background continuation.</span> Every slot's paper/managed
            robot keeps trading server-side when you close the tab, exactly like the classic robot — each with its own
            run, session and history.
          </li>
          <li>
            <span className="font-semibold text-foreground">Slots are yours.</span> Backed up to your profile, so
            switching devices brings all three robots back.
          </li>
        </ul>
      </div>
    </div>
  )
}