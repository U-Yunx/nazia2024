/**
 * DashboardLeaderboard — community profit leaderboard card for the signed-in
 * landing page.
 *
 * Reuses the same public, name-masked feed as the Home page
 * (get_leaderboard via useLeaderboard): only a masked handle + numbers ever
 * leave the database — no emails, real names or user ids. Polls every 60s.
 */
import { useEffect, useState } from 'react'
import { Trophy } from 'lucide-react'
import { useLeaderboard } from '../hooks/useLiveCommunity'
import { formatUsd, timeAgo } from '../lib/format'
import { cn } from '../lib/cn'
import { Card, CardContent, CardHeader, CardTitle, Skeleton } from './ui'

export function DashboardLeaderboard() {
  const { entries, loading } = useLeaderboard(6, 60_000)
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)

  // Track the last successful refresh so the card always shows its freshness.
  useEffect(() => {
    if (entries.length > 0) setUpdatedAt(Date.now())
  }, [entries])

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Trophy className="h-4 w-4 text-accent" aria-hidden="true" />
          Community leaderboard
        </CardTitle>
        {updatedAt != null && (
          <span className="shrink-0 text-[11px] text-muted-foreground">Updated {timeAgo(updatedAt)}</span>
        )}
      </CardHeader>
      <CardContent>
        <p className="mb-3 text-xs text-muted-foreground">
          Top traders by best single profit · names masked for privacy
        </p>

        {loading && entries.length === 0 ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-hidden="true">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full rounded-xl" />
            ))}
          </div>
        ) : entries.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border bg-secondary/20 px-4 py-8 text-center">
            <Trophy className="mx-auto h-5 w-5 text-muted-foreground/60" aria-hidden="true" />
            <p className="mt-2 text-sm font-medium text-foreground">The leaderboard is still warming up</p>
            <p className="mx-auto mt-1 max-w-xs text-xs leading-relaxed text-muted-foreground">
              Close a winning trade or finish a robot session in profit and you'll be the first name up here.
            </p>
          </div>
        ) : (
          <ol className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {entries.map((e, i) => (
              <li
                key={`${e.handle}-${i}`}
                className="surface-premium flex items-center justify-between gap-3 rounded-xl border border-border/70 px-4 py-3.5"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <span
                    className={cn(
                      'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold tnum',
                      i === 0 ? 'bg-amber/20 text-amber' : 'bg-secondary text-muted-foreground',
                    )}
                  >
                    {i + 1}
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-foreground">{e.handle}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {e.events} win{e.events === 1 ? '' : 's'} · {timeAgo(e.last_seen)}
                    </p>
                  </div>
                </div>
                <p
                  className={cn(
                    'shrink-0 tnum font-mono text-base font-bold',
                    e.best_profit >= 0 ? 'text-up' : 'text-down',
                  )}
                >
                  {formatUsd(e.best_profit)}
                </p>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  )
}