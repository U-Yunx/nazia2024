import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Activity, Check, ListChecks, Lock, Pause, Play, ShieldAlert, Sliders, Sparkles, Target, Timer, Wallet } from 'lucide-react'
import { DEFAULT_PAPER_BALANCE, usePaperAccount } from '../lib/trading/usePaperAccount'
import { useRobotPrefs, methodInterval, methodLabel, methodRiskDefaults } from '../lib/trading/robotPrefs'
import { useRobotRecorder } from '../lib/trading/useRobotRecorder'
import { clearRobotRunning, clearRunEnd, clearSessionStart, loadRunEnd, loadSessionStart, saveRunEnd, saveSessionStart } from '../lib/trading/robotState'
import {
  clearActivity,
  loadActivityLog,
  loadLastRun,
  saveActivityLog,
  saveLastRun,
  MAX_ACTIVITY,
  type ActivityEntry,
} from '../lib/trading/robotActivity'
import { heartbeatRobotRun, loadRobotRun, saveRobotRun, stopRobotRun } from '../lib/trading/robotRun'
import { autoTune } from '../lib/trading/autoTune'
import { proStrategyPreset, type StrategyPreset } from '../lib/trading/strategyPresets'
import { aggressivenessLabel, guardrailLabel, useManualTune } from '../lib/trading/manualTune'
import { rankPairs, type RankedPair } from '../lib/trading/pairRanking'
import { manualTargets } from '../lib/trading/manualMethod'
import { fetchTimeSeries, useQuotes } from '../hooks/useMarketData'
import { useSelectedStrategy } from '../hooks/useSelectedStrategy'
import { useAuth } from '../hooks/useAuth'
import { useAccess, useBrokers, useProfile, useSubscriptions } from '../hooks/usePlatform'
import { acceptRisk } from '../lib/platform'
import { pipValueUsd, stopDistanceFromAtr } from '../lib/trading/risk'
import { effectiveRobotCaps, robotTier, STARTER_MAX_PAIRS, STARTER_MAX_PER_PAIR, UNLOCK_SUBSCRIPTION_DAYS } from '../lib/trading/tierLimits'
import { equity, MIN_TRADE_BALANCE_USD } from '../lib/trading/engine'
import { accountKindLabel, contractSizeForKind, contractUnitsLabel } from '../lib/trading/accountKind'
import { formatLots, MIN_LOT, normalizeLots, sizingUnits } from '../lib/trading/lots'
import { INTERVALS, STRATEGY_META, STRATEGY_TYPES, intervalLabel } from '../lib/strategies'
import { atr, rsi, sma } from '../lib/strategies/indicators'
import { WATCHLIST } from '../lib/watchlist'
import { fn as invokeEdge } from '../lib/functions'
import type { Bar, BrokerConnectionRow, Interval, StrategyConfig, StrategyType, TradingMethod, TunedResult } from '../lib/types'
import type { BrokerMode, RatesMap, AccountState, RobotConfig, RobotCycleInput } from '../lib/trading/types'
import { timeAgo, formatUsd } from '../lib/format'
import { cn } from '../lib/cn'
import { Badge, Button, Card, CardContent, Input, PageHeader, Select, Skeleton } from '../components/ui'
import { CollapsibleCard } from '../components/trading/CollapsibleCard'
import { MarketStatus } from '../components/MarketStatus'
import { AccountSummary } from '../components/trading/AccountSummary'
import { PositionsTable } from '../components/trading/PositionsTable'
import { TradeJournal } from '../components/trading/TradeJournal'
import { RiskPanel } from '../components/trading/RiskPanel'
import { TradeForm } from '../components/trading/TradeForm'
import { ManualTunePanel } from '../components/trading/ManualTunePanel'
import { LiveChartPanel } from '../components/trading/LiveChartPanel'
import { RobotLivePrices } from '../components/trading/RobotLivePrices'

function strategyLabel(c: StrategyConfig): string {
  return `${STRATEGY_META[c.type].shortLabel} · ${intervalLabel(c.interval)}`
}

function ModeToggle({ mode, onChange }: { mode: BrokerMode; onChange: (m: BrokerMode) => void }) {
  const options: { value: BrokerMode; label: string; hint?: string }[] = [
    { value: 'paper', label: 'Paper' },
    { value: 'managed', label: 'Live (managed)' },
    { value: 'oanda', label: 'Live (OANDA)' },
    { value: 'mt', label: 'Live (MT4/5)' },
  ]
  return (
    <div className="flex w-full flex-col items-stretch gap-1 sm:w-auto sm:items-end">
      <div
        className="grid w-full grid-cols-2 gap-1 rounded-lg border border-border bg-secondary/40 p-1 sm:inline-flex sm:w-auto sm:flex-nowrap"
        role="group"
        aria-label="Trading mode"
      >
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            aria-pressed={mode === o.value}
            className={cn(
              'h-10 cursor-pointer rounded-md px-3 text-sm font-medium transition-colors duration-150 sm:h-8',
              mode === o.value ? 'bg-accent text-black' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
      {mode === 'mt' && (
        <span className="text-xs text-muted-foreground">
          For real live MetaTrader trading, prefer <span className="text-accent">OANDA</span> or{' '}
          <span className="text-accent">managed</span> — MT needs the platform's MetaApi bridge configured.
        </span>
      )}
    </div>
  )
}

function MethodToggle({ method, onChange }: { method: TradingMethod; onChange: (m: TradingMethod) => void }) {
  return (
    <div className="inline-flex items-center gap-1 rounded-lg border border-border bg-secondary/40 p-1" role="group" aria-label="Trading method">
      {(['scalping', 'longterm'] as TradingMethod[]).map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => onChange(m)}
          aria-pressed={method === m}
          title={m === 'scalping' ? 'Fast intervals, tight stops' : 'Slow intervals, wide stops'}
          className={cn(
            'h-8 cursor-pointer rounded-md px-3 text-sm font-medium transition-colors duration-150',
            method === m ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {methodLabel(m)}
        </button>
      ))}
    </div>
  )
}

/** Live account summary pulled from the connected broker through its Edge Function. */
function LiveSummary({ fn, label, connectionId }: { fn: 'broker-oanda' | 'broker-mt'; label: string; connectionId?: string }) {
  const [data, setData] = useState<{ balance: number; nav: number; openTrades: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    const load = async () => {
      const { data, error } = await invokeEdge<{
        ok?: boolean
        account?: {
          balance?: string | number
          NAV?: string | number
          equity?: string | number
          openTradeCount?: string | number
          openPositions?: string | number
        }
        error?: string
      }>(fn, {
        body: { action: 'summary', connection_id: connectionId },
        fallback: `Could not load your ${label} account.`,
      })
      if (!active) return
      setLoading(false)
      const d = data
      if (error || !d?.ok || !d.account) {
        setError(d?.error ?? error ?? `Could not load your ${label} account.`)
        return
      }
      const acc = d.account
      setData({
        balance: Number(acc.balance ?? 0),
        nav: Number(acc.NAV ?? acc.equity ?? acc.balance ?? 0),
        openTrades: Number(acc.openTradeCount ?? acc.openPositions ?? 0),
      })
    }
    void load()
    // Keep polling the broker while the page is open — balance / equity / open
    // positions keep moving after the robot stops (SL/TP and broker-side
    // closes settle), so the summary must keep up instead of freezing at the
    // first fetch.
    const id = setInterval(() => void load(), 10_000)
    return () => {
      active = false
      clearInterval(id)
    }
  }, [fn, label, connectionId])

  if (loading) {
    return (
      <Card>
        <CardContent>
          <div className="space-y-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-8 w-56" />
          </div>
        </CardContent>
      </Card>
    )
  }
  if (error) {
    return (
      <Card>
        <CardContent>
          <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-red-200">
            <p>{error}</p>
            <p className="mt-1.5 text-xs text-red-200/75">
              The broker may be rejecting the automated login, or the connection needs attention.{' '}
              <Link
                to="/brokers"
                className="font-medium underline decoration-red-200/40 underline-offset-2 hover:text-red-100"
              >
                Check it on the Brokers page
              </Link>
              .
            </p>
          </div>
        </CardContent>
      </Card>
    )
  }
  return (
    <Card>
      <CardContent>
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <p className="text-xs text-muted-foreground">{label} balance</p>
            <p className="mt-1 text-2xl font-bold tnum">{formatUsd(data?.balance ?? 0)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Equity</p>
            <p className="mt-1 text-2xl font-bold tnum">{formatUsd(data?.nav ?? 0)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Open positions</p>
            <p className="mt-1 text-2xl font-bold tnum">{data?.openTrades ?? 0}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

/** Live-mode banner: labels the connected broker account and warns about real money. */
function LiveBanner({ conn, label }: { conn: BrokerConnectionRow; label: string }) {
  const live = conn.account_type === 'live'
  return (
    <div
      className={
        live
          ? 'flex flex-col gap-3 rounded-xl border border-amber/40 bg-amber/10 p-4 sm:flex-row sm:items-center'
          : 'flex flex-col gap-3 rounded-xl border border-up/30 bg-up/10 p-4 sm:flex-row sm:items-center'
      }
    >
      <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${live ? 'bg-amber/20 text-amber' : 'bg-up/15 text-up'}`}>
        <ShieldAlert className="h-5 w-5" aria-hidden="true" />
      </div>
      <div className="flex-1">
        <h2 className={`text-sm font-semibold ${live ? 'text-amber' : 'text-up'}`}>
          {live ? 'LIVE account — real money' : 'Practice (demo) account'}
        </h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {live
            ? `Orders the robot or the manual form sends are placed on your real ${label} account. Stops are enforced by the broker, and your risk limits still gate every entry.`
            : `Trades run on your ${label} practice account with virtual funds — safe to experiment. Switch to a live account on the Brokers page when you are ready.`}{' '}
          Account <span className="font-mono">{conn.account_id ?? '—'}</span> ·{' '}
          <Link to="/brokers" className={live ? 'text-amber hover:underline' : 'text-accent hover:underline'}>
            manage connection
          </Link>
          .
        </p>
      </div>
    </div>
  )
}

/** Managed-live banner: the platform's own live ledger, no external broker token needed. */
function ManagedBanner() {
  return (
    <div
      className={
        'flex flex-col gap-3 rounded-xl border border-amber/40 bg-amber/10 p-4 sm:flex-row sm:items-center'
      }
    >
      <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber/20 text-amber`}>
        <ShieldAlert className="h-5 w-5" aria-hidden="true" />
      </div>
      <div className="flex-1">
        <h2 className="text-sm font-semibold text-amber">Managed live account — money-style trading</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Your positions run in real size on the platform's own ledger with the same risk rules, stops and journal as
          paper — but there is <span className="font-medium text-foreground">no external broker to connect</span> and
          no MetaApi token required. The account is yours and persists to your profile.
        </p>
      </div>
    </div>
  )
}

const DURATION_OPTIONS: { label: string; value: number | null }[] = [
  { label: 'Until stopped', value: null },
  { label: '30 minutes', value: 30 },
  { label: '1 hour', value: 60 },
  { label: '3 hours', value: 180 },
  { label: '6 hours', value: 360 },
  { label: '12 hours', value: 720 },
  { label: '24 hours', value: 1440 },
]

/** Quick-start account sizes — micro accounts from $10 up to the standard $10k. */
const SEED_PRESETS: { label: string; value: number }[] = [
  { label: 'Micro $10', value: 10 },
  { label: 'Mini $25', value: 25 },
  { label: '$50', value: 50 },
  { label: '$100', value: 100 },
  { label: '$1k', value: 1000 },
  { label: 'Standard $10k', value: 10_000 },
]

function fmtCountdown(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

export function Trading() {
  const { user } = useAuth()
  const { profile, refresh: refreshProfile } = useProfile()
  const { subscriptions } = useSubscriptions(user?.id)
  const access = useAccess(profile, subscriptions)

  // The user's broker connections, resolved BEFORE the live adapters are built
  // so the robot trades the exact account shown in the UI (a user may connect
  // several MT4/5 brokers side by side).
  const { connections } = useBrokers(user?.id)
  const oandaConn = connections.find((c) => c.brokers?.slug === 'oanda')
  const mtConn = connections.find((c) => c.platform === 'mt4' || c.platform === 'mt5')

  const {
    account,
    loading,
    mode,
    setBrokerMode,
    open,
    close,
    sync,
    runCycle,
    setRisk,
    closeRobotPositions,
    flattenAll,
    reset,
    setAccountKind,
  } = usePaperAccount({ oanda: oandaConn?.id, mt: mtConn?.id })
  const [strategy, updateStrategy] = useSelectedStrategy()
  const {
    prefs,
    applyAll,
    setMethod,
    setStrategyMode,
    setManualStrategy,
    setDuration,
    setPairs,
    togglePair,
    setAutoPickPairs,
    setPairCount,
    setPerTradeTakeProfitPips,
    setPerTradeStopLossPips,
    setOverallMaxProfitUsd,
    setOverallMaxLossUsd,
    setMaxPerPair,
    setProfitPullbackPct,
    setSizingMode,
    setRiskPerTradePct,
    setLot,
  } = useRobotPrefs()
  // Draft copies of the per-trade stops (pips) and session limits (USD) — the
  // robot keeps trading on the committed prefs until "Apply limits" is pressed.
  const [draftTradeLimits, setDraftTradeLimits] = useState(() => ({
    tp: prefs.perTradeTakeProfitPips,
    sl: prefs.perTradeStopLossPips,
    profit: prefs.overallMaxProfitUsd,
    loss: prefs.overallMaxLossUsd,
    pullback: prefs.profitPullbackPct,
  }))
  const [limitsDirty, setLimitsDirty] = useState(false)
  const [limitsApplied, setLimitsApplied] = useState(false)
  const applyTradeLimits = () => {
    setPerTradeTakeProfitPips(draftTradeLimits.tp)
    setPerTradeStopLossPips(draftTradeLimits.sl)
    setOverallMaxProfitUsd(draftTradeLimits.profit)
    setOverallMaxLossUsd(draftTradeLimits.loss)
    setProfitPullbackPct(draftTradeLimits.pullback)
    // Profit lock-back is enforced by the engine through account.risk — apply
    // it immediately so open winners get managed right away, not just from the
    // next run.
    setRisk({ profitPullbackPct: draftTradeLimits.pullback })
    setLimitsDirty(false)
    setLimitsApplied(true)
  }
  const revertTradeLimits = () => {
    setDraftTradeLimits({
      tp: prefs.perTradeTakeProfitPips,
      sl: prefs.perTradeStopLossPips,
      profit: prefs.overallMaxProfitUsd,
      loss: prefs.overallMaxLossUsd,
      pullback: prefs.profitPullbackPct,
    })
    setLimitsDirty(false)
    setLimitsApplied(false)
  }
  // The robot trades every pair the user has ticked; default to the first two
  // so a brand-new user sees the robot working out of the box.
  const robotPairs = useMemo(
    () => (prefs.pairs.length > 0 ? prefs.pairs : WATCHLIST.slice(0, 2).map((p) => p.symbol)),
    [prefs.pairs],
  )
  // Pairs the robot actually scans each cycle: the full watchlist when auto-pick
  // is on, otherwise the explicitly selected pairs.
  const scanPairs = useMemo(
    () => (prefs.autoPickPairs ? WATCHLIST.map((p) => p.symbol) : robotPairs),
    [prefs.autoPickPairs, robotPairs],
  )
  // Starter-tier robot limits: free users and subscribers under 30 days may
  // open positions on at most 6 pairs with 1 position per pair. Holding an
  // active subscription for 30+ days (or being an admin) lifts the cap.
  const tier = useMemo(() => robotTier(profile, subscriptions), [profile, subscriptions])
  const robotCaps = useMemo(
    () =>
      effectiveRobotCaps(tier, {
        tradeMode: prefs.tradeMode,
        maxPerPair: prefs.maxPerPair,
        maxOpenTrades: prefs.maxOpenTrades,
      }),
    [tier, prefs.tradeMode, prefs.maxPerPair, prefs.maxOpenTrades],
  )
  // Live quotes stream over Realtime (the market-data Edge Function refreshes
  // priority symbols — the robot's pairs — first) with polling as a fallback.
  // The free tier keeps the paper robot and manual trading; the live/managed
  // robot still requires an active subscription.
  const { quotes, kind: marketKind, error: marketError } = useQuotes(15_000, scanPairs)
  const canRunRobot = access.hasAccess || (mode === 'paper' && access.paperTrading)
  const { tune, update: updateTune, applyPreset, reset: resetTune } = useManualTune()
  // External-broker live (OANDA / MT) — managed live runs on the platform's own
  // ledger and needs no broker connection, so it never depends on these.
  const isBrokerLive = mode === 'oanda' || mode === 'mt'
  const liveConn = mode === 'oanda' ? oandaConn : mtConn
  const liveLabel = mode === 'oanda' ? 'OANDA' : 'MetaTrader'

  // Managed-live auto-trading requires accepting the risk disclaimer once
  // (stored on the profile). The robot refuses to auto-trade until it's done.
  const needsRiskAccept = mode === 'managed' && (profile?.risk_accepted ?? false) !== true

  const [seed, setSeed] = useState(DEFAULT_PAPER_BALANCE)
  // The activity feed + "last run" are hydrated from localStorage so a refresh
  // (or returning after closing the tab) keeps showing what the robot has been
  // doing — every entry is timestamped and re-stamped on each update.
  const [robotLog, setRobotLog] = useState<ActivityEntry[]>(() => loadActivityLog(user?.id))
  const [lastRun, setLastRun] = useState<number | null>(() => loadLastRun(user?.id))
  const [endsAt, setEndsAt] = useState<number | null>(null)
  const [remaining, setRemaining] = useState<number | null>(null)
  const [tuning, setTuning] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [tuned, setTuned] = useState<TunedResult | null>(null)
  const [showManualTune, setShowManualTune] = useState(false)
  const [tuneApplied, setTuneApplied] = useState(false)
  const runningRef = useRef(false)
  // Equity captured when the robot starts; the session guard compares current
  // equity against it to enforce the overall max profit / max loss limits.
  // Mirrored in state so the trading-progress panel can render the live
  // session P&L (a plain ref wouldn't trigger re-renders).
  const sessionStartRef = useRef<number | null>(null)
  const [sessionStart, setSessionStart] = useState<number | null>(null)
  // The last finished session's P&L, crystallized when the robot stops so the
  // trading-progress panel keeps showing the result (instead of wiping it) and
  // keeps accruing while remaining SL/TP closes settle after the stop.
  const [lastSessionPnl, setLastSessionPnl] = useState<number | null>(null)
  // The equity baseline kept while trading is stopped so the crystallized
  // session P&L keeps settling to the final figure as remaining SL/TP closes
  // land after the robot stops (cleared when the account is fully flat).
  const settledBaselineRef = useRef<number | null>(null)
  // Latest rates mirrored for the auto-run timer, which lives in an interval
  // closure and must not re-create itself on every quote tick.
  const ratesRef = useRef<RatesMap>({})

  const rates = useMemo<RatesMap>(() => {
    const r: RatesMap = {}
    for (const q of quotes ?? []) if (q.price != null) r[q.symbol] = q.price
    ratesRef.current = r
    return r
  }, [quotes])

  // Symbols whose latest quote is stale (market closed / feed stalled). The
  // robot only ENTERS on a live quote — it can still close, flatten or mark
  // to market existing positions at the last known price.
  const staleSymbols = useMemo(() => {
    const s = new Set<string>()
    for (const q of quotes ?? []) if (q.stale) s.add(q.symbol)
    return s
  }, [quotes])

  // Re-hydrate the feed when the signed-in identity becomes known (auth loads
  // asynchronously) — the feed is scoped per user, so switching users swaps it.
  const activityUidRef = useRef<string | null | undefined>(undefined)
  useEffect(() => {
    const uid = user?.id
    if (activityUidRef.current === uid) return
    activityUidRef.current = uid
    setRobotLog(loadActivityLog(uid))
    setLastRun(loadLastRun(uid))
  }, [user?.id])

  // Append timestamped entries to the activity feed and mirror it to
  // localStorage so it survives refreshes and tab closes.
  const pushLog = useCallback(
    (lines: string[]) => {
      if (lines.length === 0) return
      const stamped = lines.map((m) => ({ t: Date.now(), m }))
      setRobotLog((prev) => {
        const next = [...stamped, ...prev].slice(0, MAX_ACTIVITY)
        saveActivityLog(next, user?.id)
        return next
      })
    },
    [user?.id],
  )

  // Record + persist when the robot last ran a successful cycle.
  const noteRun = useCallback(() => {
    const t = Date.now()
    setLastRun(t)
    saveLastRun(t, user?.id)
  }, [user?.id])

  // Reset also wipes the persisted activity feed so a fresh account starts clean.
  const handleReset = useCallback(
    (initialBalance: number) => {
      clearActivity(user?.id)
      setRobotLog([])
      setLastRun(null)
      setLastSessionPnl(null)
      settledBaselineRef.current = null
      reset(initialBalance)
    },
    [reset, user?.id],
  )

  // Stopping the robot also closes EVERY open trade — robot and manual — so
  // the open-positions panel is left empty. Auto-trading is disabled FIRST so
  // no new orders fire while positions are closing. On live brokers the
  // flatten sends a real close order per position through the broker.
  const stopRobotAndFlatten = async () => {
    if (!account) return
    setRisk({ autoTrade: false })
    setEndsAt(null)
    setRemaining(null)
    setStopping(true)
    try {
      const { closed, error } = await flattenAll(ratesRef.current)
      pushLog([
        error
          ? `Robot stopped — ${error}`
          : closed > 0
            ? `Robot stopped — ${closed} open position${closed === 1 ? '' : 's'} closed at market. Open-positions panel cleared.`
            : 'Robot stopped — no open positions to close.',
      ])
    } finally {
      setStopping(false)
    }
  }

  // Stop-loss / take-profit are enforced on every quote tick.
  useEffect(() => {
    if (!account || Object.keys(rates).length === 0) return
    void sync(rates)
  }, [rates, account, sync])

  const autoTrade = (account?.risk.autoTrade ?? false) && canRunRobot

  // Account-safety lock: below $1 balance every trading control is disabled
  // (engine canOpen refuses entries at the same threshold) — the robot won't
  // start, the trade forms are locked, and only the STOP path stays live so a
  // running robot can always be halted. The near-zero emergency closeout
  // (markToMarket) handles the blown-account end.
  const balanceLocked = (account?.balance ?? 0) < MIN_TRADE_BALANCE_USD

  // Position sizing for the robot:
  //   - 'risk' (default) — every trade is sized from a % of current equity and
  //     the trade's own stop distance; no lot pick is needed to start.
  //   - 'fixed' — the robot opens EVERY trade at the picked lot (0.01-step
  //     micro lots of this account's contract size). The lot is a REQUIRED
  //     pre-start step here, so Start stays locked until one ≥ 0.01 is chosen.
  const contractSize = contractSizeForKind(account?.risk.kind)
  const contractLabel = contractUnitsLabel(account?.risk.kind)
  const sizingMode = prefs.sizingMode ?? 'risk'
  const riskPct = Math.min(10, Math.max(0.05, prefs.riskPerTradePct ?? 1))
  const sizingValid = sizingMode === 'fixed' ? normalizeLots(prefs.lot) >= MIN_LOT : true
  const sizingLabel =
    sizingMode === 'fixed'
      ? `${formatLots(normalizeLots(prefs.lot))} lot${normalizeLots(prefs.lot) === 1 ? '' : 's'}`
      : `≈ ${riskPct}% equity`

  // Keep the engine's risk config in line with the saved profit-pull-back
  // preference — prefs survive reloads (localStorage), account.risk (jsonb)
  // may predate the setting. Idempotent: no-op once they agree, so it can't
  // loop.
  useEffect(() => {
    if (!account || loading) return
    if (account.risk.profitPullbackPct === prefs.profitPullbackPct) return
    setRisk({ profitPullbackPct: prefs.profitPullbackPct })
  }, [account, loading, account?.risk.profitPullbackPct, prefs.profitPullbackPct, setRisk])

  // Values backing the "Trading progress" panel: auto-run countdown and
  // session P&L vs the max-profit / max-loss limits. While the robot runs the
  // panel shows the live session P&L; after it stops it keeps showing the last
  // run's P&L (crystallized on stop, then settled to the final figure as any
  // remaining SL/TP closes land) instead of wiping it — so profit/loss keeps
  // accumulating into the panel even when trading is stopped.
  const sessionPnl =
    account && autoTrade && sessionStart != null ? equity(account, rates) - sessionStart : null
  const displayedPnl = autoTrade ? sessionPnl : lastSessionPnl
  const runTotalSecs = prefs.durationMinutes != null ? prefs.durationMinutes * 60 : 0
  const runPct =
    runTotalSecs > 0 && remaining != null
      ? Math.min(100, Math.max(0, ((runTotalSecs - remaining) / runTotalSecs) * 100))
      : 0
  const profitPct =
    displayedPnl != null && prefs.overallMaxProfitUsd > 0
      ? Math.min(100, Math.max(0, (Math.max(0, displayedPnl) / prefs.overallMaxProfitUsd) * 100))
      : 0
  const lossPct =
    displayedPnl != null && prefs.overallMaxLossUsd > 0
      ? Math.min(100, Math.max(0, (Math.max(0, -displayedPnl) / prefs.overallMaxLossUsd) * 100))
      : 0
  // Session max-loss trip: the robot is standing by AFTER the last run bled
  // past the Max loss limit. While set, "Start robot" is blocked until the
  // limit is raised (and applied) or the account is reset — the guard can't be
  // restarted into the same hole. Clears automatically on the next run start.
  const maxLossHit =
    !autoTrade &&
    lastSessionPnl != null &&
    prefs.overallMaxLossUsd > 0 &&
    lastSessionPnl <= -prefs.overallMaxLossUsd

  // Record robot runs as sessions + equity history while the robot trades.
  useRobotRecorder({
    user,
    account,
    running: autoTrade,
    strategyLabel: `Robot · ${robotPairs.join(', ')}`,
    method: prefs.method,
    rates,
  })

  // Auto-run timer: stops the robot when the chosen duration elapses. The end
  // time is persisted so a refresh (or returning after the tab was closed)
  // resumes the countdown where it left off — and if the window already
  // elapsed while the page was closed, the robot stops and flattens cleanly on
  // load instead of trading past its schedule. Fresh starts anchor the window
  // to now.
  useEffect(() => {
    if (!account || loading) return
    const uid = user?.id
    if (autoTrade && prefs.durationMinutes) {
      if (endsAt == null) {
        const persisted = loadRunEnd(uid)
        if (persisted != null && persisted > Date.now()) {
          setEndsAt(persisted)
          setRemaining(Math.max(0, Math.round((persisted - Date.now()) / 1000)))
        } else if (persisted != null) {
          // The run window elapsed while the page was closed — stop the robot
          // and close what it left open, exactly as if it had been running.
          setRisk({ autoTrade: false })
          clearRunEnd(uid)
          void closeRobotPositions(ratesRef.current).then(({ closed, error }) => {
            pushLog([
              error
                ? `Robot auto-run ended while you were away — trading paused, but ${error}`
                : closed > 0
                  ? `Robot auto-run ended while you were away — trading paused, ${closed} robot position${closed === 1 ? '' : 's'} closed at market.`
                  : 'Robot auto-run ended while you were away — trading paused, no open robot positions to close.',
            ])
          })
        } else {
          const end = Date.now() + prefs.durationMinutes * 60_000
          setEndsAt(end)
          saveRunEnd(end, uid)
        }
      }
    } else if (!(account?.risk.autoTrade ?? false)) {
      setEndsAt(null)
      setRemaining(null)
      clearRunEnd(uid)
    }
  }, [
    account,
    loading,
    autoTrade,
    prefs.durationMinutes,
    endsAt,
    account?.risk.autoTrade,
    user?.id,
    setRisk,
    closeRobotPositions,
  ])

  // Guard so the expiry tick only fires its close once even if the interval
  // keeps ticking while the broker closes positions.
  const expiryBusyRef = useRef(false)
  useEffect(() => {
    if (!endsAt) return
    expiryBusyRef.current = false
    const tick = () => {
      const left = Math.max(0, Math.round((endsAt - Date.now()) / 1000))
      setRemaining(left)
      if (left <= 0 && !expiryBusyRef.current) {
        expiryBusyRef.current = true
        // Stop first — no new orders while the robot's positions flatten.
        setRisk({ autoTrade: false })
        setEndsAt(null)
        setRemaining(null)
        void closeRobotPositions(ratesRef.current).then(({ closed, error }) => {
          pushLog([
            error
              ? `Robot auto-run finished — trading paused, but ${error}`
              : closed > 0
                ? `Robot auto-run finished — trading paused, ${closed} robot position${closed === 1 ? '' : 's'} closed at market.`
                : 'Robot auto-run finished — trading paused, no open robot positions to close.',
          ])
        })
      }
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [endsAt, setRisk, closeRobotPositions])

  // Restore the session-guard baseline across reloads so a run that spanned a
  // refresh keeps measuring profit/loss from where it started, not from where
  // you returned.
  useEffect(() => {
    if (!account || loading) return
    if (!account.risk.autoTrade || sessionStartRef.current != null) return
    const saved = loadSessionStart(user?.id)
    if (saved == null) return
    sessionStartRef.current = saved
    setSessionStart(saved)
  }, [account, loading, account?.risk.autoTrade, user?.id])

  /**
   * Session profit / loss guard. While the robot runs it tracks the equity
   * change since the run started and stops + flattens everything as soon as the
   * overall max profit or max loss (USD) is reached. Limits of 0 are disabled.
   */
  useEffect(() => {
    if (!account) return
    if (!autoTrade) {
      // Crystallize the finished run's session P&L before wiping the baseline
      // so the trading-progress panel keeps showing it after the robot stops
      // (it used to vanish the instant trading paused). The settle effect below
      // keeps it moving to the final figure as remaining SL/TP closes land.
      if (sessionStartRef.current != null) {
        settledBaselineRef.current = sessionStartRef.current
        setLastSessionPnl(equity(account, rates) - sessionStartRef.current)
      }
      if (sessionStartRef.current != null) clearSessionStart(user?.id)
      sessionStartRef.current = null
      setSessionStart(null)
      return
    }
    const currentEquity = equity(account, rates)
    if (sessionStartRef.current == null) {
      sessionStartRef.current = currentEquity
      setSessionStart(currentEquity)
      saveSessionStart(currentEquity, user?.id)
      settledBaselineRef.current = null
      setLastSessionPnl(null)
      return
    }
    const pnl = currentEquity - sessionStartRef.current
    const maxLoss = prefs.overallMaxLossUsd > 0 && pnl <= -prefs.overallMaxLossUsd
    const maxProfit = prefs.overallMaxProfitUsd > 0 && pnl >= prefs.overallMaxProfitUsd
    if (!maxLoss && !maxProfit) return
    // Stop first — no new orders while the robot's positions flatten.
    setRisk({ autoTrade: false })
    sessionStartRef.current = null
    setSessionStart(null)
    void closeRobotPositions(rates).then(({ closed, error }) => {
      pushLog([
        error
          ? `Session guard hit the overall ${maxLoss ? 'max loss' : 'max profit'} (${formatUsd(maxLoss ? prefs.overallMaxLossUsd : prefs.overallMaxProfitUsd)}) at ${formatUsd(pnl)} — robot stopped, but ${error}`
          : `Session guard hit the overall ${maxLoss ? 'max loss' : 'max profit'} (${formatUsd(maxLoss ? prefs.overallMaxLossUsd : prefs.overallMaxProfitUsd)}) at ${formatUsd(pnl)} — robot stopped, ${closed} robot position${closed === 1 ? '' : 's'} closed.`,
      ])
    })
  }, [account, autoTrade, rates, prefs.overallMaxLossUsd, prefs.overallMaxProfitUsd, closeRobotPositions, setRisk])

  // While trading stays stopped, keep the crystallized session P&L moving as
  // any remaining positions close at market or their SL/TP — the panel's
  // figure settles to the final realized value instead of freezing at the stop
  // instant. Cleared once the account is fully flat.
  useEffect(() => {
    if (autoTrade || !account || settledBaselineRef.current == null) return
    setLastSessionPnl(equity(account, rates) - settledBaselineRef.current)
    if (account.positions.length === 0) settledBaselineRef.current = null
  }, [account, autoTrade, rates])

  // ---------------------------------------------------------------------------
  // Background continuation (ledger-backed accounts only — paper + managed live).
  //
  // While the robot runs, the browser mirrors the run's full configuration into
  // `robot_runs` and heartbeats `client_heartbeat_at`. The scheduled
  // `robot-runner` Edge Function (pg_cron, every minute) takes over any run
  // whose heartbeat goes stale — i.e. this page is closed or was refreshed —
  // and keeps trading with the exact same engine rules, enforcing the auto-run
  // duration, the session profit/loss guard and the user's access. Live OANDA /
  // MetaTrader mirrors are never mirrored (their state lives at the broker).
  const ledgerRobot = Boolean(user && account && !loading && (mode === 'paper' || mode === 'managed'))

  // Mirror the run config + heartbeat while running; mark the run stopped the
  // moment the robot stops (button, duration elapsed, session guard, access).
  useEffect(() => {
    if (!ledgerRobot || !user || !account?.id) return
    const uid = user.id
    const accountId = account.id
    if (!autoTrade) {
      void stopRobotRun(uid, accountId)
      return
    }
    void saveRobotRun(uid, accountId, {
      prefs,
      pairs: robotPairs,
      endsAt,
      sessionStartEquity: sessionStartRef.current ?? sessionStart,
      // Sizing is part of the run's config — the background runner sizes
      // every trade the same way (same engine rules as the browser).
      lot: prefs.lot,
      sizingMode: prefs.sizingMode ?? 'risk',
      riskPerTradePct: prefs.riskPerTradePct ?? 1,
      contractSize: contractSizeForKind(account?.risk.kind),
      sizeMultiplier: tune.sizeMultiplier,
      profitPullbackPct: prefs.profitPullbackPct,
    })
    const id = setInterval(() => void heartbeatRobotRun(uid, accountId), 20_000)
    return () => clearInterval(id)
  }, [ledgerRobot, autoTrade, user, account?.id, robotPairs, endsAt, sessionStart, prefs, tune.sizeMultiplier])

  // Reconcile with the server-side run after load (once per account): if the
  // background runner already finished the run while the page was closed
  // (duration elapsed, session guard hit, or access lost), the account row
  // reflects the stop — align the UI: clear the flag, countdown and session
  // baseline, and flatten defensively. If the run is still live, resume the
  // countdown / session baseline from the authoritative server row (e.g. when
  // returning on another device) and heartbeat so the runner stands down.
  const reconcileRef = useRef<string | null>(null)
  useEffect(() => {
    if (!ledgerRobot || !user || !account?.id || loading) return
    if (reconcileRef.current === account.id) return
    reconcileRef.current = account.id
    const uid = user.id
    const accountId = account.id
    let cancelled = false
    void (async () => {
      const run = await loadRobotRun(uid, accountId)
      if (cancelled || !run) return
      if (run.status !== 'running') {
        // The server stopped/finished it while we were away.
        if (account.risk.autoTrade) {
          setRisk({ autoTrade: false })
          clearRobotRunning(uid)
          clearRunEnd(uid)
          clearSessionStart(uid)
          setEndsAt(null)
          setRemaining(null)
        }
        const lastTick = run.last_tick_at
        void closeRobotPositions(ratesRef.current).then(({ closed, error }) => {
          pushLog([
            error
              ? `Your robot's background run ended while you were away (${run.status === 'finished' ? 'it finished on schedule' : 'it was stopped'}) — trading paused${error ? `, but ${error}` : ''}.`
              : closed > 0
                ? `Your robot's background run ended while you were away — trading paused, ${closed} open robot position${closed === 1 ? '' : 's'} closed at market.`
                : `Your robot's background run ended while you were away — trading paused.`,
            ...(lastTick ? [`Its last activity was ${timeAgo(new Date(lastTick).getTime())}.`] : []),
          ])
        })
        return
      }
      // Still running server-side: heartbeat so it stands down, then resume the
      // countdown / session baseline from the row when the local copy is gone.
      void heartbeatRobotRun(uid, accountId)
      // The server ticked the run while the page was away — surface that the
      // robot kept trading in the background so the feed tells the full story.
      if (run.last_tick_at) {
        pushLog([
          `Resumed from the background — the robot kept trading while you were away (last activity ${timeAgo(new Date(run.last_tick_at).getTime())}).`,
        ])
      }
      if (run.ends_at) {
        const end = new Date(run.ends_at).getTime()
        if (end > Date.now() && endsAt == null) {
          setEndsAt(end)
          setRemaining(Math.max(0, Math.round((end - Date.now()) / 1000)))
          saveRunEnd(end, uid)
        }
      }
      if (run.session_start_equity != null && sessionStartRef.current == null) {
        const baseline = Number(run.session_start_equity)
        sessionStartRef.current = baseline
        setSessionStart(baseline)
        saveSessionStart(baseline, uid)
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ledgerRobot, user, account?.id, account?.risk.autoTrade, loading])

  /**
   * The multi-pair / multi-strategy robot. On every quote tick it fetches fresh
   * bars for the pairs in scope, evaluates ALL strategies on each pair, and
   * ranks every actionable setup by probability-of-profit (live signal strength
   * + the backtested edge of that same strategy). It opens the strongest setups
   * first — up to the account's max-open-positions limit, and up to the chosen
   * per-pair cap of positions on the same pair.
   *
   * In "best analysis method" (auto-pick) mode it scans the whole watchlist and
   * trades only the top `pairCount` ranked pairs; otherwise it only considers
   * the pairs the user ticked.
   */
  useEffect(() => {
    if (!account || !autoTrade || marketKind !== 'ok') return
    const interval = methodInterval(prefs.method)
    const scanSymbols = prefs.autoPickPairs ? WATCHLIST.map((p) => p.symbol) : robotPairs
    let cancelled = false
    void (async () => {
      if (runningRef.current) return
      runningRef.current = true
      try {
        // Fetch fresh bars for every candidate pair in parallel.
        const barsBySymbol: Record<string, Bar[]> = {}
        await Promise.all(
          scanSymbols.map(async (symbol) => {
            const res = await fetchTimeSeries({ symbol, interval, outputsize: 200 })
            if (cancelled || res.kind !== 'ok' || !res.data || res.data.length < 2) return
            barsBySymbol[symbol] = res.data
          }),
        )
        if (cancelled) return

        // Score + rank every pair. Auto mode evaluates ALL strategies per pair
        // and applies the strongest setup (best method = higher profit / less
        // loss). Manual mode uses ONLY the user-selected strategy — the robot
        // still scores pairs by that strategy's signal strength and trades the
        // strongest ones first.
        const ranked = rankPairs(barsBySymbol, interval, prefs.method)
        const rankedTargets: RankedPair[] =
          prefs.strategyMode === 'manual'
            ? manualTargets(barsBySymbol, prefs.manualStrategy, interval, prefs.method)
            : prefs.autoPickPairs
              ? ranked.slice(0, prefs.pairCount)
              : ranked
        // Starter tier: the robot may OPEN positions on at most
        // `robotCaps.maxTargets` distinct pairs (6 for free / <30-day
        // subscribers) — trade the strongest setups within the cap, and the
        // full watchlist once the 30-day subscription unlock applies.
        const targets: RankedPair[] = rankedTargets.slice(0, robotCaps.maxTargets)
        if (prefs.autoPickPairs && targets.length > 0) {
          pushLog([
            `Best analysis method picked ${targets.length} pair${targets.length === 1 ? '' : 's'}: ${targets
              .map((t) => `${t.symbol} (${Math.round(t.score)}%)`)
              .join(', ')}.`,
          ])
        }

        const cycleInputs: RobotCycleInput[] = []
        for (const target of targets) {
          if (cancelled) return
          // Build one cycle input per qualifying pair — runCycle (the engine's
          // runRobotCycle for paper, the throttled live loop for brokers)
          // enforces per-pair + global caps and isolates per-pair failures.
          const price = rates[target.symbol]
          if (price == null) continue
          const bars = barsBySymbol[target.symbol]
          if (!bars || !target.best) continue

          // Never enter on a stale price (weekend / feed stalled) — a
          // position opened at a price that isn't live can't be managed.
          if (staleSymbols.has(target.symbol)) {
            pushLog([
              `Skipped ${target.symbol}: no live quote right now (market closed or feed stalled) — the robot only enters on a live price.`,
            ])
            continue
          }

          // Volatility stand-down: with the volatility filter on, skip pairs
          // whose ATR is spiking (1.5× its recent level) — wild markets eat
          // stop-losses for breakfast. Off by default; presets 1–2 turn it on.
          if (account.risk.volatilityFilter && bars.length >= 30) {
            const atrSeries = atr(bars, 14)
            const lastAtr = atrSeries[atrSeries.length - 1] ?? 0
            const prevAtr = atrSeries[Math.max(0, atrSeries.length - 20)] ?? 0
            if (prevAtr > 0 && lastAtr > prevAtr * 1.5) {
              pushLog([
                `Skipped ${target.symbol}: volatility filter on and ATR is spiking — standing aside until the market settles.`,
              ])
              continue
            }
          }

          // Per-trade TP/SL overrides (in pips) beat the risk-based defaults.
          const atrStop = stopDistanceFromAtr(bars, target.symbol)
          const stopPips =
            prefs.perTradeStopLossPips > 0
              ? prefs.perTradeStopLossPips
              : atrStop > 0
                ? Math.max(account.risk.defaultStopPips, atrStop)
                : account.risk.defaultStopPips
          const takeProfitPips =
            prefs.perTradeTakeProfitPips > 0
              ? prefs.perTradeTakeProfitPips
              : Math.round(stopPips * account.risk.takeProfitRatio)
          const pipValue = pipValueUsd(target.symbol, rates)
          if (pipValue == null) continue
          // Position sizing: 'fixed' → the picked lot converted at this
          // account's contract size; 'risk' → a % of equity sized against the
          // trade's own stop. Both round to 0.01-lot steps — the same math the
          // background runner uses, so browser and server agree.
          const units = sizingUnits({
            mode: sizingMode,
            lot: prefs.lot,
            riskPct,
            equityUsd: equity(account, rates),
            stopPips,
            pipValuePerUnit: pipValue,
            contractSize,
          })
          if (units <= 0) {
            pushLog([
              `Skipped ${target.symbol}: position sizing produced zero units (check the fixed lot / risk % above Start).`,
            ])
            continue
          }

          // Manual tune scales position size relative to the picked lot.
          const scaledUnits = Math.round(units * tune.sizeMultiplier)
          if (scaledUnits <= 0) {
            pushLog([
              `Skipped ${target.symbol}: manual tune scaled the position size to zero — raise the size multiplier.`,
            ])
            continue
          }

          const label = `${STRATEGY_META[target.best.type].shortLabel} · ${intervalLabel(interval)}`
          // Probability-of-profit ingredients: the pair's setup score plus the
          // live signal-strength reads from its bars. The engine only opens
          // when the blended estimate is above the 50% threshold.
          const closes = bars.map((b) => b.close)
          const barLast = bars.length - 1
          const sma20 = sma(closes, 20)[barLast]
          const rsiVal = rsi(closes, 14)[barLast]
          const atrVal = atr(bars, 14)[barLast] ?? 0
          const closeLast = closes[barLast] ?? 0
          const window = bars.slice(-20)
          const range = Math.max(...window.map((b) => b.high)) - Math.min(...window.map((b) => b.low))
          const momentum = range > 0 && bars.length >= 2 ? Math.abs(closes[barLast] - closes[barLast - 1]) / range : 0
          const trendAlign = sma20 != null ? (closeLast > sma20 ? 1 : -1) : 0
          cycleInputs.push({
            symbol: target.symbol,
            signal: target.best.signal,
            price,
            rates,
            strategy: label,
            stopPips,
            takeProfitPips,
            units: scaledUnits,
            score: target.best.score,
            momentum: Math.min(1, momentum),
            rsi: rsiVal ?? undefined,
            trend: trendAlign,
            volatilityPct: closeLast > 0 ? (atrVal / closeLast) * 100 : undefined,
          })
        }
        if (!cancelled && cycleInputs.length > 0) {
          const config: RobotConfig = {
            pairs: scanPairs,
            tradeMode: robotCaps.tradeMode,
            maxPerPair: robotCaps.maxPerPair,
            maxOpenTrades: robotCaps.maxOpenTrades,
          }
          const { events } = await runCycle(cycleInputs, config)
          if (events.length) {
            pushLog(events)
            noteRun()
          }
        }
      } finally {
        runningRef.current = false
      }
    })()
    return () => {
      cancelled = true
    }
  }, [
    account,
    autoTrade,
    robotPairs,
    prefs.method,
    prefs.strategyMode,
    prefs.manualStrategy,
    prefs.autoPickPairs,
    prefs.pairCount,
    prefs.perTradeStopLossPips,
    prefs.perTradeTakeProfitPips,
    prefs.tradeMode,
    prefs.maxPerPair,
    prefs.maxOpenTrades,
    rates,
    staleSymbols,
    marketKind,
    runCycle,
    robotCaps,
    prefs.lot,
    tune.sizeMultiplier,
  ])

  const handleClose = (id: string) => {
    if (!account) return
    const pos = account.positions.find((p) => p.id === id)
    if (!pos) return
    const price = rates[pos.symbol] ?? pos.entryPrice
    void close(id, 'manual', price, rates)
  }

  const applyMethod = (m: TradingMethod) => {
    setMethod(m)
    updateStrategy({ ...strategy, interval: methodInterval(m) })
    setRisk(methodRiskDefaults(m))
    setTuned(null)
    pushLog([
      `Method set to ${methodLabel(m)} — interval ${intervalLabel(methodInterval(m))}, stops and risk adjusted.`,
    ])
  }

  const runTune = async () => {
    setTuning(true)
    setTuned(null)
    const res = await fetchTimeSeries({
      symbol: strategy.pair,
      interval: strategy.interval,
      outputsize: 300,
    })
    setTuning(false)
    if (res.kind !== 'ok' || !res.data || res.data.length < 30) {
      pushLog(['Auto-tune: not enough price data right now — try again shortly.'])
      return
    }
    const result = autoTune(res.data, strategy.type, strategy.params)
    if (!result) {
      pushLog(['Auto-tune: no parameter set beat the current one.'])
      return
    }
    updateStrategy({ ...strategy, params: result.params })
    setTuned(result)
    pushLog([
      `Auto-tune picked ${STRATEGY_META[strategy.type].shortLabel} parameters (${result.profitFactor.toFixed(2)} profit factor).`,
    ])
  }

  const applyManualTune = () => {
    setRisk({
      riskPerTradePct: tune.riskPerTradePct,
      takeProfitRatio: tune.takeProfitRatio,
      maxOpenPositions: tune.maxOpenPositions,
      maxDailyLossPct: tune.maxDailyLossPct,
      adaptiveRisk: tune.adaptiveRisk,
      volatilityFilter: tune.volatilityFilter,
      maxConsecutiveLosses: tune.maxConsecutiveLosses,
    })
    setTuneApplied(true)
    setTuned(null)
    pushLog([
      `Manual tune applied — ${aggressivenessLabel(tune.aggressiveness)} profile, ~${tune.targetProfitPct}% target per run, ${tune.sizeMultiplier}× position size (guardrails: ${guardrailLabel(tune)}).`,
    ])
    setShowManualTune(false)
  }

  // One-click "Pro strategy" apply: pushes the battle-tested scale-out exit
  // (50% at 1R → break-even → trail the rest) plus its risk guardrails onto
  // the account's risk config AND the robot prefs, so the very next robot
  // cycle trades with it. User pair selection and duration are preserved.
  const [presetApplied, setPresetApplied] = useState(false)
  const applyProStrategy = () => {
    if (!account) return
    const preset: StrategyPreset = proStrategyPreset(prefs.method)
    setRisk(preset.risk)
    applyAll({ ...prefs, ...preset.prefs })
    setPresetApplied(true)
    setTuned(null)
    pushLog([
      `${preset.name} applied — ${preset.tagline}. Now banking 50% at 1R, moving to break-even and trailing the rest, with a 30% give-back lock, ATR-aware stops and a ${preset.risk.maxConsecutiveLosses}-loss circuit breaker.`,
    ])
  }

  const guardedSetRisk = (patch: Parameters<typeof setRisk>[0]) => {
    if (patch.autoTrade === true && balanceLocked) {
      pushLog([`Balance is below $${MIN_TRADE_BALANCE_USD} — trading is locked. Reset the account to trade again.`])
      return
    }
    if (patch.autoTrade === true && maxLossHit) {
      pushLog([
        `Max loss reached — ${formatUsd(Math.abs(lastSessionPnl ?? 0))} lost against the ${formatUsd(prefs.overallMaxLossUsd)} limit, so the robot stays off. Raise the session Max loss (Apply) or reset the account to trade again.`,
      ])
      return
    }
    if (patch.autoTrade === true && !sizingValid) {
      pushLog([
        `Fix position sizing first — in "Fixed lots" mode choose a lot of 0.01 or more above the Start button; in "Risk %" mode no lot is needed. Start unlocks once sizing is ready.`,
      ])
      return
    }
    if (patch.autoTrade === true && needsRiskAccept) {
      pushLog(['Accept the risk disclaimer first — managed live auto-trading stays locked until you do.'])
      return
    }
    if (patch.autoTrade === true && !canRunRobot) return
    if (patch.autoTrade === true && mode !== 'paper') {
      let msg: string
      if (mode === 'managed') {
        msg = 'You are about to auto-trade on your MANAGED live account — the platform\'s real-size ledger, no external broker. Continue?'
      } else {
        const live = liveConn?.account_type === 'live'
        msg = live
          ? `WARNING: You are about to auto-trade on your LIVE ${liveLabel} account with REAL money. Every signal will place a real order. Continue?`
          : `You are about to auto-trade on your ${liveLabel} practice (demo) account. No real money moves. Continue?`
      }
      if (!window.confirm(msg)) return
    }
    setRisk(patch)
  }

  const acceptRiskNow = async () => {
    if (!user) return
    const err = await acceptRisk(user.id)
    if (err) {
      pushLog(["We couldn't save your risk acceptance — try again."])
      return
    }
    await refreshProfile()
    pushLog(['Risk disclaimer accepted — managed live auto-trading is unlocked.'])
  }

  const riskGate =
    needsRiskAccept && mode === 'managed' ? (
      <Card className="border-amber/40">
        <CardContent>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber/20 text-amber">
              <ShieldAlert className="h-5 w-5" aria-hidden="true" />
            </div>
            <div className="flex-1">
              <h2 className="text-sm font-semibold text-amber">Accept the risk disclaimer to auto-trade live</h2>
              <p className="mt-0.5 text-sm text-muted-foreground">
                Your managed live account trades in real size. Before the robot can auto-trade it, confirm you
                understand the risks — you'll only be asked once.
              </p>
            </div>
            <Button size="sm" onClick={() => void acceptRiskNow()}>
              Accept risk &amp; continue
            </Button>
          </div>
        </CardContent>
      </Card>
    ) : null

  const marketAlert =
    marketKind !== 'ok' ? (
      <p role="alert" className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
        {marketError} The robot won't open or close anything until prices are available again.
      </p>
    ) : null

  // Shared robot control card — used by both paper and live modes.
  const robotCard = (
    <CollapsibleCard
      title="Robot"
      actions={
        <>
          {remaining != null && endsAt && (
            <Badge className="border-amber/40 bg-amber/10 text-amber">
              <Timer className="h-3.5 w-3.5" aria-hidden="true" />
              {fmtCountdown(remaining)} left
            </Badge>
          )}
          <Badge className={autoTrade ? 'border-up/30 bg-up/15 text-up' : 'border-border bg-muted text-muted-foreground'}>
            {autoTrade ? <Play className="h-3.5 w-3.5" aria-hidden="true" /> : <Pause className="h-3.5 w-3.5" aria-hidden="true" />}
            {autoTrade ? 'Active' : 'Standby'}
          </Badge>
        </>
      }
    >
      <div className="flex flex-col gap-5">
          {/* Starter-tier market-open limit notice */}
          {tier.limited ? (
            <div className="flex flex-col gap-2 rounded-xl border border-amber/40 bg-amber/10 p-3 sm:flex-row sm:items-center">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-amber/20 text-amber">
                <Lock className="h-4 w-4" aria-hidden="true" />
              </div>
              <p className="text-sm text-muted-foreground">
                <span className="font-semibold text-amber">Free &amp; starter market limit</span> — the robot opens at
                most <span className="font-semibold text-amber">{STARTER_MAX_PAIRS} pairs</span> with{' '}
                <span className="font-semibold text-amber">{STARTER_MAX_PER_PAIR} position per pair</span>
                {tier.subscriberDays != null ? (
                  <>
                    {' '}while under {UNLOCK_SUBSCRIPTION_DAYS} days of subscription (you are at{' '}
                    {tier.subscriberDays} day{tier.subscriberDays === 1 ? '' : 's'})
                  </>
                ) : (
                  ' while free'
                )}
                . Full watchlist and per-pair power unlock automatically after {UNLOCK_SUBSCRIPTION_DAYS} days of
                subscription.
              </p>
            </div>
          ) : tier.subscriberDays != null ? (
            <p className="flex items-center gap-1.5 text-xs text-up">
              <Check className="h-3.5 w-3.5" aria-hidden="true" />
              Subscribed {tier.subscriberDays} day{tier.subscriberDays === 1 ? '' : 's'} — full market limits unlocked.
            </p>
          ) : null}

          {/* One-click Pro strategy — apply the battle-tested scale-out
              take-profit config to the robot with a single click. */}
          <div
            className={cn(
              'flex flex-col gap-3 rounded-xl border p-4 sm:flex-row sm:items-center',
              presetApplied ? 'border-up/30 bg-up/5' : 'border-accent/40 bg-accent/5',
            )}
          >
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent">
              <Target className="h-5 w-5" aria-hidden="true" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
                Pro strategy — {proStrategyPreset(prefs.method).tagline}
                {presetApplied && (
                  <Badge className="border-up/30 bg-up/15 text-up">
                    <Check className="h-3 w-3" aria-hidden="true" />
                    Applied
                  </Badge>
                )}
              </p>
              <p className="mt-0.5 text-sm text-muted-foreground">
                {proStrategyPreset(prefs.method).description}
              </p>
            </div>
            <Button
              size="sm"
              onClick={applyProStrategy}
              disabled={!account}
              className="shrink-0"
            >
              <Sparkles className="h-4 w-4" aria-hidden="true" />
              Apply to robot
            </Button>
          </div>

          {/* Pick lot — REQUIRED pre-start step. The robot opens every trade
              at this size (1 lot = 100,000 units), so Start stays locked
              until an integer lot ≥ 1 is chosen. */}
          <div
            className={cn(
              'flex flex-col gap-3 rounded-xl border p-4 sm:flex-row sm:items-start sm:justify-between',
              sizingValid ? 'border-border bg-secondary/30' : 'border-amber/40 bg-amber/10',
            )}
          >
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                <Sliders className="h-4 w-4 text-accent" aria-hidden="true" />
                Position sizing
                {sizingValid ? (
                  <Badge className="border-up/30 bg-up/15 text-up">{sizingLabel}</Badge>
                ) : (
                  <Badge className="border-amber/40 bg-amber/10 text-amber">Required</Badge>
                )}
              </p>
              <p className="mt-0.5 text-sm text-muted-foreground">
                {sizingMode === 'risk' ? (
                  <>
                    Every trade risks{' '}
                    <span className="tnum font-medium text-foreground">{riskPct}%</span> of current equity
                    against its own stop — nothing to pick, Start is ready. On an{' '}
                    <span className="font-medium text-foreground">{accountKindLabel(account?.risk.kind)}</span>{' '}
                    account one lot is {contractLabel}, so 0.01 lot is one micro-lot of it.
                  </>
                ) : sizingValid ? (
                  `The robot opens every trade at ${formatLots(normalizeLots(prefs.lot))} lot${normalizeLots(prefs.lot) === 1 ? '' : 's'} (1 lot = ${contractLabel}) — set your position size before starting.`
                ) : (
                  <span className="font-medium text-amber">
                    Pick a fixed lot before starting — the robot opens every trade at the lot you choose (0.01
                    minimum; 1 lot = {contractLabel} on this account).
                  </span>
                )}
              </p>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2 sm:mt-0">
              <div
                role="group"
                aria-label="Position sizing mode"
                className="flex items-center gap-1 rounded-lg border border-border bg-secondary/40 p-1"
              >
                {(['risk', 'fixed'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setSizingMode(m)}
                    aria-pressed={sizingMode === m}
                    className={cn(
                      'h-8 cursor-pointer rounded-md px-3 text-sm font-medium transition-colors duration-150',
                      sizingMode === m ? 'bg-accent text-black' : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {m === 'risk' ? 'Risk %' : 'Fixed lots'}
                  </button>
                ))}
              </div>
              {sizingMode === 'risk' ? (
                <div className="flex items-center gap-1.5">
                  <label htmlFor="robot-risk-pct" className="text-xs text-muted-foreground">
                    Risk per trade
                  </label>
                  <Input
                    id="robot-risk-pct"
                    type="number"
                    min={0.05}
                    max={10}
                    step={0.5}
                    value={riskPct}
                    aria-label="Risk percent per trade"
                    className="w-24 text-center tnum"
                    onChange={(e) => {
                      const v = Number(e.target.value)
                      if (Number.isFinite(v)) setRiskPerTradePct(v)
                    }}
                  />
                  <span className="text-xs text-muted-foreground">%</span>
                </div>
              ) : (
                <div className="flex items-center gap-1.5">
                  <Button
                    variant="secondary"
                    size="sm"
                    aria-label="Decrease lot size"
                    onClick={() => setLot(prefs.lot - 0.01)}
                    disabled={!sizingValid}
                  >
                    −
                  </Button>
                  <Input
                    type="number"
                    min={0.01}
                    step={0.01}
                    value={prefs.lot > 0 ? formatLots(normalizeLots(prefs.lot)) : ''}
                    placeholder="0.01"
                    aria-label="Fixed lot size"
                    className="w-24 text-center tnum"
                    onChange={(e) => {
                      const v = Number(e.target.value)
                      if (Number.isFinite(v)) setLot(v)
                    }}
                  />
                  <Button
                    variant="secondary"
                    size="sm"
                    aria-label="Increase lot size"
                    onClick={() => setLot(prefs.lot + 0.01)}
                  >
                    +
                  </Button>
                </div>
              )}
            </div>
          </div>

          {/* Start / stop */}
          {balanceLocked && !autoTrade && (
            <div className="flex items-start gap-3 rounded-xl border border-amber/40 bg-amber/10 p-3">
              <Lock className="mt-0.5 h-4 w-4 shrink-0 text-amber" aria-hidden="true" />
              <p className="text-sm text-muted-foreground">
                <span className="font-semibold text-amber">Balance is below $1 — trading is locked.</span> The robot
                won't start and the trade forms are disabled until you reset or top up the account. If balance or
                equity ever hits $0.01, the robot stops and closes everything automatically.
              </p>
            </div>
          )}
          <div
            className={cn(
              'flex flex-col gap-3 rounded-xl border p-4 sm:flex-row sm:items-center sm:justify-between',
              autoTrade ? 'border-up/30 bg-up/5' : 'border-border bg-secondary/30',
            )}
          >
            <div>
              <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
                {maxLossHit && <span className="h-2 w-2 shrink-0 rounded-full bg-down" aria-hidden="true" />}
                {autoTrade && <span className="h-2 w-2 shrink-0 animate-pulse-dot rounded-full bg-up" aria-hidden="true" />}
                {maxLossHit ? (
                  <span className="text-down">Max loss reached — robot stopped</span>
                ) : autoTrade ? (
                  'Robot is live — trading the strongest setups'
                ) : (
                  'Robot is standing by'
                )}
              </p>
              <p className="mt-0.5 text-sm text-muted-foreground">
                {maxLossHit
                  ? `The last run lost ${formatUsd(Math.abs(lastSessionPnl ?? 0))} against your ${formatUsd(prefs.overallMaxLossUsd)} max-loss limit, so the robot parked itself. Raise the session Max loss (and press Apply) or reset the account to run again.`
                  : autoTrade
                    ? prefs.strategyMode === 'manual'
                      ? `Scanning ${robotPairs.length} pair${robotPairs.length === 1 ? '' : 's'} · ${STRATEGY_META[prefs.manualStrategy].shortLabel} method only, strongest signals first.`
                      : `Scanning ${robotPairs.length} pair${robotPairs.length === 1 ? '' : 's'} · every strategy evaluated on each · up to ${robotCaps.maxPerPair} position${robotCaps.maxPerPair === 1 ? '' : 's'} per pair, strongest setups first.`
                    : 'Start the robot to auto-trade the strongest signal across your selected pairs — always risk-sized with a stop-loss.'}
              </p>
            </div>
            <Button
              variant={autoTrade ? 'danger' : 'primary'}
              size="lg"
              onClick={() => void (autoTrade ? stopRobotAndFlatten() : guardedSetRisk({ autoTrade: true }))}
              disabled={!canRunRobot || stopping || (balanceLocked && !autoTrade) || (maxLossHit && !autoTrade) || (!sizingValid && !autoTrade)}
              loading={stopping}
              title={
                maxLossHit
                  ? 'Session max loss reached — raise the Max loss limit (Apply) or reset the account to start again.'
                  : !sizingValid
                    ? 'Pick a fixed lot first — the robot opens every trade at the lot you choose (0.01 or more).'
                    : undefined
              }
              className={cn('w-full shrink-0 sm:w-auto sm:min-w-44', autoTrade && 'animate-pulse-glow')}
            >
              {autoTrade ? <Pause className="h-4 w-4" aria-hidden="true" /> : <Play className="h-4 w-4" aria-hidden="true" />}
              {autoTrade ? (stopping ? 'Closing positions…' : 'Stop robot & close all') : 'Start robot'}
            </Button>
          </div>

          {/* Run window — choose how long the robot trades BEFORE starting it. */}
          <div className="flex flex-col gap-2 rounded-xl border border-border bg-secondary/30 p-4 sm:flex-row sm:items-end sm:justify-between">
            <div className="pb-1">
              <p className="text-sm font-semibold text-foreground">Auto-run duration</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {prefs.durationMinutes == null
                  ? 'The robot runs until you press Stop robot.'
                  : `The robot stops and closes every position after ${prefs.durationMinutes} minute${prefs.durationMinutes === 1 ? '' : 's'}.`}
              </p>
            </div>
            <Select
              value={String(prefs.durationMinutes ?? 0)}
              onChange={(e) => setDuration(e.target.value === '0' ? null : Number(e.target.value))}
              className="w-full sm:w-56"
              aria-label="Auto-run duration"
            >
              {DURATION_OPTIONS.map((o) => (
                <option key={String(o.value)} value={String(o.value ?? 0)}>
                  {o.label}
                </option>
              ))}
            </Select>
          </div>

          {/* Watchlist, per-pair cap and open/cap status */}
          <div className="rounded-xl border border-border bg-secondary/30 p-4">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <p className="text-sm font-semibold text-foreground">
                Watchlist · {robotCaps.tradeMode === 'concurrent' ? 'Concurrent' : 'Sequential'}
              </p>
              <Badge className="border-border bg-muted text-muted-foreground">
                {scanPairs.length} pair{scanPairs.length === 1 ? '' : 's'} · {prefs.autoPickPairs ? 'auto-picked' : 'manual'}
              </Badge>
              <Badge className="border-accent/40 bg-accent/10 text-accent">
                Max {robotCaps.maxPerPair}/pair
              </Badge>
              <Badge className="border-border bg-muted text-muted-foreground">
                Max {robotCaps.maxOpenTrades > 0 ? robotCaps.maxOpenTrades : 'unlimited'} total
              </Badge>
            </div>

            {/* How many positions the robot may hold on one pair at the same time. */}
            <div className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-secondary/40 px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-foreground">Positions per pair</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  The robot may open up to {robotCaps.maxPerPair} position{robotCaps.maxPerPair === 1 ? '' : 's'} on the same
                  pair at once — raise it to trade each new signal instead of waiting for the previous one to close.
                  {tier.limited && (
                    <> The starter tier keeps this at {STARTER_MAX_PER_PAIR} until {UNLOCK_SUBSCRIPTION_DAYS} days of subscription.</>
                  )}
                </p>
              </div>
              <div className="flex items-center gap-1.5">
                <Button
                  variant="secondary"
                  size="sm"
                  aria-label="Fewer positions per pair"
                  onClick={() => setMaxPerPair(Math.max(1, prefs.maxPerPair - 1))}
                  disabled={prefs.maxPerPair <= 1}
                >
                  −
                </Button>
                <span className="w-8 text-center text-sm font-semibold tnum">
                  {tier.limited ? STARTER_MAX_PER_PAIR : prefs.maxPerPair}
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  aria-label="More positions per pair"
                  onClick={() => setMaxPerPair(Math.min(tier.limited ? STARTER_MAX_PER_PAIR : 10, prefs.maxPerPair + 1))}
                  disabled={prefs.maxPerPair >= (tier.limited ? STARTER_MAX_PER_PAIR : 10)}
                >
                  +
                </Button>
              </div>
            </div>

            {/* Sequential list capped at 3 visible rows — scroll for the rest. */}
            <ul className="max-h-24 space-y-1 overflow-y-auto pr-1">
              {scanPairs.map((sym) => {
                const openCount = account?.positions.filter((p) => p.symbol === sym).length ?? 0
                const cap = robotCaps.maxPerPair
                const atCap = openCount >= cap
                return (
                  <li
                    key={sym}
                    className={cn(
                      'flex items-center justify-between gap-2 rounded-md border px-2.5 py-1 text-xs',
                      atCap
                        ? 'border-amber/40 bg-amber/10 text-amber'
                        : 'border-border bg-secondary/40 text-muted-foreground',
                    )}
                  >
                    <span className="font-medium">{sym}</span>
                    <span className="tnum">{openCount}/{cap} open</span>
                  </li>
                )
              })}
            </ul>
            <p className="mt-2 text-xs text-muted-foreground">
              The per-pair cap applies in both modes — a pair at its cap is skipped until a position closes. The global
              cap (above) still limits how many positions the whole robot holds at once.
            </p>
          </div>

          {/* Trading progress + live prices for the robot's pairs */}
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <div className="rounded-xl border border-border bg-secondary/30 p-4">
              <p className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-foreground">
                <Activity className="h-4 w-4 text-accent" aria-hidden="true" />
                Trading progress
              </p>
              {autoTrade || displayedPnl != null ? (
                <div className="space-y-3">
                  {autoTrade && runTotalSecs > 0 && (
                    <div>
                      <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
                        <span>Auto-run</span>
                        <span className="font-mono tnum text-foreground">
                          {Math.round(runPct)}% done · {remaining != null ? `${fmtCountdown(remaining)} left` : '—'}
                        </span>
                      </div>
                      <div
                        role="progressbar"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.round(runPct)}
                        aria-label="Auto-run progress"
                        className="h-2 overflow-hidden rounded-full bg-muted/60"
                      >
                        <div
                          className="h-full rounded-full bg-accent transition-[width] duration-500"
                          style={{ width: `${runPct}%` }}
                        />
                      </div>
                    </div>
                  )}
                  {displayedPnl != null && (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-muted-foreground">{autoTrade ? 'Session P&amp;L' : 'Last session P&amp;L'}</span>
                        <span className={cn('font-mono tnum font-semibold', displayedPnl >= 0 ? 'text-up' : 'text-down')}>
                          {formatUsd(displayedPnl)}
                        </span>
                      </div>
                      {prefs.overallMaxProfitUsd > 0 && (
                        <div>
                          <div className="mb-1 flex items-center justify-between text-[11px] text-muted-foreground">
                            <span>Profit target</span>
                            <span className="font-mono tnum">
                              {formatUsd(Math.max(0, displayedPnl))} / {formatUsd(prefs.overallMaxProfitUsd)}
                            </span>
                          </div>
                          <div className="h-1.5 overflow-hidden rounded-full bg-muted/60">
                            <div
                              className="h-full rounded-full bg-up transition-[width] duration-500"
                              style={{ width: `${profitPct}%` }}
                            />
                          </div>
                        </div>
                      )}
                      {prefs.overallMaxLossUsd > 0 && (
                        <div>
                          <div className="mb-1 flex items-center justify-between text-[11px] text-muted-foreground">
                            <span>Loss limit</span>
                            <span className="font-mono tnum">
                              {formatUsd(Math.max(0, -displayedPnl))} / {formatUsd(prefs.overallMaxLossUsd)}
                            </span>
                          </div>
                          <div className="h-1.5 overflow-hidden rounded-full bg-muted/60">
                            <div
                              className="h-full rounded-full bg-down transition-[width] duration-500"
                              style={{ width: `${lossPct}%` }}
                            />
                          </div>
                        </div>
                      )}
                      {maxLossHit && (
                        <div
                          role="status"
                          className="flex items-start gap-2 rounded-lg border border-down/30 bg-down/10 px-3 py-2"
                        >
                          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-down" aria-hidden="true" />
                          <div className="text-xs">
                            <p className="font-semibold text-down">Max loss reached — robot stopped</p>
                            <p className="mt-0.5 text-muted-foreground">
                              Lost {formatUsd(Math.abs(lastSessionPnl ?? 0))} against a{' '}
                              {formatUsd(prefs.overallMaxLossUsd)} session limit. Raise the Max loss (Apply) or reset
                              the account to run again — Start stays locked until then.
                            </p>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                  {autoTrade && runTotalSecs <= 0 && sessionPnl == null && (
                    <p className="text-sm text-muted-foreground">
                      Robot is trading — its run countdown and session P&amp;L show here as prices update.
                    </p>
                  )}
                  {!autoTrade && (
                    <p className="text-xs text-muted-foreground">
                      Robot paused — this session's P&amp;L stays visible (and keeps settling) as any remaining
                      positions close at their stops.
                    </p>
                  )}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Start the robot to watch its auto-run countdown and session P&amp;L against your profit and loss
                  limits in real time.
                </p>
              )}
            </div>
            <RobotLivePrices pairs={scanPairs} />
          </div>

          {/* Multi-pair selector */}
          <div>
            <span className="mb-2 flex items-center justify-between gap-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <span>Pairs to trade · {robotPairs.length} selected</span>
              <span className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setPairs(WATCHLIST.map((p) => p.symbol))}
                  disabled={robotPairs.length === WATCHLIST.length}
                  className="cursor-pointer rounded border border-border bg-secondary/40 px-2 py-0.5 text-[11px] font-medium normal-case tracking-normal text-muted-foreground transition-colors duration-150 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Select all
                </button>
                <button
                  type="button"
                  onClick={() => setPairs([])}
                  disabled={robotPairs.length === 0}
                  className="cursor-pointer rounded border border-border bg-secondary/40 px-2 py-0.5 text-[11px] font-medium normal-case tracking-normal text-muted-foreground transition-colors duration-150 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Clear
                </button>
              </span>
            </span>
            <div
              className="flex max-h-[6.75rem] flex-wrap gap-2 overflow-y-auto pr-1"
              role="group"
              aria-label="Pairs the robot trades"
            >
              {WATCHLIST.map((p) => {
                const on = robotPairs.includes(p.symbol)
                return (
                  <button
                    key={p.symbol}
                    type="button"
                    aria-pressed={on}
                    onClick={() => togglePair(p.symbol)}
                    className={cn(
                      'inline-flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors duration-150',
                      on
                        ? 'border-accent/50 bg-accent/15 text-accent'
                        : 'border-border bg-secondary/40 text-muted-foreground hover:border-accent/40 hover:text-foreground',
                    )}
                  >
                    {on && <Check className="h-3 w-3" aria-hidden="true" />}
                    {p.symbol}
                  </button>
                )
              })}
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">
              The robot trades up to {robotCaps.maxPerPair} position{robotCaps.maxPerPair === 1 ? '' : 's'} per pair. In Auto
              method it picks the best strategy for each pair automatically; in Manual method it uses only the strategy
              you choose below. Add pairs to spread its attention, or remove them to focus it.
              {tier.limited && (
                <> The starter tier caps opens at {STARTER_MAX_PAIRS} pairs, {STARTER_MAX_PER_PAIR} position per pair, until{' '}
                {UNLOCK_SUBSCRIPTION_DAYS} days of subscription.</>
              )}
            </p>
          </div>

          {/* Trading method: auto (best of all strategies) vs manual (one strategy) */}
          <div className="rounded-xl border border-border bg-secondary/30 p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-foreground">Trading method</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {prefs.strategyMode === 'auto'
                    ? 'Auto — the robot evaluates MA, RSI, MACD and Bollinger on every pair and applies the best one, for higher profit and less loss.'
                    : `Manual — the robot uses only ${STRATEGY_META[prefs.manualStrategy].name}.`}
                </p>
              </div>
              <div
                className="inline-flex items-center gap-1 rounded-lg border border-border bg-secondary/40 p-1"
                role="group"
                aria-label="Trading method"
              >
                <button
                  type="button"
                  onClick={() => setStrategyMode('auto')}
                  aria-pressed={prefs.strategyMode === 'auto'}
                  className={cn(
                    'h-8 cursor-pointer rounded-md px-3 text-sm font-medium transition-colors duration-150',
                    prefs.strategyMode === 'auto' ? 'bg-accent text-black' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  Auto (best method)
                </button>
                <button
                  type="button"
                  onClick={() => setStrategyMode('manual')}
                  aria-pressed={prefs.strategyMode === 'manual'}
                  className={cn(
                    'h-8 cursor-pointer rounded-md px-3 text-sm font-medium transition-colors duration-150',
                    prefs.strategyMode === 'manual' ? 'bg-accent text-black' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  Manual
                </button>
              </div>
            </div>
            {prefs.strategyMode === 'manual' && (
              <div className="mt-3">
                <Select
                  label="Strategy to trade"
                  value={prefs.manualStrategy}
                  onChange={(e) => setManualStrategy(e.target.value as StrategyType)}
                >
                  {STRATEGY_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {STRATEGY_META[t].name}
                    </option>
                  ))}
                </Select>
                <p className="mt-1.5 text-xs text-muted-foreground">
                  The robot evaluates this method on every selected pair and trades only the pairs where it has a live
                  signal — strongest first, always stop-loss protected.
                </p>
              </div>
            )}
          </div>

          {/* Best analysis method (auto-pick) — rank every pair, trade the top ones */}
          <div className="rounded-xl border border-border bg-secondary/30 p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-foreground">Best analysis method (auto-pick)</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Scan the whole watchlist and trade only the highest-probability pairs — live signal strength
                  combined with each strategy's backtested edge.
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={prefs.autoPickPairs}
                aria-label="Toggle auto-pick pairs"
                onClick={() => setAutoPickPairs(!prefs.autoPickPairs)}
                className={cn(
                  'relative h-6 w-11 shrink-0 cursor-pointer rounded-full border transition-colors duration-150',
                  prefs.autoPickPairs ? 'border-accent bg-accent' : 'border-border bg-secondary',
                )}
              >
                <span
                  className={cn(
                    'absolute top-0.5 h-5 w-5 rounded-full bg-foreground transition-transform duration-150',
                    prefs.autoPickPairs ? 'translate-x-5' : 'translate-x-0.5',
                  )}
                />
              </button>
            </div>
            {prefs.autoPickPairs && (
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <span className="flex items-center gap-1.5 text-sm text-foreground">
                  <ListChecks className="h-4 w-4 text-accent" aria-hidden="true" />
                  Pairs to trade
                </span>
                <div className="flex items-center gap-1.5">
                  <Button
                    variant="secondary"
                    size="sm"
                    aria-label="Fewer pairs"
                    onClick={() => setPairCount(Math.max(1, prefs.pairCount - 1))}
                    disabled={prefs.pairCount <= 1}
                  >
                    −
                  </Button>
                  <span className="w-8 text-center text-sm font-semibold tnum">
                  {tier.limited ? Math.min(prefs.pairCount, STARTER_MAX_PAIRS) : prefs.pairCount}
                </span>
                  <Button
                    variant="secondary"
                    size="sm"
                    aria-label="More pairs"
                    onClick={() =>
                      setPairCount(Math.min(tier.limited ? STARTER_MAX_PAIRS : WATCHLIST.length, prefs.pairCount + 1))
                    }
                    disabled={prefs.pairCount >= (tier.limited ? STARTER_MAX_PAIRS : WATCHLIST.length)}
                  >
                    +
                  </Button>
                </div>
                <span className="text-xs text-muted-foreground">
                  Robot trades the top {tier.limited ? Math.min(prefs.pairCount, STARTER_MAX_PAIRS) : prefs.pairCount} of{' '}
                  {tier.limited ? STARTER_MAX_PAIRS : WATCHLIST.length} pairs by probability of profit.
                  {tier.limited && (
                    <>
                      {' '}
                      <span className="text-amber">Capped at {STARTER_MAX_PAIRS} pairs until {UNLOCK_SUBSCRIPTION_DAYS} days of subscription.</span>
                    </>
                  )}
                </span>
              </div>
            )}
          </div>

          {/* Per-trade TP/SL overrides + session profit/loss limits */}
          <div className="rounded-xl border border-border bg-secondary/30 p-4">
            <p className="mb-2 text-sm font-semibold text-foreground">
              Per-trade stops (pips) &amp; session limits (USD)
            </p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-foreground">
                  <Target className="h-3.5 w-3.5 text-accent" aria-hidden="true" />
                  Per-trade stops (pips)
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="mb-1 block text-[11px] uppercase tracking-wide text-muted-foreground" htmlFor="per-trade-tp">
                      Take profit
                    </label>
                    <Input
                      id="per-trade-tp"
                      type="number"
                      min={0}
                      value={draftTradeLimits.tp > 0 ? draftTradeLimits.tp : ''}
                      placeholder="Auto"
                      onChange={(e) => {
                        setDraftTradeLimits((d) => ({ ...d, tp: Math.max(0, Number(e.target.value)) }))
                        setLimitsDirty(true)
                        setLimitsApplied(false)
                      }}
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-[11px] uppercase tracking-wide text-muted-foreground" htmlFor="per-trade-sl">
                      Stop loss
                    </label>
                    <Input
                      id="per-trade-sl"
                      type="number"
                      min={0}
                      value={draftTradeLimits.sl > 0 ? draftTradeLimits.sl : ''}
                      placeholder="Auto"
                      onChange={(e) => {
                        setDraftTradeLimits((d) => ({ ...d, sl: Math.max(0, Number(e.target.value)) }))
                        setLimitsDirty(true)
                        setLimitsApplied(false)
                      }}
                    />
                  </div>
                </div>
                <p className="mt-1.5 text-xs text-muted-foreground">Leave 0 to keep the strategy's risk-based stops.</p>
              </div>
              <div>
                <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-foreground">
                  <ShieldAlert className="h-3.5 w-3.5 text-amber" aria-hidden="true" />
                  Session limits (USD)
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="mb-1 block text-[11px] uppercase tracking-wide text-muted-foreground" htmlFor="session-profit">
                      Max profit
                    </label>
                    <Input
                      id="session-profit"
                      type="number"
                      min={0}
                      value={draftTradeLimits.profit > 0 ? draftTradeLimits.profit : ''}
                      placeholder="Off"
                      onChange={(e) => {
                        setDraftTradeLimits((d) => ({ ...d, profit: Math.max(0, Number(e.target.value)) }))
                        setLimitsDirty(true)
                        setLimitsApplied(false)
                      }}
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-[11px] uppercase tracking-wide text-muted-foreground" htmlFor="session-loss">
                      Max loss
                    </label>
                    <Input
                      id="session-loss"
                      type="number"
                      min={0}
                      value={draftTradeLimits.loss > 0 ? draftTradeLimits.loss : ''}
                      placeholder="Off"
                      onChange={(e) => {
                        setDraftTradeLimits((d) => ({ ...d, loss: Math.max(0, Number(e.target.value)) }))
                        setLimitsDirty(true)
                        setLimitsApplied(false)
                      }}
                    />
                    <div className="mt-1.5 flex flex-wrap items-center gap-1" role="group" aria-label="Quick set max loss">
                      {[0, 1, 2, 5].map((v) => (
                        <button
                          key={v}
                          type="button"
                          aria-pressed={draftTradeLimits.loss === v}
                          onClick={() => {
                            setDraftTradeLimits((d) => ({ ...d, loss: v }))
                            setLimitsDirty(true)
                            setLimitsApplied(false)
                          }}
                          className={cn(
                            'cursor-pointer rounded border px-2 py-0.5 text-[11px] font-semibold transition-colors duration-150',
                            draftTradeLimits.loss === v
                              ? 'border-accent/60 bg-accent/15 text-accent'
                              : 'border-border bg-secondary/40 text-muted-foreground hover:text-foreground',
                          )}
                        >
                          {v === 0 ? 'Off' : `$${v}`}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
                <p className="mt-1.5 text-xs text-muted-foreground">
                  Robot stops and closes everything once a run reaches either limit.
                </p>
              </div>
            </div>
            <div className="mt-4 rounded-lg border border-cyan/30 bg-cyan/5 p-3">
              <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-foreground">
                <Lock className="h-3.5 w-3.5 text-cyan" aria-hidden="true" />
                Profit pull-back lock (%)
              </p>
              <div className="flex flex-wrap items-center gap-2">
                {[0, 10, 25, 50].map((v) => (
                  <button
                    key={v}
                    type="button"
                    aria-pressed={draftTradeLimits.pullback === v}
                    onClick={() => {
                      setDraftTradeLimits((d) => ({ ...d, pullback: v }))
                      setLimitsDirty(true)
                      setLimitsApplied(false)
                    }}
                    className={cn(
                      'cursor-pointer rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors duration-150',
                      draftTradeLimits.pullback === v
                        ? 'border-cyan/60 bg-cyan/15 text-cyan'
                        : 'border-border bg-secondary/40 text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {v === 0 ? 'Off' : `${v}%`}
                  </button>
                ))}
                <Input
                  type="number"
                  min={0}
                  max={90}
                  value={draftTradeLimits.pullback > 0 ? draftTradeLimits.pullback : ''}
                  placeholder="Custom"
                  aria-label="Profit pull-back percent"
                  className="w-24"
                  onChange={(e) => {
                    setDraftTradeLimits((d) => ({ ...d, pullback: Math.min(90, Math.max(0, Number(e.target.value) || 0)) }))
                    setLimitsDirty(true)
                    setLimitsApplied(false)
                  }}
                />
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                {draftTradeLimits.pullback > 0 ? (
                  <>
                    Active once a trade's profit exceeds $1 — then it closes when it gives back{' '}
                    {draftTradeLimits.pullback}% from its highest profit. A winner that peaks at $20 locks at about $
                    {(20 * (1 - draftTradeLimits.pullback / 100)).toFixed(0)}, banking the gain instead of returning
                    it to the market.
                  </>
                ) : (
                  'Off — winners run to their take-profit or trailing stop.'
                )}
              </p>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={applyTradeLimits} disabled={!limitsDirty}>
                <Check className="h-3.5 w-3.5" aria-hidden="true" />
                Apply
              </Button>
              <Button variant="ghost" size="sm" onClick={revertTradeLimits} disabled={!limitsDirty}>
                Revert
              </Button>
              {limitsApplied && !limitsDirty && (
                <span role="status" className="flex items-center gap-1 text-xs text-up">
                  <Check className="h-3.5 w-3.5" aria-hidden="true" />
                  Limits applied.
                </span>
              )}
            </div>
          </div>

          {/* Strategy profile + chart timeframe (duration moved up next to Start) */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex items-center gap-3 rounded-lg border border-border bg-secondary/40 px-3 py-2">
              <Sparkles className="h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
              <div className="min-w-0">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Strategy profile</p>
                <p className="truncate text-sm font-medium text-foreground">{strategyLabel(strategy)}</p>
              </div>
            </div>
            <Select
              label="Chart interval"
              value={strategy.interval}
              onChange={(e) => updateStrategy({ ...strategy, interval: e.target.value as Interval })}
            >
              {INTERVALS.map((i) => (
                <option key={i.value} value={i.value}>
                  {i.label}
                </option>
              ))}
            </Select>
          </div>

          <div className="text-sm text-muted-foreground">
            {lastRun ? <span>Last run {timeAgo(lastRun)}</span> : <span>Waiting for a signal…</span>}
          </div>

          <div className="flex flex-wrap items-center gap-3">
          <Button variant="secondary" size="sm" onClick={() => void runTune()} loading={tuning} disabled={!canRunRobot}>
            <Sparkles className="h-4 w-4" aria-hidden="true" />
            Auto-tune strategy
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setShowManualTune((v) => !v)} disabled={!canRunRobot}>
            <Sliders className="h-4 w-4" aria-hidden="true" />
            Manual tune
          </Button>
          {tuned && (
            <p className="text-xs text-muted-foreground">
              Tuned {STRATEGY_META[strategy.type].shortLabel}: profit factor{' '}
              <span className="font-mono text-foreground">{tuned.profitFactor.toFixed(2)}</span> ·{' '}
              {tuned.totalReturnPct.toFixed(1)}% return · {tuned.trades} trades on {strategy.interval}.
            </p>
          )}
          {!canRunRobot && (
            <span className="text-xs text-muted-foreground">
              Auto-tune unlocks with a package —{' '}
              <Link to="/packages" className="text-accent hover:underline">
                see packages
              </Link>
              .
            </span>
          )}
        </div>

        {showManualTune && (
          <div className="mt-4">
            <ManualTunePanel
              tune={tune}
              onUpdate={updateTune}
              onApplyPreset={applyPreset}
              onReset={resetTune}
              onApply={applyManualTune}
              applied={tuneApplied}
            />
          </div>
        )}

        {robotLog.length > 0 && (
          <>
            <p className="mb-2 mt-4 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <Activity className="h-3.5 w-3.5 text-accent" aria-hidden="true" />
              Auto-tune &amp; robot history
            </p>
            <ul className="max-h-44 space-y-1.5 overflow-y-auto pr-1">
              {robotLog.map((e, i) => (
                <li
                  key={`${i}-${e.t}`}
                  className="flex items-start gap-2 rounded-md bg-muted/40 px-3 py-1.5 font-mono text-xs tnum"
                >
                  <span className="shrink-0 whitespace-nowrap text-muted-foreground">{timeAgo(e.t)}</span>
                  <span>{e.m}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </CollapsibleCard>
  )

  // Full account body — shared by the paper flow and the live mirror.
  const accountBody = (acc: AccountState) => (
    <>
      {riskGate}
      {marketAlert}
      <AccountSummary
        account={acc}
        rates={rates}
        onAccountKindChange={mode === 'paper' ? setAccountKind : undefined}
      />
      {robotCard}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <RiskPanel
          risk={acc.risk}
          onChange={guardedSetRisk}
          onReset={() => handleReset(acc.initialBalance)}
          isLive={mode !== 'paper'}
        />
        <div className="space-y-6 lg:col-span-2">
          <LiveChartPanel initialSymbol={strategy.pair} initialInterval={strategy.interval} rates={rates} />
          <TradeForm account={acc} rates={rates} onOpen={open} />
        </div>
      </div>
      <PositionsTable
        account={acc}
        rates={rates}
        onClose={handleClose}
        robotCaps={{
          tradeMode: robotCaps.tradeMode,
          maxPerPair: robotCaps.maxPerPair,
          maxOpenTrades: robotCaps.maxOpenTrades,
        }}
      />
      <TradeJournal trades={acc.trades} />
    </>
  )

  return (
    <div className="space-y-6">
      <PageHeader
        title="Trading robot"
        description={
          <>
            Every trade is sized to your risk, always carries a stop-loss, and lands in your journal. Pick a method
            (scalping or long-term), let the robot run for a set duration, and auto-tune your strategy against
            recent prices.
          </>
        }
        actions={
          <>
            <MethodToggle method={prefs.method} onChange={applyMethod} />
            <ModeToggle mode={mode} onChange={setBrokerMode} />
          </>
        }
      />

      <MarketStatus quotes={quotes} />

      {!canRunRobot && (
        <Card>
          <CardContent>
            <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent">
                <Sparkles className="h-5 w-5" aria-hidden="true" />
              </div>
              <div className="flex-1">
                <h2 className="text-sm font-semibold">
                  {user ? 'Your free trial or subscription has ended' : 'Sign up for 30 minutes of robot access free'}
                </h2>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  {user
                    ? 'Pick a package to keep the auto-trading robot running with risk limits, auto-tune and method presets.'
                    : 'Create an account and get full robot access for 30 minutes — no card required. Manual paper trading stays available below.'}
                </p>
              </div>
              <Link to="/packages">
                <Button size="sm">{user ? 'View packages' : 'Start free trial'}</Button>
              </Link>
            </div>
          </CardContent>
        </Card>
      )}

      {isBrokerLive ? (
        !liveConn ? (
          <Card>
            <CardContent>
              <div className="flex flex-col items-start gap-4 py-2 sm:flex-row sm:items-center">
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                  <ShieldAlert className="h-6 w-6" aria-hidden="true" />
                </div>
                <div>
                  <h2 className="text-base font-semibold">Connect a broker to go live</h2>
                  <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
                    Add your {liveLabel} account on the Brokers page — credentials are verified and stored
                    securely, never in the browser. Then come back here to see your live account.
                  </p>
                </div>
                <Link to="/brokers" className="shrink-0">
                  <Button size="sm">Connect broker</Button>
                </Link>
              </div>
            </CardContent>
          </Card>
        ) : (
          <>
            <LiveBanner conn={liveConn} label={liveLabel} />
            <LiveSummary fn={mode === 'oanda' ? 'broker-oanda' : 'broker-mt'} label={liveLabel} connectionId={liveConn.id} />
            {account ? (
              accountBody(account)
            ) : loading ? (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-24 rounded-xl" />
                ))}
              </div>
            ) : null}
          </>
        )
      ) : account ? (
        mode === 'managed' ? (
          <>
            <ManagedBanner />
            {accountBody(account)}
          </>
        ) : (
          accountBody(account)
        )
      ) : loading ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
      ) : (
        <Card>
          <CardContent>
            <div className="flex flex-col items-center gap-4 py-8 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-accent/15 text-accent">
                <Wallet className="h-6 w-6" aria-hidden="true" />
              </div>
              <div>
                <h2 className="text-lg font-semibold">
                  {mode === 'managed' ? 'Start your managed live account' : 'Start your paper account'}
                </h2>
                <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
                  {mode === 'managed'
                    ? 'Open a money-style live ledger on the platform — real-size positions, no external broker and no MetaApi token needed. The robot sizes every position from your risk settings, always sets a stop-loss, and records everything in your journal.'
                    : 'Trade with simulated money — micro accounts work from $10. The robot sizes every position from your risk settings, always sets a stop-loss, and records everything in your journal. No sign-in required — sign in to back it up to your account and unlock the auto-trading robot.'}
                </p>
              </div>
              <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-end">
                <div className="flex flex-col gap-1.5">
                  <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Quick start</span>
                  <div className="flex flex-wrap gap-1.5" role="group" aria-label="Quick starting balance">
                    {SEED_PRESETS.map((p) => (
                      <button
                        key={p.value}
                        type="button"
                        aria-pressed={seed === p.value}
                        onClick={() => setSeed(p.value)}
                        className={cn(
                          'cursor-pointer rounded border px-2 py-1.5 text-xs font-medium transition-colors duration-150',
                          seed === p.value
                            ? 'border-accent/50 bg-accent/15 text-accent'
                            : 'border-border bg-secondary/40 text-muted-foreground hover:text-foreground',
                        )}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                </div>
                <Input
                  label="Starting balance (USD)"
                  type="number"
                  min={10}
                  step={10}
                  value={seed}
                  onChange={(e) => setSeed(Math.max(10, Number(e.target.value) || 10))}
                  className="w-full sm:w-48"
                />
                <Button
                  className="w-full sm:w-auto"
                  onClick={() => {
                    reset(seed)
                    if (mode === 'managed') setBrokerMode('managed')
                  }}
                >
                  {mode === 'managed' ? 'Create managed live account' : 'Create paper account'}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}