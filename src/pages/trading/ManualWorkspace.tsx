/**
 * Manual trading workspace — the "Manual trading" tab of the trading hub.
 *
 * Fully independent from every robot: it owns its own paper/managed/live
 * ledger (slot 0 scope), its own trading style + strategy settings and its own
 * copy-a-pro-trader configuration, so nothing here ever shares a balance,
 * settings or history with Robot 1/2/3. Robots live on their own tabs; this
 * workspace is pure manual order entry — chart, trade form, risk management,
 * positions and journal.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Check, Copy, Lock, ShieldAlert, Sliders, Sparkles, Wallet } from 'lucide-react'
import { DEFAULT_PAPER_BALANCE, usePaperAccount } from '../../lib/trading/usePaperAccount'
import { methodInterval, methodLabel, methodRiskDefaults, useRobotPrefs } from '../../lib/trading/robotPrefs'
import { useSelectedStrategy } from '../../hooks/useSelectedStrategy'
import { useQuotes } from '../../hooks/useMarketData'
import { useAuth } from '../../hooks/useAuth'
import { useBrokers, useProfile, useSubscriptions } from '../../hooks/usePlatform'
import { acceptRisk } from '../../lib/platform'
import { robotTier, UNLOCK_SUBSCRIPTION_DAYS } from '../../lib/trading/tierLimits'
import { PRO_TRADERS, type ProTrader } from '../../lib/proTraders'
import { INTERVALS, STRATEGY_META, intervalLabel } from '../../lib/strategies'
import { WATCHLIST } from '../../lib/watchlist'
import { formatUsd } from '../../lib/format'
import { cn } from '../../lib/cn'
import type { BrokerConnectionRow, Interval, StrategyConfig, TradingMethod } from '../../lib/types'
import type { AccountState, RatesMap } from '../../lib/trading/types'
import { Badge, Button, Card, CardContent, Input, PageHeader, Select, Skeleton } from '../../components/ui'
import { MarketStatus } from '../../components/MarketStatus'
import { AccountSummary } from '../../components/trading/AccountSummary'
import { PositionsTable } from '../../components/trading/PositionsTable'
import { TradeJournal } from '../../components/trading/TradeJournal'
import { RiskPanel } from '../../components/trading/RiskPanel'
import { TradeForm } from '../../components/trading/TradeForm'
import { LiveChartPanel } from '../../components/trading/LiveChartPanel'
import { LiveBanner, LiveSummary, ManagedBanner, ModeToggle, MethodToggle, SEED_PRESETS } from '../../components/trading/shared'

function strategyLabel(c: StrategyConfig): string {
  return `${STRATEGY_META[c.type].shortLabel} · ${intervalLabel(c.interval)}`
}

export function ManualWorkspace() {
  const { user } = useAuth()
  const { profile, refresh: refreshProfile } = useProfile()
  const { subscriptions } = useSubscriptions(user?.id)
  const tier = useMemo(() => robotTier(profile, subscriptions), [profile, subscriptions])
  // The user's broker connections, resolved before the live adapters are built
  // so this workspace trades the exact account shown in the UI.
  const { connections } = useBrokers(user?.id)
  const oandaConn = connections.find((c) => c.brokers?.slug === 'oanda')
  const mtConn = connections.find((c) => c.platform === 'mt4' || c.platform === 'mt5')

  // Slot 0 = the manual ledger: a separate balance/trades/settings scope from
  // every robot slot, backed up under robot_number = 0 when signed in.
  const {
    account,
    loading,
    mode,
    setBrokerMode,
    open,
    close,
    sync,
    setRisk,
    reset,
    setAccountKind,
  } = usePaperAccount({ oanda: oandaConn?.id, mt: mtConn?.id }, 0)
  const [strategy, updateStrategy] = useSelectedStrategy('manual')
  const { prefs, applyAll, setMethod } = useRobotPrefs(0)

  const [seed, setSeed] = useState(DEFAULT_PAPER_BALANCE)

  const isBrokerLive = mode === 'oanda' || mode === 'mt'
  const liveConn = mode === 'oanda' ? oandaConn : mtConn
  const liveLabel = mode === 'oanda' ? 'OANDA' : 'MetaTrader'

  // Managed-live requires accepting the risk disclaimer once (stored on the
  // profile) — the same gate the robot workspaces use.
  const needsRiskAccept = mode === 'managed' && (profile?.risk_accepted ?? false) !== true

  // The whole watchlist is tradable from the manual form, so the quote feed
  // covers every pair.
  const scanSymbols = useMemo(() => WATCHLIST.map((p) => p.symbol), [])
  const { quotes, kind: marketKind, error: marketError } = useQuotes(15_000, scanSymbols)

  const rates = useMemo<RatesMap>(() => {
    const r: RatesMap = {}
    for (const q of quotes ?? []) if (q.price != null) r[q.symbol] = q.price
    return r
  }, [quotes])

  // Stop-loss / take-profit are enforced on every quote tick.
  useEffect(() => {
    if (!account || Object.keys(rates).length === 0) return
    void sync(rates)
  }, [rates, account, sync])

  /** One-click "copy a pro trader": applies the trader's whole configuration
   *  (risk, trading style, sizing and stops) to THIS manual workspace only. */
  const proCopyUnlocked =
    (tier.subscriberDays != null && tier.subscriberDays >= UNLOCK_SUBSCRIPTION_DAYS) || profile?.role === 'admin'
  const [copiedTrader, setCopiedTrader] = useState<string | null>(null)
  const copyTrader = (t: ProTrader) => {
    if (!account) return
    setRisk(t.config.risk)
    applyAll({ ...prefs, ...t.config.prefs })
    setCopiedTrader(t.id)
    updateStrategy({ interval: methodInterval(t.config.prefs.method ?? prefs.method) })
  }

  const applyMethod = (m: TradingMethod) => {
    setMethod(m)
    setRisk(methodRiskDefaults(m))
    updateStrategy({ interval: methodInterval(m) })
  }

  const acceptRiskNow = async () => {
    if (!user) return
    const err = await acceptRisk(user.id)
    if (err) return
    await refreshProfile()
  }

  const handleClose = useCallback(
    (id: string) => {
      if (!account) return
      const pos = account.positions.find((p) => p.id === id)
      if (!pos) return
      const price = rates[pos.symbol] ?? pos.entryPrice
      void close(id, 'manual', price, rates)
    },
    [account, rates, close],
  )

  const riskGate = needsRiskAccept && mode === 'managed' ? (
    <Card className="border-amber/40">
      <CardContent>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber/20 text-amber">
            <ShieldAlert className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="flex-1">
            <h2 className="text-sm font-semibold text-amber">Accept the risk disclaimer to trade managed live</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Your managed live account trades in real size. Confirm you understand the risks — you'll only be asked
              once.
            </p>
          </div>
          <Button size="sm" onClick={() => void acceptRiskNow()}>
            Accept risk &amp; continue
          </Button>
        </div>
      </CardContent>
    </Card>
  ) : null

  const marketAlert = marketKind !== 'ok' ? (
    <p role="alert" className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
      {marketError} Prices and positions stop updating until the feed returns.
    </p>
  ) : null

  // Strategy + copy-trading card: this workspace's own configuration.
  const manualConfigCard = (
    <div className="rounded-xl border border-border bg-secondary/30 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
            <Sliders className="h-4 w-4 text-accent" aria-hidden="true" />
            Your manual trading setup
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Trading style, strategy profile and copy-trading — saved to this workspace only, never shared with your
            robots.
          </p>
        </div>
        <MethodToggle method={prefs.method} onChange={applyMethod} />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
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
      <p className="mt-2 text-xs text-muted-foreground">
        {methodLabel(prefs.method)} style — {prefs.method === 'longterm' ? '1-hour bars, wide stops, 2.5× targets' : '5-minute bars, tight stops, fast entries'}. The
        trade form sizes every order from your risk settings below.
      </p>

      {/* Copy a pro trader — one-click apply of a curated pro's configuration to
          this manual workspace. A 30-day subscriber perk, same as the robots. */}
      <div className="mt-4 rounded-xl border border-border bg-secondary/30 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
              <Copy className="h-4 w-4 text-accent" aria-hidden="true" />
              Copy a pro trader
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Apply a curated pro's whole configuration — risk, stops, style and sizing — to your manual trading in one
              click. Review the Risk panel before trading.
            </p>
          </div>
          {!proCopyUnlocked && (
            <Badge className="border-amber/40 bg-amber/10 text-amber">
              <Lock className="h-3 w-3" aria-hidden="true" />
              Subscriber perk — {UNLOCK_SUBSCRIPTION_DAYS} days
            </Badge>
          )}
        </div>
        {proCopyUnlocked ? (
          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {PRO_TRADERS.map((t) => {
              const copied = copiedTrader === t.id
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => copyTrader(t)}
                  aria-pressed={copied}
                  className={cn(
                    'group cursor-pointer rounded-xl border p-3 text-left transition-colors duration-150',
                    copied
                      ? 'border-up/40 bg-up/5'
                      : 'border-border bg-secondary/40 hover:border-accent/40 hover:bg-accent/5',
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2.5">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent/15 text-xs font-bold text-accent">
                        {t.initials}
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-foreground">{t.name}</p>
                        <p className="text-[11px] text-muted-foreground">{t.handle}</p>
                      </div>
                    </div>
                    <Badge className="shrink-0 border-accent/40 bg-accent/10 text-accent">{t.style}</Badge>
                  </div>
                  <p className="mt-2 line-clamp-2 text-[11px] leading-snug text-muted-foreground">{t.bio}</p>
                  <div className="mt-2 flex items-center justify-between gap-2">
                    <p className="text-[11px] text-muted-foreground">
                      <span className="font-semibold text-up">{t.winRate}%</span> win ·{' '}
                      <span className="font-semibold text-foreground">+{formatUsd(t.avgMonthlyPnlUsd)}</span>/mo ·{' '}
                      <span className="tnum">{t.followers.toLocaleString()}</span> followers
                    </p>
                    <span
                      className={cn(
                        'inline-flex shrink-0 items-center gap-1 text-xs font-semibold transition-colors duration-150',
                        copied ? 'text-up' : 'text-accent group-hover:text-foreground',
                      )}
                    >
                      {copied ? (
                        <>
                          <Check className="h-3.5 w-3.5" aria-hidden="true" /> Applied
                        </>
                      ) : (
                        <>
                          <Copy className="h-3.5 w-3.5" aria-hidden="true" /> Copy
                        </>
                      )}
                    </span>
                  </div>
                </button>
              )
            })}
          </div>
        ) : (
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2">
            <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber" aria-hidden="true" />
            <p className="text-xs text-muted-foreground">
              Copying a pro trader unlocks after {UNLOCK_SUBSCRIPTION_DAYS} days with an active subscription
              {tier.subscriberDays != null ? <> — you're at {tier.subscriberDays} day{tier.subscriberDays === 1 ? '' : 's'} now</> : ''}
              . It applies the trader's full configuration (risk, stops, style and sizing) to your manual trading in
              one click.
            </p>
          </div>
        )}
      </div>
    </div>
  )

  // Full manual workspace body — shared by paper, managed and live mirrors.
  const accountBody = (acc: AccountState) => (
    <>
      {riskGate}
      {marketAlert}
      <AccountSummary
        account={acc}
        rates={rates}
        onAccountKindChange={mode === 'paper' ? setAccountKind : undefined}
      />
      {manualConfigCard}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <RiskPanel
          risk={acc.risk}
          onChange={setRisk}
          onReset={() => reset(acc.initialBalance)}
          isLive={mode !== 'paper'}
        />
        <div className="space-y-6 lg:col-span-2">
          <LiveChartPanel initialSymbol={strategy.pair} initialInterval={strategy.interval} rates={rates} />
          <TradeForm account={acc} rates={rates} onOpen={open} />
        </div>
      </div>
      <PositionsTable account={acc} rates={rates} onClose={handleClose} />
      <TradeJournal trades={acc.trades} />
    </>
  )

  return (
    <div className="space-y-6">
      <PageHeader
        title="Manual trading"
        description={
          <>
            Your own workspace for hands-on trading — chart, order form, risk management, open positions and journal.
            Everything here (balance, style, strategy and copy-trading) belongs to this workspace only: robots run on
            their own tabs with their own accounts and settings.
          </>
        }
        actions={<ModeToggle mode={mode} onChange={setBrokerMode} />}
      />

      <MarketStatus quotes={quotes} />

      {isBrokerLive ? (
        !liveConn ? (
          <Card>
            <CardContent>
              <div className="flex flex-col items-start gap-4 py-2 sm:flex-row sm:items-center">
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                  <ShieldAlert className="h-6 w-6" aria-hidden="true" />
                </div>
                <div>
                  <h2 className="text-base font-semibold">Connect a broker to trade live</h2>
                  <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
                    Add your {liveLabel} account on the Brokers page — credentials are verified and stored securely,
                    never in the browser. Then come back here to trade it.
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
            <LiveBanner conn={liveConn as BrokerConnectionRow} label={liveLabel} />
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
                    ? 'Open a money-style live ledger on the platform — real-size positions, no external broker and no MetaApi token needed. Every manual order is risk-sized with a stop-loss and recorded in your journal.'
                    : 'Trade with simulated money — micro accounts work from $10. Every order is sized from your risk settings, always carries a stop-loss, and lands in your journal. No sign-in required — sign in to back it up to your account.'}
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
