/**
 * MarketPairsTable — the full watchlist as a dense, sortable table: pair,
 * asset class, market status, price, change, % change and a live
 * probability-of-profit estimate. Default order is "best setups first" — open
 * markets on top, then the highest probability of profit. Used on the public
 * Market pairs page.
 */
import { useMemo, useState } from 'react'
import { CandlestickChart } from 'lucide-react'
import type { Quote } from '../lib/types'
import { WATCHLIST, isCryptoPair, isMetalPair } from '../lib/watchlist'
import { scorePair, sortMarketRows, type MarketSort } from '../lib/marketScore'
import { formatChange, formatPct, formatPrice, timeAgo } from '../lib/format'
import { cn } from '../lib/cn'
import { Badge, Card, CardContent, CardHeader, CardTitle, Select } from './ui'

const SORT_OPTIONS: { value: MarketSort; label: string }[] = [
  { value: 'rank', label: 'Open markets, best setups first' },
  { value: 'momentum', label: 'Biggest move first' },
  { value: 'az', label: 'Alphabetical (A–Z)' },
]

function scoreColor(p: number): string {
  if (p >= 70) return 'bg-emerald-500'
  if (p >= 55) return 'bg-accent'
  return 'bg-muted-foreground/60'
}

export function MarketPairsTable({ quotes }: { quotes: Quote[] | null }) {
  const [mode, setMode] = useState<MarketSort>('rank')

  const { rows, quoting, open } = useMemo(() => {
    const base = WATCHLIST.map((p) => ({
      symbol: p.symbol,
      quote: quotes?.find((q) => q.symbol === p.symbol),
    }))
    const quoting = base.filter((r) => r.quote?.price != null).length
    const open = base.filter((r) => scorePair(r.symbol, r.quote).active).length
    return { rows: sortMarketRows(base, mode), quoting, open }
  }, [quotes, mode])

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <CandlestickChart className="h-4 w-4 text-accent" aria-hidden="true" />
              Watchlist
            </CardTitle>
            <span className="mt-0.5 block text-xs text-muted-foreground">
              {quoting}/{WATCHLIST.length} pairs quoting · {open} markets open
            </span>
          </div>
          <Select
            label="Sort"
            value={mode}
            onChange={(e) => setMode(e.target.value as MarketSort)}
            className="w-auto min-w-[15rem]"
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </div>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <th className="pb-2 pr-4 font-medium">Pair</th>
                <th className="pb-2 pr-4 font-medium">Market</th>
                <th className="pb-2 pr-4 font-medium">Status</th>
                <th className="pb-2 pr-4 text-right font-medium">Price</th>
                <th className="pb-2 pr-4 text-right font-medium">Change</th>
                <th className="pb-2 pr-4 text-right font-medium">%</th>
                <th
                  className="pb-2 text-right font-medium"
                  title="Probability-of-profit estimate from live momentum and volatility (5–99)"
                >
                  Score
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ symbol, quote }) => {
                const price = quote?.price
                const change = quote?.percent_change ?? quote?.change ?? 0
                const meta = scorePair(symbol, quote)
                const isMetal = isMetalPair(symbol)
                const isCrypto = isCryptoPair(symbol)
                return (
                  <tr key={symbol} className="border-b border-border/50 last:border-b-0">
                    <td className="py-2.5 pr-4">
                      <span className="font-medium text-foreground">{symbol}</span>
                      <span className="ml-2 hidden text-xs text-muted-foreground sm:inline">
                        {WATCHLIST.find((p) => p.symbol === symbol)?.name}
                      </span>
                    </td>
                    <td className="py-2.5 pr-4">
                      <Badge
                        className={cn(
                          isCrypto && 'border-accent/30 text-accent',
                          isMetal && 'border-amber-400/40 bg-amber-400/5 text-amber-600',
                        )}
                      >
                        {isCrypto ? 'Crypto' : isMetal ? 'Metal' : 'Forex'}
                      </Badge>
                    </td>
                    <td className="py-2.5 pr-4">
                      <span className="inline-flex items-center gap-1.5 text-xs">
                        <span
                          aria-hidden="true"
                          className={cn('h-1.5 w-1.5 rounded-full', meta.active ? 'bg-emerald-500' : 'bg-muted-foreground/40')}
                        />
                        <span className={meta.active ? 'text-foreground' : 'text-muted-foreground'}>
                          {meta.active ? 'Open' : 'Closed'}
                        </span>
                      </span>
                    </td>
                    <td className="tnum py-2.5 pr-4 text-right font-mono text-foreground">
                      {price != null ? formatPrice(price) : '—'}
                    </td>
                    <td
                      className={cn(
                        'tnum py-2.5 pr-4 text-right font-mono',
                        price != null && (change < 0 ? 'text-down' : 'text-up'),
                      )}
                    >
                      {price != null ? formatChange(change) : '—'}
                    </td>
                    <td
                      className={cn(
                        'tnum py-2.5 pr-4 text-right font-mono',
                        price != null && (change < 0 ? 'text-down' : 'text-up'),
                      )}
                    >
                      {price != null ? formatPct(change) : '—'}
                    </td>
                    <td className="py-2.5 text-right">
                      {price != null ? (
                        <span className="inline-flex items-center justify-end gap-2" title={`Probability of profit ~${meta.probability}%`}>
                          <span className="tnum font-mono text-xs text-foreground">{meta.probability}</span>
                          <span className="h-1 w-10 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                            <span
                              className={cn('block h-full rounded-full', scoreColor(meta.probability))}
                              style={{ width: `${meta.probability}%` }}
                            />
                          </span>
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <div className="mt-3 flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
          <p>
            Score = estimated probability of profit from the live quote's momentum, direction and volatility.
          </p>
          <p className="shrink-0">
            {quotes && quotes.length > 0
              ? quotes[0]?.datetime
                ? `Updated ${timeAgo(quotes[0].datetime)}`
                : 'Waiting for updates…'
              : ''}
          </p>
        </div>
      </CardContent>
    </Card>
  )
}