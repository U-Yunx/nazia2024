/**
 * Shared UI kit — Badge, Button, Card, EmptyState, Input, PageHeader, Select,
 * Skeleton. Dark trading-terminal theme; every component honours the design
 * tokens (bg-background, border-border, text-muted-foreground, …).
 *
 * Elevation rules: cards step up from the page with a light gradient surface
 * + hairline top highlight (.surface), interactive surfaces lift on hover
 * (.surface-hover), and every pressable gives scale(0.97) feedback
 * (.btn-lift). All hover motion is gated behind (hover:hover) so touch
 * devices never stick on hover states.
 */
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react'
import { Loader2 } from 'lucide-react'
import { cn } from '../lib/cn'

/* ----------------------------------- Card ---------------------------------- */

export function Card({
  id,
  className,
  children,
}: {
  id?: string
  className?: string
  children?: ReactNode
}) {
  return (
    <div id={id} className={cn('surface-premium rounded-2xl border border-border/70 p-5', className)}>
      {children}
    </div>
  )
}

export function CardHeader({ className, children }: { className?: string; children?: ReactNode }) {
  return <div className={cn('mb-4 flex items-start justify-between gap-3', className)}>{children}</div>
}

export function CardTitle({ className, children }: { className?: string; children?: ReactNode }) {
  return <h2 className={cn('text-base font-semibold tracking-tight text-foreground', className)}>{children}</h2>
}

export function CardContent({ className, children }: { className?: string; children?: ReactNode }) {
  return <div className={cn('space-y-4', className)}>{children}</div>
}

/* ---------------------------------- Badge ---------------------------------- */

export function Badge({ className, children }: { className?: string; children?: ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border border-border/80 bg-secondary/40 px-2.5 py-0.5 text-xs font-medium text-muted-foreground backdrop-blur-sm',
        className,
      )}
    >
      {children}
    </span>
  )
}

/* ---------------------------------- Button --------------------------------- */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md' | 'lg'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  loading?: boolean
}

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary:
    'btn-lift border border-white/10 bg-gradient-to-b from-primary via-primary to-primary/85 text-on-primary shadow-[0_10px_28px_-12px_var(--color-primary)] hover:shadow-[0_14px_34px_-10px_var(--color-primary),0_0_24px_-12px_var(--color-accent)]',
  secondary:
    'btn-lift border border-border/80 bg-secondary/40 text-foreground backdrop-blur-sm hover:border-accent/40 hover:bg-secondary/60',
  ghost: 'btn-lift border border-transparent bg-transparent text-muted-foreground hover:bg-secondary/40 hover:text-foreground',
  danger: 'btn-lift border border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/20',
}

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-xs',
  md: 'h-10 px-4 text-sm',
  lg: 'h-12 px-6 text-base',
}

/**
 * The button look without the <button>. Exported so the same affordance can be
 * put on an <a> (downloads, external links) without nesting a button inside a
 * link — which breaks keyboard and screen-reader semantics.
 */
export function buttonClasses(
  variant: ButtonVariant = 'primary',
  size: ButtonSize = 'md',
  className?: string,
) {
  return cn(
    'inline-flex cursor-pointer items-center justify-center gap-2 rounded-xl font-semibold tracking-tight',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
    VARIANT_CLASSES[variant],
    SIZE_CLASSES[size],
    className,
  )
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  className,
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      className={cn(
        buttonClasses(variant, size),
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...rest}
    >
      {loading && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
      {children}
    </button>
  )
}

/* ---------------------------------- Input ---------------------------------- */

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string
}

export function Input({ label, className, id, ...rest }: InputProps) {
  const inputId = id ?? (label ? label.toLowerCase().replace(/[^a-z0-9]+/g, '-') : undefined)
  return (
    <label className={cn('block', className)} htmlFor={inputId}>
      {label && <span className="mb-1.5 block text-xs font-medium text-muted-foreground">{label}</span>}
      <input
        id={inputId}
        className="w-full rounded-xl border border-border/80 bg-background/50 px-3.5 py-2.5 text-sm text-foreground shadow-[inset_0_1px_0_rgb(255_255_255/0.03)] transition-all duration-200 placeholder:text-muted-foreground/60 hover:border-border focus:border-accent/70 focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:cursor-not-allowed disabled:opacity-60"
        {...rest}
      />
    </label>
  )
}

/* ---------------------------------- Select --------------------------------- */

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string
}

export function Select({ label, className, id, children, ...rest }: SelectProps) {
  const selectId = id ?? (label ? label.toLowerCase().replace(/[^a-z0-9]+/g, '-') : undefined)
  return (
    <label className={cn('block', className)} htmlFor={selectId}>
      {label && <span className="mb-1.5 block text-xs font-medium text-muted-foreground">{label}</span>}
      <select
        id={selectId}
        className="w-full cursor-pointer rounded-xl border border-border/80 bg-background/50 px-3.5 py-2.5 text-sm text-foreground shadow-[inset_0_1px_0_rgb(255_255_255/0.03)] transition-all duration-200 focus:border-accent/70 focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:cursor-not-allowed disabled:opacity-60"
        {...rest}
      >
        {children}
      </select>
    </label>
  )
}

/* -------------------------------- PageHeader ------------------------------- */

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string
  description?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="font-heading text-3xl font-bold tracking-tight text-foreground sm:text-4xl">{title}</h1>
        {description && (
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">{description}</p>
        )}
        <div className="hairline mt-3 w-16" />
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2 pb-0.5">{actions}</div>}
    </div>
  )
}

/* -------------------------------- EmptyState ------------------------------- */

export function EmptyState({
  icon,
  title,
  message,
  action,
}: {
  icon?: ReactNode
  title: string
  message?: string
  action?: ReactNode
}) {
  return (
    <div className="surface flex flex-col items-center justify-center rounded-2xl border border-dashed border-border/70 px-6 py-14 text-center">
      {icon && (
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border border-border/70 bg-secondary/40 text-accent shadow-sm">
          {icon}
        </div>
      )}
      <p className="text-sm font-semibold text-foreground">{title}</p>
      {message && <p className="mt-1 max-w-sm text-sm leading-relaxed text-muted-foreground">{message}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  )
}

/* --------------------------------- Skeleton -------------------------------- */

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('shimmer rounded-lg', className)} aria-hidden="true" />
}