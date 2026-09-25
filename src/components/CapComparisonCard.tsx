/**
 * Per-pair cap comparison table. Re-runs the current backtest at one, two and
 * four positions per pair so the effect of concurrency — and of the
 * reverse-order (zig-zag) legs that engage above two — can be read side by side
 * instead of guessed at. A toggle pins the comparison either to the live book
 * (zig-zag above two) or to a plain one-way stack, so the same cap can be A/B'd
 * with and without the alternating legs. Everything is computed client-side
 * from bars already loaded by the Backtester page.
 */
import { useMemo, useState } from 'react'
import { ArrowLeftRight, Scale } from 'lucide-react'
import type { Bar, StrategyConfig } from '../lib/types'
import type { MultiBacktestSettings } from '../lib/strategies/backtest'
import { bestCapRowIndex, comparePerPairCaps } from '../lib/strategies/capComparison'
import type { Side } from '../lib/trading/types'
import { formatNum, formatPct, formatUsd } from '../lib/format'
import { cn } from '../lib/cn'
import { Card, CardContent, CardHeader, CardTitle } from './ui'

/** The fill order as leg chips — L for long, S for short, left to right. */
function LegChips({ legs }: { legs: Side[] }) {
  return (
    <span className="flex flex-wrap items-center gap-1">
      {legs.map((side, i) => (
        <span
          key={i}
          className={cn(
            'inline-flex h-5 min-w-5 items-center justify-center rounded border px-1 font-mono text-[10px] font-bold',
            side === 'long' ? 'border-up/40 bg-up/15 text-up' : 'border-down/40 bg-down/15 text-down',
          )}
        >
          {side === 'long' ? 'L' : 'S'}
        </span>
      ))}
    </span>
  )
}

export function CapComparisonCard({
  barsBySymbol,
  strategy,
  settings,
}: {
  barsBySymbol: Record<string, Bar[]>
  strategy: StrategyConfig
  settings: MultiBacktestSettings
}) {
  const loaded = Object.keys(barsBySymbol).length
  // Live book (reverse-order legs above two per pair) vs a plain one-way stack
  // at the same caps — so the effect of the alternating legs is visible too.
  const [stack, setStack] = useState(false)
  const rows = useMemo(
    () =>
      loaded >= 2
        ? comparePerPairCaps(barsBySymbol, strategy, settings, { zigZag: stack ? false : undefined })
        : [],
    [barsBySymbol, strategy, settings, loaded, stack],
  )

  if (rows.length === 0) return null
  const best = bestCapRowIndex(rows)
  const anyTrades = rows.some((r) => r.result.metrics.totalTrades > 0)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Scale className="h-4 w-4 text-accent" aria-hidden="true" />
          Positions per pair — compared
        </CardTitle>
        <span className="text-xs text-muted-foreground">Same bars, same strategy, same costs</span>
      </CardHeader>
      <CardContent className="space-y-3">
        <div
          className="flex flex-wrap items-center gap-2"
          role="group"
          aria-label="Reverse-order (zig-zag) legs"
        >
          <ArrowLeftRight className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
          <span className="text-xs font-medium text-muted-foreground">Reverse-order legs</span>
          <button
            type="button"
            onClick={() => setStack(false)}
            aria-pressed={!stack}
            className={cn(
              'cursor-pointer rounded-lg border px-2.5 py-1 text-xs font-semibold transition-all duration-150 active:scale-[0.97]',
              !stack
                ? 'border-accent bg-accent/15 text-accent'
                : 'border-border bg-secondary/40 text-muted-foreground hover:text-foreground',
            )}
          >
            As live
          </button>
          <button
            type="button"
            onClick={() => setStack(true)}
            aria-pressed={stack}
            className={cn(
              'cursor-pointer rounded-lg border px-2.5 py-1 text-xs font-semibold transition-all duration-150 active:scale-[0.97]',
              stack
                ? 'border-accent bg-accent/15 text-accent'
                : 'border-border bg-secondary/40 text-muted-foreground hover:text-foreground',
            )}
          >
            One-way stack
          </button>
        </div>

        <div className="-mx-1 overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-sm">
            <caption className="sr-only">
              Backtest results for holding one, two and four positions per pair on the same
              historical bars, with {stack ? 'every leg following the signal' : 'the live reverse-order legs'}.
            </caption>
            <thead>
              <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <th scope="col" className="py-2 pl-1 pr-3 font-medium">
                  Positions/pair
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Mode
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Fill order
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  Trades
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  Net profit
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  Return
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  Max DD
                </th>
                <th scope="col" className="py-2 pl-3 pr-1 text-right font-medium">
                  Win rate
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => {
                const m = row.result.metrics
                const isBest = i === best && anyTrades
                return (
                  <tr
                    key={row.cap}
                    className={cn(
                      'border-b border-border/60 last:border-0',
                      isBest && 'bg-accent/5',
                    )}
                  >
                    <th
                      scope="row"
                      className="py-2.5 pl-1 pr-3 text-left font-semibold text-foreground"
                    >
                      <span className="flex items-center gap-2">
                        <span className="font-mono tnum">{row.cap}</span>
                        {isBest && (
                          <span className="rounded border border-accent/40 bg-accent/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent">
                            Best
                          </span>
                        )}
                      </span>
                    </th>
                    <td className="px-3 py-2.5 text-muted-foreground">
                      {row.zigZag
                        ? 'Concurrent · zig-zag'
                        : row.tradeMode === 'sequential'
                          ? 'Sequential'
                          : stack
                            ? 'Concurrent · one-way'
                            : 'Concurrent'}
                    </td>
                    <td className="px-3 py-2.5">
                      <LegChips legs={row.sequence} />
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono tnum text-muted-foreground">
                      {m.totalTrades}
                    </td>
                    <td
                      className={cn(
                        'px-3 py-2.5 text-right font-mono tnum font-semibold',
                        m.netProfit >= 0 ? 'text-up' : 'text-down',
                      )}
                    >
                      {formatUsd(m.netProfit)}
                    </td>
                    <td
                      className={cn(
                        'px-3 py-2.5 text-right font-mono tnum',
                        m.totalReturnPct >= 0 ? 'text-up' : 'text-down',
                      )}
                    >
                      {formatPct(m.totalReturnPct)}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono tnum text-down">
                      {formatPct(m.maxDrawdownPct)}
                    </td>
                    <td className="py-2.5 pl-3 pr-1 text-right font-mono tnum text-muted-foreground">
                      {formatPct(m.winRatePct)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        <p className="text-xs text-muted-foreground">
          {!anyTrades ? (
            <>No signals fired on these bars — try another timeframe or pair to compare caps.</>
          ) : (
            <>
              {stack ? (
                <>
                  Every leg follows the signal, so a pair that keeps signalling fills an entirely{' '}
                  <span className="text-foreground">one-way stack</span> (L, L, L, L…). Switch back to{' '}
                  <span className="text-foreground">As live</span> to see the same caps with reverse-order legs, where
                  the first two follow the signal and every leg after that alternates (L, L, S, L…) and a reversal
                  closes only the legs facing the wrong way.
                </>
              ) : (
                <>
                  With reverse-order legs at cap 3 and above, the first two legs follow the signal and every leg after
                  that alternates (L, L, S, L…), and a reversal closes only the legs facing the wrong way. Switch to{' '}
                  <span className="text-foreground">One-way stack</span> to see the same caps with every leg on the
                  signal side.
                </>
              )}{' '}
              &ldquo;Best&rdquo; is the highest net profit, with the shallower drawdown winning ties (
              {formatNum(rows[best]?.result.metrics.profitFactor ?? 0, 2)} profit factor on the leader).
            </>
          )}
        </p>
      </CardContent>
    </Card>
  )
}
