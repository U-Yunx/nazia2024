/**
 * MarketStatus — a compact summary strip of the market feed: how many watchlist
 * pairs are quoting right now, market open/closed state, and whether the feed
 * is stale (upstream quota hit). Takes the same `quotes` array the pages get
 * from `useQuotes`.
 */
import type { Quote } from '../lib/types'
import { WATCHLIST } from '../lib/watchlist'
import { isPairOpen } from '../lib/marketHours'
import { timeAgo } from '../lib/format'
import { cn } from '../lib/cn'

export function MarketStatus({ quotes }: { quotes: Quote[] | null }) {
  const live = quotes?.filter((q) => q.price != null) ?? []
  const anyStale = quotes?.some((q) => q.stale) ?? false
  const lastUpdated = quotes?.[0]?.datetime ?? null
  const openCount = WATCHLIST.filter((p) => isPairOpen(p.symbol)).length

  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-border bg-secondary/30 px-4 py-2.5 text-xs text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <span
          className={cn('h-2 w-2 rounded-full', anyStale ? 'bg-amber animate-pulse-dot' : 'bg-up animate-pulse-dot')}
          aria-hidden="true"
        />
        {anyStale ? <span className="font-medium text-amber">Stale feed</span> : <span className="font-medium text-up">Live feed</span>}
      </span>
      <span className="tnum font-mono text-foreground">
        <span className="text-up">{live.length}</span>/{WATCHLIST.length} pairs quoting
      </span>
      <span>
        <span className="font-semibold text-accent">{openCount}</span> markets open now
      </span>
      {lastUpdated && <span className="ml-auto tnum font-mono text-foreground">Updated {timeAgo(lastUpdated)}</span>}
    </div>
  )
}