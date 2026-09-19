/**
 * TradeJournal — every closed trade on the account, newest first. Shows the
 * pair, side, entry/exit, realized PnL (USD + %) and why it closed, so the
 * trader can review exactly what the robot (or they) did — and how the
 * risk guardrails behaved. A summary strip gives the at-a-glance record.
 *
 * The toolbar filters by result (wins/losses), time range and free text, and
 * sorts the rows — the strip on the right reflects only the trades shown.
 */
import { useMemo, useState } from 'react'
import { BookOpen, Search } from 'lucide-react'
import type { ClosedTrade } from '../../lib/trading/types'
import { formatDateTime, formatPct, formatPrice, formatUsd } from '../../lib/format'
import { cn } from '../../lib/cn'
import { Badge, EmptyState, Input, Select } from '../ui'
import { CollapsibleCard } from './CollapsibleCard'

const REASON_LABEL: Record<string, string> = {
  signal: 'Signal',
  stop_loss: 'Stop loss',
  take_profit: 'Take profit',
  target: 'Money target',
  manual: 'Manual',
  margin: 'Margin call',
  pullback: 'Profit pullback',
  drawdown: 'Drawdown stop',
  risk: 'Risk',
  robot_stop: 'Robot stop',
}

type ResultFilter = 'all' | 'win' | 'loss'
type RangeFilter = 'all' | '7d' | '30d' | '90d'
type SortKey = 'newest' | 'oldest' | 'profit' | 'loss'

const DAY_MS = 86_400_000
const RANGE_DAYS: Record<Exclude<RangeFilter, 'all'>, number> = { '7d': 7, '30d': 30, '90d': 90 }

const RESULT_OPTIONS: { value: ResultFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'win', label: 'Wins' },
  { value: 'loss', label: 'Losses' },
]

const RANGE_OPTIONS: { value: RangeFilter; label: string }[] = [
  { value: 'all', label: 'All time' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
]

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'profit', label: 'Biggest win' },
  { value: 'loss', label: 'Biggest loss' },
]

export function TradeJournal({ trades }: { trades: ClosedTrade[] }) {
  const [result, setResult] = useState<ResultFilter>('all')
  const [range, setRange] = useState<RangeFilter>('all')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SortKey>('newest')

  const filtered = useMemo(() => {
    const cutoff = range === 'all' ? 0 : Date.now() - RANGE_DAYS[range] * DAY_MS
    const q = query.trim().toLowerCase()
    return trades
      .filter((t) => {
        if (result === 'win' && t.pnl <= 0) return false
        if (result === 'loss' && t.pnl >= 0) return false
        if (range !== 'all' && new Date(t.exitTime).getTime() < cutoff) return false
        if (q && !`${t.symbol} ${t.strategy ?? ''} ${REASON_LABEL[t.closeReason] ?? t.closeReason}`.toLowerCase().includes(q)) {
          return false
        }
        return true
      })
      .sort((a, b) => {
        switch (sort) {
          case 'oldest':
            return new Date(a.exitTime).getTime() - new Date(b.exitTime).getTime()
          case 'profit':
            return b.pnl - a.pnl
          case 'loss':
            return a.pnl - b.pnl
          default:
            return new Date(b.exitTime).getTime() - new Date(a.exitTime).getTime()
        }
      })
  }, [trades, result, range, query, sort])

  const wins = trades.filter((t) => t.pnl > 0).length
  const losses = trades.filter((t) => t.pnl < 0).length
  const net = trades.reduce((sum, t) => sum + t.pnl, 0)

  const fWins = filtered.filter((t) => t.pnl > 0).length
  const fLosses = filtered.filter((t) => t.pnl < 0).length
  const fNet = filtered.reduce((sum, t) => sum + t.pnl, 0)

  const filtersActive = result !== 'all' || range !== 'all' || query.trim() !== '' || sort !== 'newest'
  const clearFilters = () => {
    setResult('all')
    setRange('all')
    setQuery('')
    setSort('newest')
  }

  return (
    <CollapsibleCard
      title="Trade journal"
      icon={<BookOpen className="h-4 w-4 text-accent" aria-hidden="true" />}
      actions={
        <>
          {trades.length > 0 && (
            <>
              <span className="text-xs text-muted-foreground">{trades.length} trades</span>
              <span className="text-xs">
                <span className="text-up">{wins}W</span>
                <span className="mx-1 text-muted-foreground">·</span>
                <span className="text-down">{losses}L</span>
              </span>
              <span className={cn('text-xs font-mono tnum font-semibold', net >= 0 ? 'text-up' : 'text-down')}>
                net {formatUsd(net)}
              </span>
            </>
          )}
        </>
      }
    >
      {trades.length === 0 ? (
        <EmptyState
          icon={<BookOpen className="h-6 w-6" aria-hidden="true" />}
          title="No closed trades yet"
          message="Once a position is closed — manually, by a stop, or by the robot — it lands here with its full P&L."
        />
      ) : (
        <>
          {/* Filter bar */}
          <div className="mb-3 flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <div
                className="flex items-center gap-1 rounded-lg border border-border bg-secondary/40 p-1"
                role="group"
                aria-label="Filter by result"
              >
                {RESULT_OPTIONS.map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    aria-pressed={result === o.value}
                    onClick={() => setResult(o.value)}
                    className={cn(
                      'h-7 cursor-pointer rounded-md px-2.5 text-xs font-medium transition-colors duration-150',
                      result === o.value ? 'bg-accent text-black' : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
              <div
                className="flex items-center gap-1 rounded-lg border border-border bg-secondary/40 p-1"
                role="group"
                aria-label="Filter by time"
              >
                {RANGE_OPTIONS.map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    aria-pressed={range === o.value}
                    onClick={() => setRange(o.value)}
                    className={cn(
                      'h-7 cursor-pointer rounded-md px-2.5 text-xs font-medium transition-colors duration-150',
                      range === o.value ? 'bg-accent text-black' : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
              <div className="relative min-w-0 flex-1 sm:max-w-64">
                <Search
                  className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
                  aria-hidden="true"
                />
                <Input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search pair, strategy, reason…"
                  aria-label="Search trades"
                  className="pl-8"
                />
              </div>
              <div className="w-full sm:w-44">
                <Select aria-label="Sort trades" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
                  {SORT_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
            <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
              <span>
                {filtered.length} of {trades.length} trades
              </span>
              {filtersActive && (
                <>
                  <span>
                    <span className="text-up">{fWins}W</span>
                    <span className="mx-1">·</span>
                    <span className="text-down">{fLosses}L</span>
                  </span>
                  <span className={cn('font-mono tnum font-semibold', fNet >= 0 ? 'text-up' : 'text-down')}>
                    {formatUsd(fNet)}
                  </span>
                  <button
                    type="button"
                    onClick={clearFilters}
                    className="cursor-pointer font-medium text-accent underline decoration-accent/40 underline-offset-2 transition-colors duration-150 hover:text-foreground"
                  >
                    Show all
                  </button>
                </>
              )}
            </p>
          </div>

          {filtered.length === 0 ? (
            <div className="rounded-lg border border-border bg-muted/40 px-3 py-6 text-center text-sm text-muted-foreground">
              No trades match these filters —{' '}
              <button
                type="button"
                onClick={clearFilters}
                className="cursor-pointer font-medium text-accent underline-offset-2 hover:underline"
              >
                reset filters
              </button>
              .
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                    <th className="pb-2 pr-4 font-medium">Pair</th>
                    <th className="pb-2 pr-4 font-medium">Side</th>
                    <th className="pb-2 pr-4 text-right font-medium">Prob.</th>
                    <th className="pb-2 pr-4 text-right font-medium">Entry → Exit</th>
                    <th className="pb-2 pr-4 text-right font-medium">P&amp;L</th>
                    <th className="pb-2 pr-4 text-right font-medium">P&amp;L %</th>
                    <th className="pb-2 pr-4 font-medium">Reason</th>
                    <th className="pb-2 pr-4 font-medium">Strategy</th>
                    <th className="pb-2 text-right font-medium">Closed</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((t) => (
                    <tr key={t.id} className="border-b border-border/50 last:border-b-0">
                      <td className="py-2.5 pr-4 font-medium text-foreground">{t.symbol}</td>
                      <td className="py-2.5 pr-4">
                        <span className="flex items-center gap-1.5 capitalize text-muted-foreground">
                          <span
                            aria-hidden="true"
                            className={cn('inline-block h-1.5 w-1.5 rounded-full', t.pnl > 0 ? 'bg-up' : 'bg-down')}
                          />
                          {t.side}
                        </span>
                      </td>
                      <td className="tnum py-2.5 pr-4 text-right text-xs">
                        {t.entryProbability != null ? (
                          <span
                            className={cn(
                              'font-mono font-semibold',
                              t.entryProbability >= 0.5 ? 'text-up' : 'text-amber',
                            )}
                            title={`Estimated probability of profit at entry: ${Math.round(t.entryProbability * 100)}%`}
                          >
                            {Math.round(t.entryProbability * 100)}%
                          </span>
                        ) : (
                          <span className="font-mono text-muted-foreground/60">—</span>
                        )}
                      </td>
                      <td className="tnum py-2.5 pr-4 text-right font-mono text-xs text-muted-foreground">
                        {formatPrice(t.entryPrice)} → {formatPrice(t.exitPrice)}
                      </td>
                      <td
                        className={cn(
                          'tnum py-2.5 pr-4 text-right font-mono font-semibold',
                          t.pnl >= 0 ? 'text-up' : 'text-down',
                        )}
                      >
                        {formatUsd(t.pnl)}
                      </td>
                      <td
                        className={cn(
                          'tnum py-2.5 pr-4 text-right font-mono text-xs',
                          t.pnl >= 0 ? 'text-up' : 'text-down',
                        )}
                      >
                        {formatPct(t.pnlPct)}
                      </td>
                      <td className="py-2.5 pr-4">
                        <Badge className="border-border bg-muted text-muted-foreground">
                          {REASON_LABEL[t.closeReason] ?? t.closeReason}
                        </Badge>
                      </td>
                      <td className="py-2.5 pr-4 text-xs text-muted-foreground">{t.strategy ?? '—'}</td>
                      <td className="py-2.5 text-right text-xs text-muted-foreground">{formatDateTime(t.exitTime)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </CollapsibleCard>
  )
}