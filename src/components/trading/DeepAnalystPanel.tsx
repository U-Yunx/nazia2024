/**
 * DeepAnalystPanel — AI position-management strategy for a single OPEN trade.
 *
 * Reused wherever positions are listed (Manual trading workspace + every robot
 * tab, via PositionsTable). Clicking "Deep Analyst" sends the position's live
 * fact sheet to the `deep-analyst` Edge Function, which answers with a
 * disciplined management strategy (hold / bank / partial / trail / cut) — the
 * LLM key never leaves the server. Without a key or a signed-in session the
 * function still returns its built-in deterministic engine, so the button
 * never dead-ends.
 *
 * Analysis only: this panel never places, modifies or closes a trade.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { BrainCircuit, Info, RefreshCw, Sparkles, TriangleAlert, X } from 'lucide-react'
import { fn } from '../../lib/functions'
import { buildDeepAnalystContext, type AnalystStrategy, type DeepAnalystResponse } from '../../lib/deepAnalyst'
import { useAuth } from '../../hooks/useAuth'
import { fetchTimeSeries } from '../../hooks/useMarketData'
import { formatPrice, formatUsd, timeAgo } from '../../lib/format'
import { pnlUsd } from '../../lib/trading/risk'
import { cn } from '../../lib/cn'
import type { AccountState, Position, RatesMap } from '../../lib/trading/types'
import { Badge, Button, Skeleton } from '../ui'

const VERDICT_META: Record<
  AnalystStrategy['verdict'],
  { label: string; className: string; hint: string }
> = {
  hold: { label: 'Hold', className: 'border-accent/40 bg-accent/10 text-accent', hint: 'Keep the position as is' },
  take_profit: { label: 'Take profit', className: 'border-up/40 bg-up/10 text-up', hint: 'Bank the full profit now' },
  partial_take_profit: {
    label: 'Partial take-profit',
    className: 'border-up/40 bg-up/10 text-up',
    hint: 'Bank part, let the rest run',
  },
  trail: { label: 'Trail the stop', className: 'border-cyan/40 bg-cyan/10 text-cyan', hint: 'Lock gains, keep upside' },
  cut_loss: { label: 'Cut the loss', className: 'border-down/40 bg-down/10 text-down', hint: 'Exit the loser now' },
  reduce_risk: { label: 'Reduce risk', className: 'border-amber/40 bg-amber/10 text-amber', hint: 'Tighten stop / trim size' },
  stand_pat: { label: 'Stand pat', className: 'border-border bg-muted text-muted-foreground', hint: "No clear edge — don't force it" },
}

type PanelState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'done'; result: DeepAnalystResponse; at: number }
  | { phase: 'error'; message: string }

export function DeepAnalystPanel({
  position,
  mark,
  account,
  rates,
  strategyLabel,
}: {
  position: Position
  mark: number
  account: AccountState
  rates: RatesMap
  strategyLabel?: string
}) {
  const { user } = useAuth()
  const [state, setState] = useState<PanelState>({ phase: 'idle' })
  const pnl = pnlUsd(position.side, position.entryPrice, mark, position.units, position.symbol, rates)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const analyze = useCallback(async () => {
    if (state.phase === 'loading') return
    setState({ phase: 'loading' })
    try {
      // Pull recent bars (15-min) so volatility, trend and swing levels are
      // real, not guessed. Falls back gracefully when the feed is down.
      let history: Awaited<ReturnType<typeof fetchTimeSeries>>['data'] = null
      try {
        const res = await fetchTimeSeries({ symbol: position.symbol, interval: '15min', outputsize: 60 })
        if (res.kind === 'ok') history = res.data
      } catch {
        history = null
      }
      const ctx = buildDeepAnalystContext(position, mark, account, rates, history ?? undefined, strategyLabel)
      const { data, error } = await fn<DeepAnalystResponse>('deep-analyst', {
        body: { ...ctx },
        timeout: 45_000,
        fallback: 'The Deep Analyst service is not reachable right now — try again in a moment.',
      })
      if (!mounted.current) return
      if (error) {
        setState({ phase: 'error', message: error })
        return
      }
      if (!data?.ok || !data.strategy) {
        setState({ phase: 'error', message: 'The Deep Analyst returned no usable strategy — try again.' })
        return
      }
      setState({ phase: 'done', result: data, at: Date.now() })
    } catch {
      if (mounted.current) {
        setState({ phase: 'error', message: "We couldn't run the analysis — please try again." })
      }
    }
  }, [position, mark, account, rates, strategyLabel, state.phase])

  const reset = useCallback(() => setState({ phase: 'idle' }), [])

  const meta = state.phase === 'done' ? VERDICT_META[state.result.strategy.verdict] : null

  return (
    <div className="rounded-xl border border-border bg-secondary/20 p-4" role="region" aria-label={`Deep Analyst — ${position.symbol}`}>
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <BrainCircuit className="h-4 w-4 text-accent" aria-hidden="true" />
          Deep Analyst
          <span className="text-xs font-normal text-muted-foreground">{position.symbol}</span>
          {state.phase === 'done' && (
            <Badge className="border-border bg-muted text-muted-foreground">
              {state.result.engine === 'gemini' ? 'Gemini' : state.result.engine === 'openai' ? 'OpenAI' : 'Built-in engine'}
            </Badge>
          )}
        </p>
        <div className="flex items-center gap-2">
          {state.phase === 'done' && (
            <span className="text-[11px] text-muted-foreground">{timeAgo(state.at)}</span>
          )}
          <Button variant="ghost" size="sm" onClick={reset} aria-label="Close Deep Analyst" title="Close">
            <X className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      </div>

      {state.phase === 'idle' && (
        <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="flex items-start gap-2 text-xs text-muted-foreground">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true" />
            {position.side === 'long' ? 'Long' : 'Short'} {position.symbol} from {formatPrice(position.entryPrice)} — mark{' '}
            {formatPrice(mark)} · P&amp;L{' '}
            <span className={cn('tnum font-semibold', pnl >= 0 ? 'text-up' : 'text-down')}>
              {formatUsd(pnl)}
            </span>
          </p>
        </div>
      )}

      {/* Body per phase */}
      {state.phase === 'idle' && (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            Get a disciplined management strategy for this open position — whether to hold, bank the profit, take
            partial profit, trail the stop or cut the loss, with exact price levels.
          </p>
          <Button size="sm" onClick={() => void analyze()}>
            <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
            Run Deep Analyst
          </Button>
        </div>
      )}

      {state.phase === 'loading' && (
        <div className="mt-3 space-y-2" aria-busy="true" aria-label="Analyzing position">
          <Skeleton className="h-5 w-40 rounded" />
          <Skeleton className="h-3.5 w-full rounded" />
          <Skeleton className="h-3.5 w-11/12 rounded" />
          <Skeleton className="h-3.5 w-3/4 rounded" />
        </div>
      )}

      {state.phase === 'error' && (
        <div className="mt-3 rounded-lg border border-amber/40 bg-amber/10 px-3 py-2.5">
          <p className="flex items-start gap-2 text-xs text-amber">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {state.message}
          </p>
          <Button variant="secondary" size="sm" className="mt-2" onClick={() => void analyze()}>
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            Try again
          </Button>
        </div>
      )}

      {state.phase === 'done' && meta && (
        <ResultView result={state.result} meta={meta} signedIn={!!user} onRefresh={() => void analyze()} />
      )}
    </div>
  )
}

function ResultView({
  result,
  meta,
  signedIn,
  onRefresh,
}: {
  result: DeepAnalystResponse
  meta: (typeof VERDICT_META)[AnalystStrategy['verdict']]
  signedIn: boolean
  onRefresh: () => void
}) {
  const s = result.strategy
  return (
    <div className="mt-3 space-y-3">
      {result.note && (
        <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground" role="note">
          {result.note}
          {result.ai_requires_login && !signedIn && (
            <>
              {' '}
              <Link to="/auth" className="font-semibold text-accent underline underline-offset-2">
                Sign in
              </Link>{' '}
              to enable AI analysis.
            </>
          )}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <span title={meta.hint}>
          <Badge className={cn('border', meta.className)}>{meta.label}</Badge>
        </span>
        <span className="text-sm font-medium text-foreground">{s.action}</span>
      </div>

      {/* Confidence */}
      <div>
        <div className="flex items-center justify-between gap-2 text-[11px] uppercase tracking-wide text-muted-foreground">
          <span>Confidence</span>
          <span className="tnum font-semibold text-foreground">{s.confidence}%</span>
        </div>
        <div
          className="mt-1 h-1.5 overflow-hidden rounded-full bg-secondary"
          role="meter"
          aria-valuenow={s.confidence}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Analysis confidence"
        >
          <div
            className={cn('h-full rounded-full transition-all duration-300', s.confidence >= 60 ? 'bg-up' : 'bg-amber')}
            style={{ width: `${s.confidence}%` }}
          />
        </div>
      </div>

      {/* Levels */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {s.targets.map((t, i) => (
          <div key={i} className="rounded-lg border border-border bg-secondary/40 px-3 py-2">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{t.label}</p>
            <p className="tnum text-sm font-semibold text-foreground">
              {t.price != null ? formatPrice(t.price) : '—'}
            </p>
            {t.note && <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{t.note}</p>}
          </div>
        ))}
        <div className="rounded-lg border border-down/30 bg-down/5 px-3 py-2">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Stop advice</p>
          <p className="tnum text-sm font-semibold text-foreground">
            {s.stop.price != null ? formatPrice(s.stop.price) : 'Keep current stop'}
          </p>
          {s.stop.note && <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{s.stop.note}</p>}
        </div>
      </div>

      {/* Reasoning */}
      {s.reasoning.length > 0 && (
        <ul className="space-y-1.5">
          {s.reasoning.map((r, i) => (
            <li key={i} className="flex items-start gap-2 text-xs text-muted-foreground">
              <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-accent" aria-hidden="true" />
              {r}
            </li>
          ))}
        </ul>
      )}

      {s.risks.length > 0 && (
        <p className="flex items-start gap-2 rounded-lg border border-amber/30 bg-amber/5 px-3 py-2 text-xs text-amber">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>
            <span className="font-semibold">Risk check — </span>
            {s.risks.join(' ')}
          </span>
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-2">
        <p className="text-[10px] text-muted-foreground">
          {result.model ? `Model: ${result.model} · ` : ''}
          Analysis only — it never places, modifies or closes a trade. Not financial advice.
        </p>
        <Button variant="ghost" size="sm" onClick={onRefresh}>
          <RefreshCw className="h-3 w-3" aria-hidden="true" />
          Re-analyze
        </Button>
      </div>
    </div>
  )
}
