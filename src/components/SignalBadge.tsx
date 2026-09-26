/**
 * SignalBadge — a small coloured badge for a strategy signal (buy/sell/neutral)
 * used across the Signals page and robot summary.
 */
import type { Signal } from '../lib/types'
import { cn } from '../lib/cn'

const TONE: Record<Signal, string> = {
  buy: 'border-up/60 bg-gradient-to-br from-up/30 via-up/15 to-teal-500/10 text-up shadow-[0_0_14px_-4px] shadow-up/50',
  sell: 'border-down/60 bg-gradient-to-br from-down/30 via-down/15 to-rose-500/10 text-down shadow-[0_0_14px_-4px] shadow-down/50',
  neutral: 'border-border bg-muted text-muted-foreground',
}

const DOT: Record<Signal, string> = {
  buy: 'bg-up',
  sell: 'bg-down',
  neutral: 'bg-muted-foreground/50',
}

const LABEL: Record<Signal, string> = {
  buy: 'Buy',
  sell: 'Sell',
  neutral: 'Neutral',
}

export function SignalBadge({ signal, className }: { signal: Signal; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-bold uppercase tracking-wide',
        TONE[signal],
        className,
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', DOT[signal], signal !== 'neutral' && 'animate-pulse-dot')} aria-hidden="true" />
      {LABEL[signal]}
    </span>
  )
}