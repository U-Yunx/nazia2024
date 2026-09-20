/**
 * RobotLivePrices — live price strip for the pairs the robot is watching.
 * Subscribes to the same Realtime broadcast the rest of the app uses, so the
 * numbers move the moment fresh quotes land. Pairs whose market is closed or
 * whose feed is stale are flagged instead of silently showing an unmoving
 * price, so a weekend FX session reads as "closed", not "broken".
 */
import { useState } from 'react'
import { Activity, ChevronLeft, ChevronRight } from 'lucide-react'
import type { Quote } from '../../lib/types'
import { useQuotes } from '../../hooks/useMarketData'
import { formatChange, formatPct, formatPrice } from '../../lib/format'
import { cn } from '../../lib/cn'
import { Button } from '../ui'

/** How many live pairs fit on one page. */
const PAGE_SIZE = 6

export function RobotLivePrices({ pairs }: { pairs: string[] }) {
  const { quotes, loading, error } = useQuotes(15_000, pairs)

  const rows = (quotes ?? []).filter((q) => pairs.includes(q.symbol))
  const [page, setPage] = useState(0)
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE))
  // Clamp in case the watchlist shrinks while the user is on a later page.
  const currentPage = Math.min(page, pageCount - 1)
  const visibleRows = rows.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE)
  const anyClosed = rows.some((q) => q.is_market_open === false)
  const anyStale = rows.some((q) => q.stale && q.is_market_open !== false)

  if (loading && rows.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-secondary/30 p-4">
        <p className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-foreground">
          <Activity className="h-4 w-4 text-accent" aria-hidden="true" />
          Live prices
        </p>
        <p className="text-sm text-muted-foreground">Loading prices…</p>
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-border bg-secondary/30 p-4">
      <p className="mb-3 flex items-center justify-between gap-1.5 text-sm font-semibold text-foreground">
        <span className="flex items-center gap-1.5">
          <Activity className="h-4 w-4 text-accent" aria-hidden="true" />
          Live prices
        </span>
        {rows.length > 0 && <span className="text-[11px] font-normal text-muted-foreground">{rows.length} pair{rows.length === 1 ? '' : 's'}</span>}
      </p>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{error ?? 'Waiting for prices…'}</p>
      ) : (
        <>
          <ul className="space-y-2" aria-live="polite">
            {visibleRows.map((q) => (
              <QuoteRow key={q.symbol} quote={q} />
            ))}
          </ul>
          {pageCount > 1 && (
            <div className="mt-3 flex items-center justify-between gap-2 border-t border-border/70 pt-2.5">
              <Button
                variant="ghost"
                size="sm"
                className="px-2.5"
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={currentPage === 0}
                aria-label="Previous page of live prices"
              >
                <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
                Prev
              </Button>
              <span className="tnum text-[11px] text-muted-foreground" aria-live="polite">
                Page {currentPage + 1} of {pageCount}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="px-2.5"
                onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                disabled={currentPage === pageCount - 1}
                aria-label="Next page of live prices"
              >
                Next
                <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
            </div>
          )}
          {(anyClosed || anyStale) && (
            <p className="mt-3 border-t border-border/70 pt-2 text-[11px] leading-relaxed text-muted-foreground">
              {anyClosed
                ? 'Some pairs are closed right now — the price shown is their last available quote. Crypto pairs (BTC, ETH, …) trade 24/7.'
                : 'Some prices are temporarily stale because the feed is throttled — they recover automatically.'}
            </p>
          )}
        </>
      )}
    </div>
  )
}

function QuoteRow({ quote }: { quote: Quote }) {
  const up = (quote.change ?? 0) >= 0
  const closed = quote.is_market_open === false
  const stale = !closed && quote.stale
  return (
    <li className="flex items-center justify-between gap-2 text-sm">
      <span className="flex items-center gap-1.5 font-medium text-foreground">
        {quote.symbol}
        {(closed || stale) && (
          <span
            className={cn(
              'inline-flex items-center gap-1 rounded border px-1 py-px text-[10px] font-medium uppercase tracking-wide',
              closed ? 'border-amber/40 bg-amber/10 text-amber' : 'border-border bg-muted text-muted-foreground',
            )}
            title={
              closed
                ? 'Market closed — showing the last available price'
                : 'Feed stale — showing the last available price'
            }
          >
            <span className={cn('h-1 w-1 rounded-full', closed ? 'bg-amber' : 'bg-muted-foreground')} aria-hidden="true" />
            {closed ? 'Closed' : 'Stale'}
          </span>
        )}
      </span>
      <span className="flex items-center gap-2">
        <span className="font-mono tnum text-foreground">
          {quote.price != null ? formatPrice(quote.price) : '—'}
        </span>
        {quote.change != null && (
          <span className={cn('font-mono tnum text-xs', up ? 'text-up' : 'text-down')}>
            {formatChange(quote.change)}
          </span>
        )}
        {quote.percent_change != null && (
          <span className={cn('hidden font-mono tnum text-xs sm:inline', up ? 'text-up' : 'text-down')}>
            {formatPct(quote.percent_change)}
          </span>
        )}
      </span>
    </li>
  )
}