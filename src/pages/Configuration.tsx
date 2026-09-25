/**
 * Configuration — the robot's trading-style preferences (scalping vs
 * long-term), which pairs it trades, whether it auto-picks the strongest pairs,
 * and overall run profit/loss targets. Persisted to localStorage. Also hosts
 * the one-click free market data source that keeps the app running with no API
 * key.
 */
import { useCallback, useEffect, useState } from 'react'
import { ArrowLeftRight, Check, Layers, ListChecks, RefreshCw, Save, Scale, ShieldCheck, SlidersHorizontal, Sparkles, Zap, Wrench } from 'lucide-react'
import { useRobotPrefs, methodLabel } from '../lib/trading/robotPrefs'
import { ZIG_ZAG_MIN_PER_PAIR, zigZagSequence } from '../lib/trading/engine'
import { ROBOT_PRESETS, loadPresetMode, savePresetMode, type RobotPresetKey } from '../lib/trading/robotPresets'
import { WATCHLIST, isCryptoPair } from '../lib/watchlist'
import { activateFreeMarketData, fetchMarketDataConfig, reconfigureMarketData } from '../lib/platform'
import type { MarketDataConfig } from '../lib/platform'
import type { Bar, Interval, StrategyConfig, StrategyType, TradingMethod } from '../lib/types'
import type { TradeMode } from '../lib/trading/types'
import { defaultParams, STRATEGY_META, STRATEGY_TYPES } from '../lib/strategies'
import { capAdvice, comparePerPairCaps, type CapAdvice } from '../lib/strategies/capComparison'
import { fetchTimeSeries } from '../hooks/useMarketData'
import { formatPct, formatUsd } from '../lib/format'
import { cn } from '../lib/cn'
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Input, PageHeader, Select } from '../components/ui'
import { ApiTokensCard } from '../components/ApiTokensCard'

/** Caps the advice check compares — below the zig-zag line and well past it. */
const ADVICE_CAPS = [1, 2, 4, 8]
/** Bars pulled per pair: enough for every indicator to warm up. */
const ADVICE_BARS = 200
/** Pairs checked at once, so the button always answers quickly. */
const ADVICE_MAX_PAIRS = 4
/** Round-trip cost assumption, matching the Backtester's default. */
const ADVICE_COST_PER_TRADE = 2.5

/**
 * A human sentence for the cap advice — never a bare number, and never a
 * "best" when nothing traded or every cap lost. Names what the numbers came
 * from (bars, pairs, costs) so the recommendation can be judged, not just read.
 */
function adviceCopy(advice: CapAdvice, pairsChecked: number): string {
  const best = advice.best
  if (!best || advice.empty) {
    return 'No signals fired on the recent bars for these pairs, so there is nothing to compare yet. Add another pair or two, or try the other trading style.'
  }
  const m = best.result.metrics
  const pairs = `${pairsChecked} pair${pairsChecked === 1 ? '' : 's'}`
  const zigZagNote = best.zigZag
    ? ' That cap also runs reverse-order (zig-zag) legs, so the extra book is two-way.'
    : ''
  if (!advice.profitable) {
    return `Every cap lost money on the last ${ADVICE_BARS} bars once ${formatUsd(ADVICE_COST_PER_TRADE)} per round trip was charged. Cap ${best.cap} lost the least (${formatUsd(m.netProfit)} over ${m.totalTrades} trades on ${pairs}) — trading smaller, or on fewer pairs, costs you less than adding legs.`
  }
  const head = `Cap ${best.cap} earned the most after costs: ${formatUsd(m.netProfit)} net (${formatPct(m.totalReturnPct)} return, ${formatPct(m.maxDrawdownPct)} max drawdown) over ${m.totalTrades} trades on ${pairs}.`
  let behind = ''
  if (advice.runnerUp) {
    const ru = advice.runnerUp
    const gap = formatUsd(m.netProfit - ru.result.metrics.netProfit)
    behind =
      ru.cap > best.cap
        ? ` Cap ${ru.cap} — with more legs — finished ${gap} behind, so the extra positions cost more than they earned.`
        : ` Cap ${ru.cap}, holding fewer positions, finished ${gap} behind — the extra legs paid for themselves.`
  }
  return head + behind + zigZagNote
}

export function Configuration() {
  const {
    prefs,
    applyAll,
    setMethod,
    setStrategyMode,
    setManualStrategy,
    setPairs,
    togglePair,
    setAutoPickPairs,
    setPairCount,
    setPerTradeTakeProfitPips,
    setPerTradeStopLossPips,
    setOverallMaxProfitUsd,
    setOverallMaxLossUsd,
    setTradeMode,
    setMaxPerPair,
    setMaxOpenTrades,
    setProfitPullbackPct,
  } = useRobotPrefs()

  const handleSave = () => {
    // Values are persisted to localStorage on every change; this is a visible
    // confirmation point for the user.
    const el = document.getElementById('config-saved')
    if (el) {
      el.textContent = 'Preferences saved locally — they take effect on your next robot run.'
      el.classList.remove('opacity-0')
      setTimeout(() => el?.classList.add('opacity-0'), 2500)
    }
  }

  // One-click robot settings presets (Best / Common / Manual).
  const [presetMode, setPresetMode] = useState<RobotPresetKey>(loadPresetMode)
  const [presetMsg, setPresetMsg] = useState(false)

  const applyPreset = (key: RobotPresetKey) => {
    const preset = ROBOT_PRESETS.find((p) => p.key === key)
    if (!preset) return
    savePresetMode(key)
    setPresetMode(key)
    // 'best' and 'common' overwrite every field in one shot; 'manual' keeps
    // the user's own values and only flips strategy picking to manual.
    if (preset.prefs) applyAll(preset.prefs)
    else setStrategyMode('manual')
    setPresetMsg(true)
    window.setTimeout(() => setPresetMsg(false), 3000)
  }

  const presetIcons: Record<RobotPresetKey, typeof Sparkles> = {
    best: Sparkles,
    common: Layers,
    manual: SlidersHorizontal,
  }

  // "Which cap pays best" — opt-in so the page never fetches bars on its own.
  // Runs the same cap comparison the Backtester card shows, on recent bars for
  // the pairs, strategy and style selected here, with costs charged per close.
  const [advice, setAdvice] = useState<CapAdvice | null>(null)
  const [advicePairs, setAdvicePairs] = useState(0)
  const [adviceLoading, setAdviceLoading] = useState(false)
  const [adviceErr, setAdviceErr] = useState<string | null>(null)

  const checkCaps = async () => {
    setAdviceLoading(true)
    setAdviceErr(null)
    const chosen = prefs.autoPickPairs
      ? WATCHLIST.slice(0, Math.max(1, prefs.pairCount)).map((p) => p.symbol)
      : prefs.pairs.length > 0
        ? prefs.pairs
        : [WATCHLIST[0].symbol]
    const pairs = chosen.slice(0, ADVICE_MAX_PAIRS)
    // Mirror what the robot would trade: the style's timeframe and the strategy
    // it would pick (auto mode evaluates every strategy, so RSI stands in here).
    const interval: Interval = prefs.method === 'scalping' ? '5min' : '1h'
    const type: StrategyType = prefs.strategyMode === 'manual' ? prefs.manualStrategy : 'RSI'
    const config: StrategyConfig = { pair: pairs[0], interval, type, params: defaultParams(type) }
    try {
      const fetched = await Promise.all(
        pairs.map(async (symbol) => {
          const res = await fetchTimeSeries({ symbol, interval, outputsize: ADVICE_BARS })
          return [symbol, res.data ?? []] as const
        }),
      )
      const barsBySymbol: Record<string, Bar[]> = Object.fromEntries(
        fetched.filter(([, bars]) => bars.length >= 30),
      )
      if (Object.keys(barsBySymbol).length === 0) {
        setAdvice(null)
        setAdviceErr(
          'Could not load recent bars for these pairs — enable the market data source on this page, then try again.',
        )
        return
      }
      const rows = comparePerPairCaps(
        barsBySymbol,
        { ...config, pair: Object.keys(barsBySymbol)[0] },
        {
          pairs: Object.keys(barsBySymbol),
          tradeMode: prefs.tradeMode,
          maxPerPair: prefs.maxPerPair,
          maxOpenTrades: prefs.maxOpenTrades,
          costPerTrade: ADVICE_COST_PER_TRADE,
        },
        { caps: ADVICE_CAPS },
      )
      setAdvicePairs(Object.keys(barsBySymbol).length)
      setAdvice(capAdvice(rows))
    } catch {
      setAdvice(null)
      setAdviceErr('Could not run the cap check right now — try again in a moment.')
    } finally {
      setAdviceLoading(false)
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Configuration"
        description="How the trading robot picks pairs and manages each run."
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ListChecks className="h-4 w-4 text-accent" aria-hidden="true" />
              Robot settings preset
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              Set every robot configuration field at once — trading style, strategy, pairs, trade mode and run
              limits. Pick one and it fills the whole form.
            </p>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3" role="group" aria-label="Robot settings preset">
              {ROBOT_PRESETS.map((preset) => {
                const Icon = presetIcons[preset.key]
                const active = presetMode === preset.key
                return (
                  <button
                    key={preset.key}
                    type="button"
                    onClick={() => applyPreset(preset.key)}
                    aria-pressed={active}
                    className={cn(
                      'cursor-pointer rounded-xl border p-4 text-left transition-all duration-150 active:scale-[0.97]',
                      active
                        ? 'border-accent bg-accent/15 shadow-sm'
                        : 'border-border bg-secondary/40 hover:border-accent/50 hover:bg-secondary',
                    )}
                  >
                    <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
                      <Icon className={cn('h-4 w-4', active ? 'text-accent' : 'text-muted-foreground')} aria-hidden="true" />
                      {preset.label}
                      {active && <Check className="ml-auto h-4 w-4 text-accent" aria-hidden="true" />}
                    </span>
                    <span className="mt-2 block text-xs leading-relaxed text-muted-foreground">{preset.description}</span>
                  </button>
                )
              })}
            </div>
            {presetMsg && (
              <p role="status" className="mt-3 rounded-lg border border-up/40 bg-up/10 px-3 py-2 text-xs text-up">
                {presetMode === 'manual'
                  ? 'Manual setting active — your own configuration is kept exactly as it was.'
                  : `${ROBOT_PRESETS.find((p) => p.key === presetMode)?.label ?? 'Preset'} applied — every robot configuration field above is updated and saved locally.`}
              </p>
            )}
          </CardContent>
        </Card>

        <ApiTokensCard />

        <MarketDataCard />

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <SlidersHorizontal className="h-4 w-4 text-accent" aria-hidden="true" />
              Trading style
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-2" role="group" aria-label="Trading style">
              {(['scalping', 'longterm'] as TradingMethod[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMethod(m)}
                  aria-pressed={prefs.method === m}
                  className={cn(
                    'cursor-pointer rounded-lg border px-3 py-2.5 text-sm font-semibold',
                    prefs.method === m
                      ? 'border-accent bg-accent/15 text-accent'
                      : 'border-border bg-secondary text-muted-foreground hover:text-foreground',
                  )}
                >
                  {methodLabel(m)}
                </button>
              ))}
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              {prefs.method === 'scalping'
                ? 'Fast entries with tight stops and targets — suits 5-minute charts.'
                : 'Slower, wider-stopped trades that hold for larger moves — suits hourly charts.'}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ListChecks className="h-4 w-4 text-accent" aria-hidden="true" />
              Trading method
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-2" role="group" aria-label="Trading method">
              {(['auto', 'manual'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setStrategyMode(m)}
                  aria-pressed={prefs.strategyMode === m}
                  className={cn(
                    'cursor-pointer rounded-lg border px-3 py-2.5 text-left text-sm font-semibold',
                    prefs.strategyMode === m
                      ? 'border-accent bg-accent/15 text-accent'
                      : 'border-border bg-secondary text-muted-foreground hover:text-foreground',
                  )}
                >
                  {m === 'auto' ? 'Auto (best method)' : 'Manual'}
                  <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
                    {m === 'auto'
                      ? 'Robot evaluates MA, RSI, MACD & Bollinger on every pair and applies the best one — higher profit, less loss.'
                      : 'Robot uses only the strategy you choose below.'}
                  </span>
                </button>
              ))}
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
                <p className="mt-2 text-xs text-muted-foreground">
                  The robot trades only the pairs where this strategy has a live signal — strongest first, always
                  stop-loss protected.
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Pairs to trade</CardTitle>
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  checked={prefs.autoPickPairs}
                  onChange={(e) => setAutoPickPairs(e.target.checked)}
                  className="h-4 w-4 cursor-pointer accent-[var(--color-accent)]"
                />
                Auto-pick strongest
              </label>
              {!prefs.autoPickPairs && (
                <div className="flex items-center gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setPairs(WATCHLIST.map((p) => p.symbol))}
                    disabled={prefs.pairs.length === WATCHLIST.length}
                  >
                    Select all
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setPairs([])}
                    disabled={prefs.pairs.length === 0}
                  >
                    Clear
                  </Button>
                </div>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {prefs.autoPickPairs ? (
              <div className="space-y-3">
                <Input
                  label="Number of pairs to auto-pick"
                  type="number"
                  min={1}
                  max={WATCHLIST.length}
                  step={1}
                  value={prefs.pairCount}
                  onChange={(e) => setPairCount(Math.max(1, Math.min(WATCHLIST.length, Number(e.target.value))))}
                />
                <p className="text-xs text-muted-foreground">
                  The robot ranks every watchlist pair by momentum + trend strength and trades the
                  top {prefs.pairCount}.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                {WATCHLIST.map((p) => {
                  const on = prefs.pairs.includes(p.symbol)
                  return (
                    <button
                      key={p.symbol}
                      type="button"
                      onClick={() => togglePair(p.symbol)}
                      aria-pressed={on}
                      className={cn(
                        'cursor-pointer rounded-lg border px-2.5 py-1.5 text-left text-xs',
                        on
                          ? 'border-accent/60 bg-accent/15 text-accent'
                          : 'border-border bg-secondary/40 text-muted-foreground hover:text-foreground',
                      )}
                    >
                      <span className="font-medium">{p.symbol}</span>
                      {isCryptoPair(p.symbol) && <span className="ml-1 text-[10px] uppercase text-muted-foreground/70">crypto</span>}
                    </button>
                  )
                })}
              </div>
            )}
            {!prefs.autoPickPairs && prefs.pairs.length === 0 && (
              <p className="mt-3 text-xs text-muted-foreground">
                No pairs selected yet — the robot will default to the first pair on the watchlist.
              </p>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Layers className="h-4 w-4 text-accent" aria-hidden="true" />
              Trade mode &amp; concurrency
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-2" role="group" aria-label="Trade mode">
              {(['sequential', 'concurrent'] as TradeMode[]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setTradeMode(mode)}
                  aria-pressed={prefs.tradeMode === mode}
                  className={cn(
                    'cursor-pointer rounded-lg border px-3 py-2.5 text-left text-sm font-semibold',
                    prefs.tradeMode === mode
                      ? 'border-accent bg-accent/15 text-accent'
                      : 'border-border bg-secondary text-muted-foreground hover:text-foreground',
                  )}
                >
                  {mode === 'sequential' ? 'Sequential' : 'Concurrent'}
                  <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
                    {mode === 'sequential'
                      ? 'One open position per pair — signals on a busy pair are skipped until it closes.'
                      : 'Several positions per pair — up to the per-pair cap on every watchlist pair.'}
                  </span>
                </button>
              ))}
            </div>

            <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Input
                label="Max positions per pair"
                type="number"
                min={1}
                step={1}
                value={prefs.maxPerPair}
                disabled={prefs.tradeMode === 'sequential'}
                onChange={(e) => setMaxPerPair(Math.max(1, Math.round(Number(e.target.value))))}
              />
              <Input
                label="Max open trades (whole robot)"
                type="number"
                min={0}
                step={1}
                value={prefs.maxOpenTrades}
                onChange={(e) => setMaxOpenTrades(Math.max(0, Math.round(Number(e.target.value))))}
              />
            </div>

            <div className="mt-4 rounded-lg border border-border bg-secondary/30 p-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-sm font-semibold">
                    <Scale className="h-4 w-4 text-accent" aria-hidden="true" />
                    Which cap pays best?
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    Backtests your current pairs and style at {ADVICE_CAPS.join(', ')} positions per pair, charging{' '}
                    {formatUsd(ADVICE_COST_PER_TRADE)} of round-trip costs on every close, and recommends the cap that
                    finished ahead.
                  </p>
                </div>
                <Button variant="secondary" size="sm" onClick={() => void checkCaps()} loading={adviceLoading}>
                  <Scale className="h-4 w-4" aria-hidden="true" />
                  Check caps
                </Button>
              </div>
              {adviceErr && (
                <p role="alert" className="mt-3 rounded-lg border border-amber/40 bg-amber/10 px-3 py-2 text-xs text-amber">
                  {adviceErr}
                </p>
              )}
              {advice && !adviceErr && (
                <p
                  role="status"
                  className="mt-3 rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 text-xs leading-relaxed text-foreground"
                >
                  {adviceCopy(advice, advicePairs)}
                </p>
              )}
            </div>

            <p className="mt-3 text-xs text-muted-foreground">
              {prefs.tradeMode === 'sequential'
                ? 'Sequential holds a single position per pair, so the per-pair cap is fixed at 1 — the global cap above still limits the whole robot.'
                : `Concurrent can hold up to ${prefs.maxPerPair} position${prefs.maxPerPair === 1 ? '' : 's'} on each pair${prefs.maxOpenTrades > 0 ? `, bounded by the ${prefs.maxOpenTrades} global open-trade cap` : ' with no global open-trade cap'}.`}
              {' '}Both caps are enforced by the trading engine on every cycle, so a busy market can never over-leverage the account.
            </p>
            {prefs.tradeMode === 'concurrent' && prefs.maxPerPair >= ZIG_ZAG_MIN_PER_PAIR && (
              <div className="mt-2 rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 text-xs text-foreground">
                <p className="flex items-start gap-2">
                  <ArrowLeftRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true" />
                  Reverse-order (zig-zag) legs are on — the first two legs follow the signal and every extra
                  one alternates, so a pair that keeps signalling fills this book:
                </p>
                <div
                  className="mt-2 flex flex-wrap items-center gap-1"
                  aria-label={`Fill order with ${prefs.maxPerPair} positions per pair`}
                >
                  {zigZagSequence('long', prefs.maxPerPair).map((side, i) => (
                    <span
                      key={i}
                      className={
                        'inline-flex h-5 min-w-5 items-center justify-center rounded border px-1 font-mono text-[10px] font-bold ' +
                        (side === 'long' ? 'border-up/40 bg-up/15 text-up' : 'border-down/40 bg-down/15 text-down')
                      }
                    >
                      {side === 'long' ? 'L' : 'S'}
                    </span>
                  ))}
                  <span className="ml-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                    {prefs.maxPerPair} per pair · each leg keeps its own stop and target
                  </span>
                </div>
              </div>
            )}
            {prefs.maxOpenTrades === 0 && (
              <p className="mt-3 flex items-start gap-2 text-xs text-muted-foreground">
                <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true" />
                Set to 0 for unlimited open trades — the robot may open as many positions as signals qualify,
                still bounded by the per-pair cap and your risk settings.
              </p>
            )}
            {prefs.tradeMode === 'concurrent' && prefs.maxOpenTrades > 0 && prefs.maxPerPair > prefs.maxOpenTrades && (
              <p role="alert" className="mt-2 flex items-start gap-2 rounded-lg border border-amber/40 bg-amber/10 px-3 py-2 text-xs text-amber">
                <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                Max per pair ({prefs.maxPerPair}) is higher than the global cap ({prefs.maxOpenTrades}). The global cap
                wins, so at most {prefs.maxOpenTrades} positions open across the whole robot.
              </p>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Run limits</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
              <Input
                label="Per-trade take-profit (pips)"
                type="number"
                min={0}
                step={1}
                value={prefs.perTradeTakeProfitPips}
                onChange={(e) => setPerTradeTakeProfitPips(Number(e.target.value))}
              />
              <Input
                label="Per-trade stop-loss (pips)"
                type="number"
                min={0}
                step={1}
                value={prefs.perTradeStopLossPips}
                onChange={(e) => setPerTradeStopLossPips(Number(e.target.value))}
              />
              <Input
                label="Overall max profit (USD)"
                type="number"
                min={0}
                step={10}
                value={prefs.overallMaxProfitUsd}
                onChange={(e) => setOverallMaxProfitUsd(Number(e.target.value))}
              />
              <Input
                label="Overall max loss (USD)"
                type="number"
                min={0}
                step={10}
                value={prefs.overallMaxLossUsd}
                onChange={(e) => setOverallMaxLossUsd(Number(e.target.value))}
              />
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              Leave per-trade values at 0 to let the robot size stops from market volatility (ATR).
            </p>

            <div className="mt-5 rounded-lg border border-border bg-secondary/30 p-4">
              <p className="text-sm font-semibold">Profit pull-back lock</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Banks winning trades early — once a position peaks in profit, the robot closes it automatically if
                it gives back this percentage from the peak. 0 = off (the default on every new run).
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2" role="group" aria-label="Profit pull-back percent">
                {[0, 10, 25, 50].map((v) => (
                  <button
                    key={v}
                    type="button"
                    aria-pressed={prefs.profitPullbackPct === v}
                    onClick={() => setProfitPullbackPct(v)}
                    className={cn(
                      'cursor-pointer rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors duration-150',
                      prefs.profitPullbackPct === v
                        ? 'border-accent bg-accent/15 text-accent'
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
                  value={prefs.profitPullbackPct > 0 ? prefs.profitPullbackPct : ''}
                  placeholder="Custom"
                  aria-label="Profit pull-back percent"
                  className="w-24"
                  onChange={(e) => setProfitPullbackPct(Math.min(90, Math.max(0, Number(e.target.value) || 0)))}
                />
              </div>
              {prefs.profitPullbackPct > 0 && (
                <p className="mt-2 text-xs text-muted-foreground">
                  A winner that peaks at $20 in profit closes when it gives back {prefs.profitPullbackPct}% — about $
                  {(20 * (1 - prefs.profitPullbackPct / 100)).toFixed(0)} — so the gain is banked instead of returned to
                  the market.
                </p>
              )}
            </div>

            <p id="config-saved" className="mt-3 rounded-lg border border-up/40 bg-up/10 px-3 py-2 text-xs text-up opacity-0 transition-opacity">
              Preferences saved locally — they take effect on your next robot run.
            </p>
            <Button className="mt-4" onClick={handleSave}>
              <Save className="h-4 w-4" aria-hidden="true" />
              Save preferences
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

/** Status + one-click activation of the built-in free market data source. */
function MarketDataCard() {
  const [cfg, setCfg] = useState<MarketDataConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [activating, setActivating] = useState(false)
  const [reconfiguring, setReconfiguring] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    const c = await fetchMarketDataConfig()
    setCfg(c)
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const freeActive = cfg?.provider === 'yahoo' || cfg?.active_provider === 'yahoo'
  const keyedActive = !!cfg && cfg.configured && !freeActive
  const activeLabel = cfg?.active_provider_label ?? cfg?.provider_label ?? 'Free market data'

  const activate = async () => {
    setActivating(true)
    setErr(null)
    setMsg(null)
    const res = await activateFreeMarketData()
    setActivating(false)
    if (res.error) {
      setErr(res.error)
      if (res.config) setCfg(res.config)
      return
    }
    if (res.config) setCfg(res.config)
    setMsg(res.message ?? 'Free market data is now the main source — quotes, charts and the robot use it automatically.')
  }

  /**
   * One-click "reconfigure all API settings" (grab → fetch → inject). GRABs the
   * current provider config, FETCHes a live quote to prove the pipeline works,
   * and INJECTs the free keyless source as the active provider when no keyed
   * provider is configured. Single button, single round-trip.
   */
  const reconfigure = async () => {
    setReconfiguring(true)
    setErr(null)
    setMsg(null)
    const res = await reconfigureMarketData()
    setReconfiguring(false)
    if (res.error) {
      setErr(res.error)
      if (res.config) setCfg(res.config)
      return
    }
    if (res.config) setCfg(res.config)
    setMsg(res.message ?? 'API settings reconfigured — quotes are live.')
  }

  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Zap className="h-4 w-4 text-accent" aria-hidden="true" />
          Market data
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Quotes &amp; charts for the dashboard, signals, backtests and the robot — served through the platform's
          market data service, nothing runs from your device.
        </p>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="h-20 animate-pulse rounded-lg border border-border bg-secondary/40" />
        ) : (
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-medium">{activeLabel}</p>
                <Badge
                  className={
                    freeActive || keyedActive ? 'border-up/40 bg-up/10 text-up' : 'border-amber/40 bg-amber/10 text-amber'
                  }
                >
                  {freeActive || keyedActive ? 'Live' : 'Needs setup'}
                </Badge>
              </div>
              <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted-foreground">
                {freeActive ? (
                  <>
                    Free market data is live — no API key, no signup, $0. Crypto prices come from Binance's public feed
                    and forex from Yahoo Finance, cached server-side.
                  </>
                ) : keyedActive ? (
                  <>
                    {activeLabel} is serving quotes right now. The built-in free source (Binance + Yahoo) stays on as
                    the automatic fallback if that feed ever goes down.
                  </>
                ) : (
                  'No market data source is active yet. One click below starts a free, keyless feed — the app runs immediately.'
                )}
              </p>
            </div>
            <div className="shrink-0">
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="secondary" size="sm" onClick={() => void reconfigure()} loading={reconfiguring}>
                  <Wrench className="h-4 w-4" aria-hidden="true" />
                  Reconfigure API settings
                </Button>
                {freeActive ? (
                  <button
                    type="button"
                    onClick={() => void load()}
                    className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-border bg-secondary/40 px-4 py-2 text-sm font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground active:scale-[0.97]"
                  >
                    <RefreshCw className="h-4 w-4" aria-hidden="true" />
                    Check status
                  </button>
                ) : keyedActive ? (
                  <Badge className="border-border bg-muted text-muted-foreground">Free fallback ready</Badge>
                ) : (
                  <Button onClick={() => void activate()} loading={activating}>
                    <Zap className="h-4 w-4" aria-hidden="true" />
                    Get free market data
                  </Button>
                )}
              </div>
            </div>
          </div>
        )}
        {msg && <p className="mt-3 rounded-lg border border-up/40 bg-up/10 px-3 py-2 text-xs text-up">{msg}</p>}
        {err && <p className="mt-3 rounded-lg border border-amber/30 bg-amber/10 px-3 py-2 text-xs text-amber">{err}</p>}
      </CardContent>
    </Card>
  )
}