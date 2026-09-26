/**
 * MetricsCards — a grid of labelled stat cards for backtest/performance
 * summaries. Accepts an explicit item list so every page stays in control of
 * what it surfaces.
 */
import type { ReactNode } from 'react'
import { cn } from '../lib/cn'

export interface MetricItem {
  label: string
  value: string
  tone?: 'up' | 'down' | 'neutral' | 'accent'
}

const TONE_BAR: Record<NonNullable<MetricItem['tone']>, string> = {
  up: 'bg-gradient-to-r from-up/70 to-teal/30',
  down: 'bg-gradient-to-r from-down/70 to-pink/30',
  accent: 'bg-gradient-to-r from-accent/70 to-primary/40',
  neutral: 'bg-gradient-to-r from-secondary/70 to-violet/40',
}

export function MetricsCards({ items, className }: { items: MetricItem[]; className?: string }) {
  return (
    <div className={cn('grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4', className)}>
      {items.map((it) => (
        <div
          key={it.label}
          className="surface surface-hover relative overflow-hidden rounded-xl border border-border/70 px-4 py-3.5"
        >
          {/* Colour accent strip on top of each stat */}
          <span aria-hidden="true" className={cn('absolute inset-x-0 top-0 h-[3px]', TONE_BAR[it.tone ?? 'neutral'])} />
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{it.label}</p>
          <p
            className={cn(
              'mt-1 tnum font-mono text-lg font-bold tracking-tight',
              it.tone === 'up' && 'text-up',
              it.tone === 'down' && 'text-down',
              it.tone === 'accent' && 'text-accent',
              (!it.tone || it.tone === 'neutral') && 'text-foreground',
            )}
          >
            {it.value}
          </p>
        </div>
      ))}
    </div>
  )
}

export function MetricItemView({ children }: { children: ReactNode }) {
  return <>{children}</>
}