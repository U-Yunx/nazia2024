/**
 * PositionsTable — live open positions with mark-to-market PnL in USD, plus a
 * close button that routes through the active broker. Multi-pair robots: rows
 * are grouped by pair, each group shows an "open/cap" chip reflecting the
 * robot's trade mode and per-pair cap, and the card header shows the global
 * cap. Empty state explains that nothing is open yet and how to open a trade.
 */
import { Fragment, useState } from 'react'
import { Sparkles, X } from 'lucide-react'
import type { AccountState, Position, RatesMap, TradeMode } from '../../lib/trading/types'
import { MIN_TRADE_BALANCE_USD, ZIG_ZAG_MIN_PER_PAIR } from '../../lib/trading/engine'
import { pnlUsd } from '../../lib/trading/risk'
import { formatDateTime, formatPct, formatPrice, formatUnits, formatUsd } from '../../lib/format'
import { cn } from '../../lib/cn'
import { Badge, Button, EmptyState } from '../ui'
import { CollapsibleCard } from './CollapsibleCard'
import { DeepAnalystPanel } from './DeepAnalystPanel'

export interface RobotCaps {
  tradeMode: TradeMode
  maxPerPair: number
  maxOpenTrades: number
}

function perPairCap(caps?: RobotCaps): number {
  if (!caps) return 1
  return Math.max(1, caps.maxPerPair)
}

/** True when the robot is placing reverse-order (zig-zag) legs on each pair:
 *  concurrent mode with a cap above two, so the legs past the second alternate
 *  direction (long, long, short, long…). */
function zigZagOn(caps?: RobotCaps): boolean {
  return !!caps && caps.tradeMode === 'concurrent' && perPairCap(caps) >= ZIG_ZAG_MIN_PER_PAIR
}

export function PositionsTable({
  account,
  rates,
  onClose,
  robotCaps,
}: {
  account: AccountState
  rates: RatesMap
  onClose: (id: string) => void
  robotCaps?: RobotCaps
}) {
  const { positions } = account
  // Which position row has its Deep Analyst panel expanded (one at a time).
  const [expandedId, setExpandedId] = useState<string | null>(null)
  // Pull-back lock status for the rows: when armed (> $1 profit reached), show
  // the peak and the $ level it will close at (peak × give-back). Mirrors the
  // engine rule exactly so the UI tells the trader what the robot will do.
  const pullbackPct = account.risk.profitPullbackPct ?? 0
  const pullbackActivate = account.risk.profitPullbackActivateUsd ?? 1
  // Sub-$1 balance: every trading control locks (the engine refuses entries
  // and the emergency closeout handles a blown account) — close buttons
  // included, per the account-safety rule.
  const locked = account.balance < MIN_TRADE_BALANCE_USD

  // Group positions by pair, preserving watchlist order.
  const bySymbol = new Map<string, Position[]>()
  for (const p of positions) {
    const arr = bySymbol.get(p.symbol) ?? []
    arr.push(p)
    bySymbol.set(p.symbol, arr)
  }
  const groups = [...bySymbol.entries()]

  return (
    <CollapsibleCard
      title="Open positions"
      actions={
        <>
          {positions.length > 0 && (
            <span className="text-xs text-muted-foreground">
              {positions.length} open{robotCaps ? ` · max ${robotCaps.maxOpenTrades}` : ''}
            </span>
          )}
          {robotCaps && (
            // The Badge takes only className/children, so the explanatory
            // tooltip lives on a thin wrapper around it.
            <span
              title={
                zigZagOn(robotCaps)
                  ? `Concurrent, ${perPairCap(robotCaps)}/pair — legs past the second alternate direction (reverse-order zig-zag).`
                  : undefined
              }
            >
              <Badge className="border-border bg-muted text-muted-foreground">
                {robotCaps.tradeMode === 'concurrent' ? 'Concurrent' : 'Sequential'} · {perPairCap(robotCaps)}/pair
                {zigZagOn(robotCaps) ? ' · zig-zag' : ''}
              </Badge>
            </span>
          )}
        </>
      }
    >
        {positions.length === 0 ? (
          <EmptyState
            title="No open positions"
            message="Open a trade with the form above, or start the robot and it will trade on signals automatically."
          />
        ) : (
          <div className="space-y-4">
            {locked && (
              <p role="status" className="rounded-lg border border-amber/40 bg-amber/10 px-3 py-2 text-xs text-amber">
                Balance is below $1 — trading is locked, so positions can no longer be closed manually. The robot
                closes everything automatically if balance or equity ever hits $0.01.
              </p>
            )}
            {groups.map(([symbol, rows]) => {
              const cap = perPairCap(robotCaps)
              const atCap = rows.length >= cap
              return (
                <div key={symbol} className="overflow-hidden rounded-lg border border-border/60">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 bg-secondary/40 px-3 py-2">
                    <span className="whitespace-nowrap text-sm font-semibold text-foreground">{symbol}</span>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge
                        className={cn(
                          atCap ? 'border-amber/40 bg-amber/10 text-amber' : 'border-border bg-muted text-muted-foreground',
                        )}
                      >
                        {rows.length}/{cap} open
                      </Badge>
                      <span className="whitespace-nowrap text-xs text-muted-foreground">
                        {rows.length} position{rows.length === 1 ? '' : 's'}
                      </span>
                    </div>
                  </div>
                  {/* The table scrolls inside its own wrapper so the right-hand
                      columns (P&L, Opened, Close) stay reachable on narrow
                      screens — a clipped ancestor would otherwise cut them off. */}
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[680px] text-sm">
                      <thead>
                        <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                          <th className="whitespace-nowrap pb-2 pr-4 font-medium">Side</th>
                          <th className="whitespace-nowrap pb-2 pr-4 text-right font-medium">Units</th>
                          <th className="whitespace-nowrap pb-2 pr-4 text-right font-medium">Entry</th>
                          <th className="whitespace-nowrap pb-2 pr-4 text-right font-medium">Mark</th>
                          <th className="whitespace-nowrap pb-2 pr-4 text-right font-medium">Stop / Target</th>
                          <th className="whitespace-nowrap pb-2 pr-4 text-right font-medium">P&L</th>
                          <th className="whitespace-nowrap pb-2 pr-4 text-right font-medium">Opened</th>
                          <th className="whitespace-nowrap pb-2 font-medium" aria-label="Actions" />
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((p) => {
                          const mark = rates[p.symbol] ?? p.entryPrice
                          const pnl = pnlUsd(p.side, p.entryPrice, mark, p.units, p.symbol, rates)
                          const expanded = expandedId === p.id
                          return (
                            <Fragment key={p.id}>
                            <tr className={cn('border-b border-border/60 last:border-b-0', expanded && 'bg-secondary/10')}>
                              <td className="whitespace-nowrap py-3 pr-4">
                                <span
                                  className={cn(
                                    'rounded px-1.5 py-0.5 text-xs font-semibold',
                                    p.side === 'long' ? 'bg-up/15 text-up' : 'bg-down/15 text-down',
                                  )}
                                >
                                  {p.side.toUpperCase()}
                                </span>
                              </td>
                              <td className="tnum whitespace-nowrap py-3 pr-4 text-right font-mono">{formatUnits(p.units)}</td>
                              <td className="tnum whitespace-nowrap py-3 pr-4 text-right font-mono">{formatPrice(p.entryPrice)}</td>
                              <td className="tnum whitespace-nowrap py-3 pr-4 text-right font-mono">{formatPrice(mark)}</td>
                              <td className="tnum whitespace-nowrap py-3 pr-4 text-right font-mono">
                                {formatPrice(p.stopPrice)} / {formatPrice(p.takeProfitPrice)}
                              </td>
                              <td
                                className={cn(
                                  'tnum whitespace-nowrap py-3 pr-4 text-right font-mono font-semibold',
                                  pnl >= 0 ? 'text-up' : 'text-down',
                                )}
                              >
                                {formatUsd(pnl)}
                                <span className={cn('ml-2 text-xs font-normal', pnl >= 0 ? 'text-up/80' : 'text-down/80')}>
                                  {formatPct(p.entryEquity > 0 ? (pnl / p.entryEquity) * 100 : 0)}
                                </span>
                                {pullbackPct > 0 && (() => {
                                  const peak = p.peakProfitUsd ?? 0
                                  const armed = peak > pullbackActivate
                                  const lock = peak * (1 - pullbackPct / 100)
                                  return (
                                    <span
                                      className={cn(
                                        'mt-1 block rounded px-1.5 py-0.5 text-[10px] font-medium not-italic',
                                        armed ? 'bg-cyan/15 text-cyan' : 'bg-muted/60 text-muted-foreground',
                                      )}
                                      title={
                                        armed
                                          ? `Pull-back armed — peak ${formatUsd(peak)}, closes at ${formatUsd(lock)} (${pullbackPct}% give-back)`
                                          : `Pull-back inactive — arms once profit exceeds ${formatUsd(pullbackActivate)}`
                                      }
                                    >
                                      {armed
                                        ? `⇣ lock ${formatUsd(lock)} · peak ${formatUsd(peak)}`
                                        : `⇣ arm > ${formatUsd(pullbackActivate)}`}
                                    </span>
                                  )
                                })()}
                              </td>
                              <td className="whitespace-nowrap py-3 pr-4 text-right text-xs text-muted-foreground">
                                {formatDateTime(p.entryTime)}
                              </td>
                              <td className="whitespace-nowrap py-3 text-right">
                                <div className="flex items-center justify-end gap-1.5">
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => setExpandedId(expanded ? null : p.id)}
                                    aria-expanded={expanded}
                                    aria-controls={`deep-analyst-${p.id}`}
                                    title="Deep Analyst — AI management strategy for this position"
                                    aria-label={`Deep Analyst for ${p.symbol} position`}
                                  >
                                    <Sparkles className={cn('h-3.5 w-3.5 transition-colors duration-150', expanded ? 'text-accent' : '')} aria-hidden="true" />
                                    {expanded ? 'Close' : 'Analyst'}
                                  </Button>
                                  <Button
                                    variant="danger"
                                    size="sm"
                                    onClick={() => onClose(p.id)}
                                    disabled={locked}
                                    title={locked ? 'Trading is locked below $1 balance' : undefined}
                                    aria-label={`Close ${p.symbol} position`}
                                  >
                                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                                    Close
                                  </Button>
                                </div>
                              </td>
                            </tr>
                            {expanded && (
                              <tr>
                                <td
                                  id={`deep-analyst-${p.id}`}
                                  colSpan={8}
                                  className="border-b border-border/60 bg-secondary/10 px-3 pb-3 pt-1"
                                >
                                  <DeepAnalystPanel
                                    position={p}
                                    mark={mark}
                                    account={account}
                                    rates={rates}
                                    strategyLabel={p.strategy}
                                  />
                                </td>
                              </tr>
                            )}
                            </Fragment>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )
            })}
          </div>
        )}
    </CollapsibleCard>
  )
}