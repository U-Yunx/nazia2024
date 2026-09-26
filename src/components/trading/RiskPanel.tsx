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
import { DEFAULT_HEDGE_TRIGGER_PIPS, DEFAULT_REVERSE_TRIGGER_PIPS, DEFAULT_RISK } from '../../lib/trading/types'
import { cn } from '../../lib/cn'
import { Button, Input } from '../ui'
import { CollapsibleCard } from './CollapsibleCard'

interface Props {
  risk: RiskConfig
  onChange: (patch: Partial<RiskConfig>) => void
  onReset: () => void
  isLive: boolean
  /** Superadmins trade unrestricted — the usual UI safety clamps are lifted. */
  unrestricted?: boolean
  /** Whether the trader is signed in — when false and the Deep Analyst gate is
   *  on, the panel warns that the strict gate blocks every robot entry. */
  signedIn?: boolean
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

export function RiskPanel({ risk, onChange, onReset, isLive, unrestricted = false, signedIn }: Props) {
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
            max={unrestricted ? 100 : 10}
            step={0.1}
            suffix="%"
          />
          <Field
            label="Max open positions"
            value={draft.maxOpenPositions}
            onChange={(v) => patch({ maxOpenPositions: v })}
            min={1}
            max={unrestricted ? 999 : 50}
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
          {/* Scale-out / partial take-profit — the "bank half at 1R, let the
              rest run" exit used by long-running stable trading robots. */}
          <div className="col-span-2 rounded-lg border border-cyan/30 bg-cyan/5 p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-semibold text-foreground">Partial take-profit (scale-out)</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  Banks part of the position at the first target, moves the stop to break-even and lets the rest ride
                  to the full take-profit with trailing — lock profit early, keep upside.
                </p>
              </div>
              <label className="flex shrink-0 cursor-pointer items-center gap-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  checked={draft.partialTakeProfit}
                  onChange={(e) => patch({ partialTakeProfit: e.target.checked })}
                  className="h-4 w-4 cursor-pointer rounded border-border bg-background accent-[var(--color-accent)]"
                />
                On
              </label>
            </div>
            {draft.partialTakeProfit && (
              <div className="mt-3 grid grid-cols-2 gap-3">
                <Field
                  label="Close at first target"
                  value={draft.partialClosePct ?? DEFAULT_RISK.partialClosePct}
                  onChange={(v) => patch({ partialClosePct: Math.min(100, Math.max(1, v)) })}
                  min={1}
                  max={100}
                  step={5}
                  suffix="%"
                />
                <Field
                  label="First target"
                  value={draft.partialTpRatio ?? DEFAULT_RISK.partialTpRatio}
                  onChange={(v) => patch({ partialTpRatio: Math.max(0.5, v) })}
                  min={0.5}
                  step={0.5}
                  suffix="× stop"
                />
              </div>
            )}
          </div>
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

          {/* Peak-return close — "watch it dip, then bank it the moment it
              returns to the top": profit, give back `peakReturnGivebackPct`,
              rally back to the last highest profit → close AT the peak. */}
          <div className="col-span-2 rounded-lg border border-up/30 bg-up/5 p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-semibold text-foreground">Return to peak close</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  When a trade profits, dips, then climbs back to its last highest profit — close it
                  right at the top instead of chasing more. Shares the $ arm floor with pull-back.
                </p>
              </div>
              <label className="flex shrink-0 cursor-pointer items-center gap-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  checked={draft.peakReturnClose}
                  onChange={(e) => patch({ peakReturnClose: e.target.checked })}
                  className="h-4 w-4 cursor-pointer rounded border-border bg-background accent-[var(--color-accent)]"
                />
                On
              </label>
            </div>
            {draft.peakReturnClose && (
              <div className="mt-3 grid grid-cols-2 gap-3">
                <Field
                  label="Arm after give-back"
                  value={draft.peakReturnGivebackPct ?? DEFAULT_RISK.peakReturnGivebackPct}
                  onChange={(v) => patch({ peakReturnGivebackPct: Math.min(50, Math.max(1, v)) })}
                  min={1}
                  max={50}
                  step={1}
                  suffix="%"
                />
                <div className="flex items-end pb-1 text-[11px] text-muted-foreground">
                  The trade must dip this % off its best profit before a return to the peak counts as
                  a close — keeps noise at the high from closing winners.
                </div>
              </div>
            )}
          </div>

          {/* Auto-reverse ("reverse open position trading") — the robot's
              comeback rule. When activated, a strategy-tagged position that is
              down the trigger pips from its entry is closed and re-opened in
              the OPPOSITE direction at the same size, automatically, while the
              robot runs. Manual trades are never touched, and the reversed
              open still passes every risk gate. */}
          <div className="col-span-2 rounded-lg border border-amber/30 bg-amber/5 p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-semibold text-foreground">Auto-reverse losing positions</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  When a robot position sinks the trigger distance from its entry, the robot closes it and opens the
                  SAME size in the opposite direction — riding the reversal instead of waiting for the stop. Runs
                  automatically while the robot is active (paper &amp; managed accounts). Manual trades are never touched.
                </p>
              </div>
              <label className="flex shrink-0 cursor-pointer items-center gap-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  checked={draft.autoReverse === true}
                  onChange={(e) => patch({ autoReverse: e.target.checked })}
                  className="h-4 w-4 cursor-pointer rounded border-border bg-background accent-[var(--color-accent)]"
                />
                On
              </label>
            </div>
            {draft.autoReverse === true && (
              <div className="mt-3 grid grid-cols-2 gap-3">
                <Field
                  label="Reverse after"
                  value={draft.reverseTriggerPips ?? DEFAULT_REVERSE_TRIGGER_PIPS}
                  onChange={(v) => patch({ reverseTriggerPips: Math.max(1, v) })}
                  min={1}
                  step={1}
                  suffix="pips down"
                />
                <div className="flex items-end pb-1 text-[11px] text-muted-foreground">
                  Set it inside your stop distance to flip before the stop is hit. Keep it above 0 so a
                  sub-pip wiggle can't churn the book.
                </div>
              </div>
            )}
          </div>

          {/* Hedge on loss ("open the opposite trade") — unlike auto-reverse the
              losing position STAYS open and the robot opens the opposite
              direction ALONGSIDE it, sized risk-based, bypassing the per-pair
              cap (a sequential pair capped at 1 can still hold a 2-leg book). */}
          <div className="col-span-2 rounded-lg border border-indigo/30 bg-indigo/5 p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-semibold text-foreground">Hedge on loss (open opposite trade)</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  When a robot position sinks the trigger distance from its entry, the robot opens the OPPOSITE
                  direction ALONGSIDE it — the loser stays open, sized risk-based. Works even on pairs capped at
                  1 position (the hedge deliberately bypasses the per-pair cap). Runs automatically while the
                  robot is active (paper &amp; managed accounts). Manual trades are never touched.
                </p>
              </div>
              <label className="flex shrink-0 cursor-pointer items-center gap-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  checked={draft.hedgeEnabled === true}
                  onChange={(e) => patch({ hedgeEnabled: e.target.checked })}
                  className="h-4 w-4 cursor-pointer rounded border-border bg-background accent-[var(--color-accent)]"
                />
                On
              </label>
            </div>
            {draft.hedgeEnabled === true && (
              <div className="mt-3 grid grid-cols-2 gap-3">
                <Field
                  label="Hedge after"
                  value={draft.hedgeTriggerPips ?? DEFAULT_HEDGE_TRIGGER_PIPS}
                  onChange={(v) => patch({ hedgeTriggerPips: Math.max(1, v) })}
                  min={1}
                  step={1}
                  suffix="pips down"
                />
                <div className="flex items-end pb-1 text-[11px] text-muted-foreground">
                  The hedge is sized risk-based (% of equity against its own stop) and only opens once per pair —
                  an existing opposite position blocks another hedge, so the book never stacks a third leg.
                </div>
              </div>
            )}
          </div>

          {/* Deep Analyst entry gate — the robot's strict AI veto. Every entry
              is vetted by the Deep Analyst before it opens; a 'skip' verdict
              stands the trade aside, and while signed out the robot opens
              NOTHING until the trader signs in (strict mode). */}
          <div className="col-span-2 rounded-lg border border-violet/30 bg-violet/5 p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-semibold text-foreground">Deep Analyst entry gate (AI veto)</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  Every robot trade is analysed by the Deep Analyst before it opens — if the AI flags the setup,
                  the robot stands aside. STRICT: while you're signed out the robot opens no trades at all until
                  you sign in.
                </p>
              </div>
              <label className="flex shrink-0 cursor-pointer items-center gap-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  checked={draft.deepAnalystGate === true}
                  onChange={(e) => patch({ deepAnalystGate: e.target.checked })}
                  className="h-4 w-4 cursor-pointer rounded border-border bg-background accent-[var(--color-accent)]"
                />
                On
              </label>
            </div>
            {draft.deepAnalystGate === true && signedIn === false && (
              <p className="mt-3 rounded-lg border border-amber/30 bg-amber/10 px-3 py-2 text-[11px] text-amber">
                You're signed out — with the strict gate on, the robot will not open any trades until you sign in.
              </p>
            )}
          </div>

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
                step={1}
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
            max={unrestricted ? 100 : 10}
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