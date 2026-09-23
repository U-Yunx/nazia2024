/**
 * Trading hub — the /trading page.
 *
 * Splits trading into dedicated tabs, each with its OWN configuration,
 * strategy settings and copy-trading:
 *   - "Manual trading"  → the manual workspace (its own ledger, style,
 *     strategy and copy-trader configuration).
 *   - "Robot 1 / 2 / 3" → each robot's control room (its own per-slot
 *     account, method, pairs, risk, limits, activity and copy-trader).
 *
 * The tab is driven by `?robot=N` (1–3 selects that robot, absent = manual)
 * so deep links from the Robots fleet ("Full screen") land on the right tab.
 */
import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Bot, Hand, ShieldAlert } from 'lucide-react'
import { cn } from '../lib/cn'
import { Trading } from './Trading'
import { ManualWorkspace } from './trading/ManualWorkspace'

const TABS: { key: number; label: string; to: string; icon: typeof Bot; hint: string }[] = [
  { key: 0, label: 'Manual trading', to: '/trading', icon: Hand, hint: 'Your own ledger, strategy and copy-trading' },
  { key: 1, label: 'Robot 1', to: '/trading?robot=1', icon: Bot, hint: 'Robot 1 — its own account and settings' },
  { key: 2, label: 'Robot 2', to: '/trading?robot=2', icon: Bot, hint: 'Robot 2 — its own account and settings' },
  { key: 3, label: 'Robot 3', to: '/trading?robot=3', icon: Bot, hint: 'Robot 3 — its own account and settings' },
]

export function TradingTabs({ active }: { active: number }) {
  return (
    <div
      role="tablist"
      aria-label="Trading workspace"
      className="grid w-full grid-cols-2 gap-1 rounded-xl border border-border bg-secondary/40 p-1 sm:inline-flex sm:w-auto sm:flex-nowrap"
    >
      {TABS.map((t) => {
        const selected = active === t.key
        return (
          <Link
            key={t.key}
            to={t.to}
            role="tab"
            aria-selected={selected}
            aria-label={t.label}
            title={t.hint}
            className={cn(
              'inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-medium transition-colors duration-150',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
              selected ? 'bg-accent text-black shadow-sm' : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
            )}
          >
            <t.icon className="h-4 w-4" aria-hidden="true" />
            {t.label}
          </Link>
        )
      })}
    </div>
  )
}

export function TradingHub() {
  const [searchParams] = useSearchParams()
  const raw = Number(searchParams.get('robot'))
  const active = Number.isInteger(raw) && raw >= 1 && raw <= 3 ? raw : 0

  // Keep-alive tabs. A workspace is mounted the first time its tab is visited
  // and STAYS mounted afterwards — inactive tabs are hidden, never unmounted.
  // This is what keeps a running robot alive across tab switches: its engine
  // loop, quote stream, heartbeat and live-broker connection keep running in
  // the background, so switching from Robot 1 to Robot 2 never stops Robot 1.
  // Only tabs that have actually been opened cost anything (lazy first mount).
  const [visited, setVisited] = useState<Set<number>>(() => new Set([active]))
  useEffect(() => {
    setVisited((prev) => {
      if (prev.has(active)) return prev
      const next = new Set(prev)
      next.add(active)
      return next
    })
  }, [active])

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3">
        <TradingTabs active={active} />
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground" role="note">
          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true" />
          Every tab is fully independent — its own balance, configuration, strategy settings and copy-trading. Nothing
          you set on manual trading changes any robot, and no robot shares another robot's ledger. Switching tabs never
          stops a running robot — it keeps trading in the background.
        </p>
      </div>

      {/* Live progress moved to the global sticky bar (Layout) — it follows the
          visitor across every page and expands to the full workspace grid. */}

      {/* Keep-alive panels: once visited, each workspace stays mounted and is
          merely hidden while another tab is active. `hidden` (display:none)
          keeps the DOM alive — effects, intervals and connections included. */}
      {visited.has(0) && (
        <div hidden={active !== 0}>
          <ManualWorkspace />
        </div>
      )}
      {[1, 2, 3].map((n) =>
        visited.has(n) ? (
          <div key={n} hidden={active !== n}>
            <Trading slot={n} />
          </div>
        ) : null,
      )}
    </div>
  )
}