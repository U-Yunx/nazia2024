/**
 * RiskPanel — the risk-management editor the robot enforces. Every knob maps
 * 1:1 onto the engine's RiskConfig. Edits are staged into a local draft and
 * committed with the "Apply" button, so a misclicked keystroke never changes
 * what the robot is enforcing mid-run. The per-trade profit target / loss cap
 * can be entered in pips or USD (the engine converts pips per position at
 * mark-to-market). The guardrails at the bottom (adaptive risk, volatility
 * filter, consecutive-loss breaker) keep the robot competitive without
 * gambling the account.
 */
import { useEffect, useMemo, useState } from 'react'
import { Check, RotateCcw, ShieldAlert } from 'lucide-react'
import type { RiskConfig } from '../../lib/trading/types'
import { DEFAULT_RISK } from '../../lib/trading/types'
import { cn } from '../../lib/cn'
import { Button, Input } from '../ui'
import { CollapsibleCard } from './CollapsibleCard'

interface Props {
  risk: RiskConfig
  onChange: (patch: Partial<RiskConfig>) => void
  onReset: () => void
  isLive: boolean
}

function Field({
  label,
  value,
  onChange,
  min,
  max,
  step,
  suffix,
}: {
  label: string
  value: number
  onChange: (v: number) => void
  min: number
  max?: number
  step: number
  suffix?: string
}) {
  return (
    <Input
      label={`${label}${suffix ? ` (${suffix})` : ''}`}
      type="number"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  )
}

export function RiskPanel({ risk, onChange, onReset, isLive }: Props) {
  // Local draft: the robot keeps enforcing `risk` until the user hits Apply.
  const [draft, setDraft] = useState<RiskConfig>(risk)
  const [dirty, setDirty] = useState(false)
  const [applied, setApplied] = useState(false)

  // Keep the draft in sync when the risk config changes from OUTSIDE this
  // panel (method presets, manual tune, robot presets) — but only when the
  // user hasn't got uncommitted edits, so typing is never clobbered.
  const lastCommitted = useMemo(() => JSON.stringify(risk), [risk])
  useEffect(() => {
    if (!dirty) setDraft(risk)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, lastCommitted])

  const patch = (p: Partial<RiskConfig>) => {
    setDraft((d) => ({ ...d, ...p }))
    setDirty(true)
    setApplied(false)
  }
  const apply = () => {
    onChange({ ...draft, autoTrade: risk.autoTrade })
    setDirty(false)
    setApplied(true)
  }
  const revert = () => {
    setDraft(risk)
    setDirty(false)
    setApplied(false)
  }

  const unit = draft.profitUnit === 'pips' ? 'pips' : 'usd'
  const perTradeProfit = unit === 'pips' ? draft.targetPerTradePips : draft.targetPerTradeUsd
  const perTradeLoss = unit === 'pips' ? draft.maxLossPerTradePips : draft.maxLossPerTradeUsd

  return (
    <CollapsibleCard
      title="Risk management"
      icon={<ShieldAlert className="h-4 w-4 text-amber" aria-hidden="true" />}
      actions={
        <>
          <Button variant="ghost" size="sm" onClick={onReset}>
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
            Reset
          </Button>
          <Button variant="secondary" size="sm" onClick={revert} disabled={!dirty}>
            Revert
          </Button>
          <Button size="sm" onClick={apply} disabled={!dirty}>
            <Check className="h-3.5 w-3.5" aria-hidden="true" />
            Apply
          </Button>
        </>
      }
    >
        {isLive && (
          <p className="rounded-lg border border-amber/30 bg-amber/10 px-3 py-2 text-xs text-amber">
            Live mode — these limits are enforced on your real account.
          </p>
        )}
        <div className="mt-4 grid grid-cols-2 gap-3">
          <Field
            label="Risk per trade"
            value={draft.riskPerTradePct}
            onChange={(v) => patch({ riskPerTradePct: v })}
            min={0}
            step={0.1}
            suffix="%"
          />
          <Field
            label="Max open positions"
            value={draft.maxOpenPositions}
            onChange={(v) => patch({ maxOpenPositions: v })}
            min={1}
            max={50}
            step={1}
          />
          <Field
            label="Default stop"
            value={draft.defaultStopPips}
            onChange={(v) => patch({ defaultStopPips: v })}
            min={1}
            step={1}
            suffix="pips"
          />
          <Field
            label="Risk:reward"
            value={draft.takeProfitRatio}
            onChange={(v) => patch({ takeProfitRatio: v })}
            min={0.5}
            step={0.1}
            suffix="×"
          />
          <Field
            label="Daily loss limit"
            value={draft.maxDailyLossPct}
            onChange={(v) => patch({ maxDailyLossPct: v })}
            min={0}
            step={0.5}
            suffix="%"
          />
          <Field
            label="Close on drawdown"
            value={draft.drawdownClosePct ?? DEFAULT_RISK.drawdownClosePct}
            onChange={(v) => patch({ drawdownClosePct: Math.max(0, v) })}
            min={0}
            step={1}
            suffix="%"
          />
          <Field
            label="Profit pull-back"
            value={draft.profitPullbackPct ?? DEFAULT_RISK.profitPullbackPct}
            onChange={(v) => patch({ profitPullbackPct: Math.min(90, Math.max(0, v)) })}
            min={0}
            max={90}
            step={1}
            suffix="%"
          />
          <p className="col-span-2 -mt-1 text-[11px] text-muted-foreground">
            A position that slowly bleeds this % from its entry is closed to lock the loss. A
            fast crash (the whole step in one mark) is left open instead of sold at the bottom.
            Set 0 to disable.
          </p>
          <Field
            label="Arm pull-back at"
            value={draft.profitPullbackActivateUsd ?? DEFAULT_RISK.profitPullbackActivateUsd}
            onChange={(v) => patch({ profitPullbackActivateUsd: Math.max(0, v) })}
            min={0}
            step={0.5}
            suffix="$"
          />
          <p className="col-span-2 -mt-1 text-[11px] text-muted-foreground">
            The pull-back lock only arms once a trade's profit exceeds this amount (default $1) —
            then it closes when profit gives back the % above from its highest point.
          </p>

          {/* Per-trade profit: pick the unit first (pips or USD) */}
          <div className="col-span-2 rounded-lg border border-border bg-secondary/30 p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-foreground">Per-trade targets</span>
              <div
                className="inline-flex items-center gap-1 rounded-lg border border-border bg-background/60 p-0.5"
                role="group"
                aria-label="Per-trade profit unit"
              >
                {(['usd', 'pips'] as const).map((u) => (
                  <button
                    key={u}
                    type="button"
                    onClick={() => patch({ profitUnit: u })}
                    aria-pressed={unit === u}
                    className={cn(
                      'h-6 cursor-pointer rounded-md px-2.5 text-xs font-medium transition-colors duration-150',
                      unit === u ? 'bg-accent text-black' : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {u === 'usd' ? 'USD' : 'Pips'}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field
                label="Target profit per trade"
                value={perTradeProfit}
                onChange={(v) =>
                  patch(
                    unit === 'pips'
                      ? { targetPerTradePips: Math.max(0, v) }
                      : { targetPerTradeUsd: Math.max(0, v) },
                  )
                }
                min={0}
                step={unit === 'pips' ? 1 : 5}
                suffix={unit === 'pips' ? 'pips' : '$'}
              />
              <Field
                label="Max loss per trade"
                value={perTradeLoss}
                onChange={(v) =>
                  patch(
                    unit === 'pips'
                      ? { maxLossPerTradePips: Math.max(0, v) }
                      : { maxLossPerTradeUsd: Math.max(0, v) },
                  )
                }
                min={0}
                step={unit === 'pips' ? 1 : 5}
                suffix={unit === 'pips' ? 'pips' : '$'}
              />
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground">
              {unit === 'pips'
                ? 'Pips are converted to $ per position (pips × pip value × units), so the target scales with size.'
                : 'Dollar targets: the robot banks a win at +$target and cuts a loser at -$cap.'}
            </p>
          </div>

          <Field
            label="Trailing stop"
            value={draft.trailPips}
            onChange={(v) => patch({ trailPips: v })}
            min={0}
            step={1}
            suffix="pips"
          />
          <Field
            label="Break-even at"
            value={draft.breakEvenPips}
            onChange={(v) => patch({ breakEvenPips: v })}
            min={0}
            step={1}
            suffix="pips"
          />
          <Field
            label="Trail activation"
            value={draft.trailActivationPips}
            onChange={(v) => patch({ trailActivationPips: v })}
            min={0}
            step={1}
            suffix="pips"
          />
          <Field
            label="Losses before stand-down"
            value={draft.maxConsecutiveLosses}
            onChange={(v) => patch({ maxConsecutiveLosses: Math.max(0, Math.round(v)) })}
            min={0}
            max={10}
            step={1}
            suffix="losses"
          />
        </div>

        {applied && (
          <p role="status" className="mt-3 flex items-center gap-1.5 rounded-lg border border-up/40 bg-up/10 px-3 py-2 text-xs text-up">
            <Check className="h-3.5 w-3.5" aria-hidden="true" />
            Risk settings applied.
          </p>
        )}

        <label className="mt-4 flex cursor-pointer items-center gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            checked={draft.trailingStop}
            onChange={(e) => patch({ trailingStop: e.target.checked })}
            className="h-4 w-4 cursor-pointer rounded border-border bg-background accent-[var(--color-accent)]"
          />
          Trailing stop
        </label>
        <label className="mt-2 flex cursor-pointer items-start gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            checked={draft.adaptiveRisk}
            onChange={(e) => patch({ adaptiveRisk: e.target.checked })}
            className="mt-0.5 h-4 w-4 cursor-pointer rounded border-border bg-background accent-[var(--color-accent)]"
          />
          <span>
            <span className="block">Adaptive risk</span>
            <span className="block text-xs text-muted-foreground">Trade smaller after consecutive losses.</span>
          </span>
        </label>
        <label className="mt-2 flex cursor-pointer items-start gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            checked={draft.volatilityFilter}
            onChange={(e) => patch({ volatilityFilter: e.target.checked })}
            className="mt-0.5 h-4 w-4 cursor-pointer rounded border-border bg-background accent-[var(--color-accent)]"
          />
          <span>
            <span className="block">Volatility filter</span>
            <span className="block text-xs text-muted-foreground">Stand aside when ATR spikes.</span>
          </span>
        </label>
        <label className="mt-2 flex cursor-pointer items-center gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            checked={risk.autoTrade}
            onChange={(e) => onChange({ autoTrade: e.target.checked })}
            className="h-4 w-4 cursor-pointer rounded border-border bg-background accent-[var(--color-accent)]"
          />
          Auto-trade on signals
        </label>
      </CollapsibleCard>
  )
}