/**
 * Shared trading-workspace UI — mode toggle, method toggle, live-broker
 * summary/banners and the paper seed presets. Used by BOTH the robot control
 * room (src/pages/Trading.tsx) and the manual trading workspace
 * (src/pages/trading/ManualWorkspace.tsx) so every workspace behaves
 * identically: same mode choices, same live-account summary, same warnings.
 */
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ShieldAlert } from 'lucide-react'
import type { BrokerConnectionRow, TradingMethod } from '../../lib/types'
import type { BrokerMode } from '../../lib/trading/types'
import { methodLabel } from '../../lib/trading/robotPrefs'
import { fn as invokeEdge } from '../../lib/functions'
import { formatUsd } from '../../lib/format'
import { cn } from '../../lib/cn'
import { Card, CardContent, Skeleton } from '../ui'

/** Quick-start account sizes — micro accounts from $10 up to the standard $10k. */
export const SEED_PRESETS: { label: string; value: number }[] = [
  { label: 'Micro $10', value: 10 },
  { label: 'Mini $25', value: 25 },
  { label: '$50', value: 50 },
  { label: '$100', value: 100 },
  { label: '$1k', value: 1000 },
  { label: 'Standard $10k', value: 10_000 },
]

export function ModeToggle({ mode, onChange }: { mode: BrokerMode; onChange: (m: BrokerMode) => void }) {
  const options: { value: BrokerMode; label: string; hint?: string }[] = [
    { value: 'paper', label: 'Paper' },
    { value: 'managed', label: 'Live (managed)' },
    { value: 'oanda', label: 'Live (OANDA)' },
    { value: 'mt', label: 'Live (MT4/5)' },
  ]
  return (
    <div className="flex w-full flex-col items-stretch gap-1 sm:w-auto sm:items-end">
      <div
        className="grid w-full grid-cols-2 gap-1 rounded-lg border border-border bg-secondary/40 p-1 sm:inline-flex sm:w-auto sm:flex-nowrap"
        role="group"
        aria-label="Trading mode"
      >
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            aria-pressed={mode === o.value}
            className={cn(
              'h-10 cursor-pointer rounded-md px-3 text-sm font-medium transition-colors duration-150 sm:h-8',
              mode === o.value ? 'bg-accent text-black' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
      {mode === 'mt' && (
        <span className="text-xs text-muted-foreground">
          For real live MetaTrader trading, prefer <span className="text-accent">OANDA</span> or{' '}
          <span className="text-accent">managed</span> — MT needs the platform's MetaApi bridge configured.
        </span>
      )}
    </div>
  )
}

export function MethodToggle({ method, onChange }: { method: TradingMethod; onChange: (m: TradingMethod) => void }) {
  return (
    <div className="inline-flex items-center gap-1 rounded-lg border border-border bg-secondary/40 p-1" role="group" aria-label="Trading method">
      {(['scalping', 'longterm'] as TradingMethod[]).map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => onChange(m)}
          aria-pressed={method === m}
          title={m === 'scalping' ? 'Fast intervals, tight stops' : 'Slow intervals, wide stops'}
          className={cn(
            'h-8 cursor-pointer rounded-md px-3 text-sm font-medium transition-colors duration-150',
            method === m ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {methodLabel(m)}
        </button>
      ))}
    </div>
  )
}

/** Live account summary pulled from the connected broker through its Edge Function. */
export function LiveSummary({ fn, label, connectionId }: { fn: 'broker-oanda' | 'broker-mt'; label: string; connectionId?: string }) {
  const [data, setData] = useState<{ balance: number; nav: number; openTrades: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    const load = async () => {
      const { data, error } = await invokeEdge<{
        ok?: boolean
        account?: {
          balance?: string | number
          NAV?: string | number
          equity?: string | number
          openTradeCount?: string | number
          openPositions?: string | number
        }
        error?: string
      }>(fn, {
        body: { action: 'summary', connection_id: connectionId },
        fallback: `Could not load your ${label} account.`,
      })
      if (!active) return
      setLoading(false)
      const d = data
      if (error || !d?.ok || !d.account) {
        setError(d?.error ?? error ?? `Could not load your ${label} account.`)
        return
      }
      const acc = d.account
      setData({
        balance: Number(acc.balance ?? 0),
        nav: Number(acc.NAV ?? acc.equity ?? acc.balance ?? 0),
        openTrades: Number(acc.openTradeCount ?? acc.openPositions ?? 0),
      })
    }
    void load()
    // Keep polling the broker while the page is open — balance / equity / open
    // positions keep moving after trading stops (SL/TP and broker-side closes
    // settle), so the summary must keep up instead of freezing at the first fetch.
    const id = setInterval(() => void load(), 10_000)
    return () => {
      active = false
      clearInterval(id)
    }
  }, [fn, label, connectionId])

  if (loading) {
    return (
      <Card>
        <CardContent>
          <div className="space-y-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-8 w-56" />
          </div>
        </CardContent>
      </Card>
    )
  }
  if (error) {
    return (
      <Card>
        <CardContent>
          <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-red-200">
            <p>{error}</p>
            <p className="mt-1.5 text-xs text-red-200/75">
              The broker may be rejecting the automated login, or the connection needs attention.{' '}
              <Link
                to="/brokers"
                className="font-medium underline decoration-red-200/40 underline-offset-2 hover:text-red-100"
              >
                Check it on the Brokers page
              </Link>
              .
            </p>
          </div>
        </CardContent>
      </Card>
    )
  }
  return (
    <Card>
      <CardContent>
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <p className="text-xs text-muted-foreground">{label} balance</p>
            <p className="mt-1 text-2xl font-bold tnum">{formatUsd(data?.balance ?? 0)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Equity</p>
            <p className="mt-1 text-2xl font-bold tnum">{formatUsd(data?.nav ?? 0)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Open positions</p>
            <p className="mt-1 text-2xl font-bold tnum">{data?.openTrades ?? 0}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

/** Live-mode banner: labels the connected broker account and warns about real money. */
export function LiveBanner({ conn, label }: { conn: BrokerConnectionRow; label: string }) {
  const live = conn.account_type === 'live'
  return (
    <div
      className={
        live
          ? 'flex flex-col gap-3 rounded-xl border border-amber/40 bg-amber/10 p-4 sm:flex-row sm:items-center'
          : 'flex flex-col gap-3 rounded-xl border border-up/30 bg-up/10 p-4 sm:flex-row sm:items-center'
      }
    >
      <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${live ? 'bg-amber/20 text-amber' : 'bg-up/15 text-up'}`}>
        <ShieldAlert className="h-5 w-5" aria-hidden="true" />
      </div>
      <div className="flex-1">
        <h2 className={`text-sm font-semibold ${live ? 'text-amber' : 'text-up'}`}>
          {live ? 'LIVE account — real money' : 'Practice (demo) account'}
        </h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {live
            ? `Orders this workspace sends are placed on your real ${label} account. Stops are enforced by the broker, and your risk limits still gate every entry.`
            : `Trades run on your ${label} practice account with virtual funds — safe to experiment. Switch to a live account on the Brokers page when you are ready.`}{' '}
          Account <span className="font-mono">{conn.account_id ?? '—'}</span> ·{' '}
          <Link to="/brokers" className={live ? 'text-amber hover:underline' : 'text-accent hover:underline'}>
            manage connection
          </Link>
          .
        </p>
      </div>
    </div>
  )
}

/** Managed-live banner: the platform's own live ledger, no external broker token needed. */
export function ManagedBanner() {
  return (
    <div className={'flex flex-col gap-3 rounded-xl border border-amber/40 bg-amber/10 p-4 sm:flex-row sm:items-center'}>
      <div className={'flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber/20 text-amber'}>
        <ShieldAlert className="h-5 w-5" aria-hidden="true" />
      </div>
      <div className="flex-1">
        <h2 className="text-sm font-semibold text-amber">Managed live account — money-style trading</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Your positions run in real size on the platform's own ledger with the same risk rules, stops and journal as
          paper — but there is <span className="font-medium text-foreground">no external broker to connect</span> and
          no MetaApi token required. The account is yours and persists to your profile.
        </p>
      </div>
    </div>
  )
}