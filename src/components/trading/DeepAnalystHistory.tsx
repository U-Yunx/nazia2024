/**
 * DeepAnalystHistory — shared rendering for saved Deep Analyst runs.
 *
 * Every analysis a signed-in user runs is persisted to `deep_analyst_runs`
 * (RLS-scoped to the owner). This module renders that history consistently on
 * every surface that shows it:
 *   - the DeepAnalystPanel (Manual workspace + every robot tab via
 *     PositionsTable) shows it under the open position, and
 *   - the standalone Analytics page lets traders reopen saved verdicts without
 *     needing the trade open.
 */
import { Clock } from 'lucide-react'
import { Badge } from '../ui'
import { engineLabel, type AnalystRun } from '../../lib/deepAnalystHistory'
import type { AnalystStrategy } from '../../lib/deepAnalyst'
import { timeAgo } from '../../lib/format'
import { cn } from '../../lib/cn'

export const VERDICT_META: Record<
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

export function HistorySection({
  runs,
  onSelect,
  selectedId = null,
}: {
  runs: AnalystRun[] | null
  onSelect: (run: AnalystRun) => void
  selectedId?: string | null
}) {
  if (runs === null) return null
  return (
    <div className="mt-4 border-t border-border/60 pt-3">
      <p className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
        <Clock className="h-3 w-3" aria-hidden="true" />
        Recent analyses
      </p>
      {runs.length === 0 ? (
        <p className="mt-1.5 text-xs text-muted-foreground">
          No past analyses yet — run your first one and it will be saved here for later review.
        </p>
      ) : (
        <ul className="mt-1.5 space-y-1">
          {runs.map((r) => {
            const meta = VERDICT_META[r.strategy.verdict]
            const active = r.id === selectedId
            return (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => onSelect(r)}
                  aria-pressed={active}
                  className={cn(
                    'flex w-full cursor-pointer items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 text-left text-xs transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    active
                      ? 'border-accent/60 bg-accent/10 hover:border-accent/60 hover:bg-accent/10'
                      : 'border-border/60 bg-secondary/30 hover:border-accent/40 hover:bg-secondary',
                  )}
                  title={`View the ${r.symbol} analysis from ${timeAgo(r.created_at)}`}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="font-semibold text-foreground">{r.symbol}</span>
                    <span className="uppercase text-muted-foreground">{r.side}</span>
                    <Badge className="border-border bg-muted text-muted-foreground">{engineLabel(r.engine)}</Badge>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <Badge className={cn('border', meta.className)}>{meta.label}</Badge>
                    <span className="whitespace-nowrap text-muted-foreground">{timeAgo(r.created_at)}</span>
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
