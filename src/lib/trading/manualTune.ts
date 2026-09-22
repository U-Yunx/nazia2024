/**
 * Manual robot tuning profile — a small set of human-friendly knobs that map
 * onto the underlying RiskConfig, with one-click aggressiveness presets.
 *
 * The presets also encode guardrails so the robot stays risk-aware even at
 * higher aggression: adaptive risk (de-risk after a losing streak), a
 * volatility filter (stand aside when the market is wild) and a
 * consecutive-loss circuit breaker. The more aggressive the preset, the fewer
 * guardrails stay on.
 *
 * The profile is PERSISTED per robot slot — localStorage for a fast local
 * restore and the Supabase `robot_state.tune` mirror for a cross-device one.
 * It used to live in component state only, so a refresh silently threw away
 * the whole tuning (including the position-size multiplier the robot trades
 * at). Values read back from either store go through `sanitizeTune`.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

export type Aggressiveness = 1 | 2 | 3 | 4 | 5

export interface ManualTune {
  aggressiveness: Aggressiveness
  /** Per-run target profit, % of starting equity. */
  targetProfitPct: number
  /** Multiplier applied to the risk-based position size. */
  sizeMultiplier: number
  riskPerTradePct: number
  takeProfitRatio: number
  maxOpenPositions: number
  maxDailyLossPct: number
  /** De-risk position size after consecutive losses (risk-aware sizing). */
  adaptiveRisk: boolean
  /** Stand aside when volatility (ATR) is spiking. */
  volatilityFilter: boolean
  /** Consecutive-loss circuit breaker (0 = off). */
  maxConsecutiveLosses: number
}

export const MANUAL_TUNE_DEFAULTS: ManualTune = {
  aggressiveness: 3,
  targetProfitPct: 2,
  sizeMultiplier: 1,
  riskPerTradePct: 1,
  takeProfitRatio: 2,
  maxOpenPositions: 5,
  maxDailyLossPct: 5,
  adaptiveRisk: true,
  volatilityFilter: false,
  maxConsecutiveLosses: 5,
}

const KEY = 'ana24.robot-tune'

/** Namespaced localStorage key for a scope's tune profile. Slot 1 keeps the
 *  legacy key, slot 0 is the manual workspace, slots 2..N are robot slots. */
export function manualTuneKeyForSlot(slot: number): string {
  if (slot === 0) return `${KEY}.manual`
  return slot > 1 ? `${KEY}.slot-${slot}` : KEY
}

/** Presets by aggressiveness level (1 = conservative … 5 = extreme). */
export const MANUAL_TUNE_PRESETS: Record<Aggressiveness, Omit<ManualTune, 'aggressiveness'>> = {
  1: { targetProfitPct: 0.5, sizeMultiplier: 0.5, riskPerTradePct: 0.5, takeProfitRatio: 3, maxOpenPositions: 2, maxDailyLossPct: 2, adaptiveRisk: true, volatilityFilter: true, maxConsecutiveLosses: 3 },
  2: { targetProfitPct: 1, sizeMultiplier: 0.75, riskPerTradePct: 0.75, takeProfitRatio: 2.5, maxOpenPositions: 3, maxDailyLossPct: 3, adaptiveRisk: true, volatilityFilter: true, maxConsecutiveLosses: 4 },
  3: { targetProfitPct: 2, sizeMultiplier: 1, riskPerTradePct: 1, takeProfitRatio: 2, maxOpenPositions: 5, maxDailyLossPct: 5, adaptiveRisk: true, volatilityFilter: false, maxConsecutiveLosses: 5 },
  4: { targetProfitPct: 3, sizeMultiplier: 1.5, riskPerTradePct: 1.5, takeProfitRatio: 1.5, maxOpenPositions: 7, maxDailyLossPct: 8, adaptiveRisk: false, volatilityFilter: false, maxConsecutiveLosses: 6 },
  5: { targetProfitPct: 5, sizeMultiplier: 2, riskPerTradePct: 2, takeProfitRatio: 1, maxOpenPositions: 10, maxDailyLossPct: 12, adaptiveRisk: false, volatilityFilter: false, maxConsecutiveLosses: 0 },
}

export function aggressivenessLabel(level: Aggressiveness): string {
  switch (level) {
    case 1:
      return 'Conservative'
    case 2:
      return 'Cautious'
    case 3:
      return 'Balanced'
    case 4:
      return 'Aggressive'
    case 5:
      return 'Extreme'
  }
}

/** Short description of the guardrails a preset enables (for the UI). */
export function guardrailLabel(
  tune: Pick<ManualTune, 'adaptiveRisk' | 'volatilityFilter' | 'maxConsecutiveLosses'>,
): string {
  const parts: string[] = []
  if (tune.adaptiveRisk) parts.push('adaptive risk')
  if (tune.volatilityFilter) parts.push('volatility filter')
  if (tune.maxConsecutiveLosses > 0) parts.push(`${tune.maxConsecutiveLosses}-loss breaker`)
  return parts.length > 0 ? parts.join(' · ') : 'no guardrails'
}

/** Coerce a stored knob into a finite number inside its sane band. */
function tuneNum(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

export function sanitizeTune(input: unknown): ManualTune {
  const t = (input && typeof input === 'object' ? input : {}) as Partial<ManualTune>
  const level = Math.round(tuneNum(t.aggressiveness, MANUAL_TUNE_DEFAULTS.aggressiveness, 1, 5)) as Aggressiveness
  return {
    aggressiveness: level,
    targetProfitPct: tuneNum(t.targetProfitPct, MANUAL_TUNE_DEFAULTS.targetProfitPct, 0, 50),
    // A multiplier of 0 (or a typo'd negative) would scale every position to
    // zero, so it is floored above zero and capped at 5× the risk-based size.
    sizeMultiplier: tuneNum(t.sizeMultiplier, MANUAL_TUNE_DEFAULTS.sizeMultiplier, 0.05, 5),
    riskPerTradePct: tuneNum(t.riskPerTradePct, MANUAL_TUNE_DEFAULTS.riskPerTradePct, 0.05, 10),
    takeProfitRatio: tuneNum(t.takeProfitRatio, MANUAL_TUNE_DEFAULTS.takeProfitRatio, 0.5, 10),
    maxOpenPositions: Math.round(tuneNum(t.maxOpenPositions, MANUAL_TUNE_DEFAULTS.maxOpenPositions, 1, 50)),
    maxDailyLossPct: tuneNum(t.maxDailyLossPct, MANUAL_TUNE_DEFAULTS.maxDailyLossPct, 0, 50),
    adaptiveRisk: t.adaptiveRisk !== false,
    volatilityFilter: t.volatilityFilter === true,
    maxConsecutiveLosses: Math.round(
      tuneNum(t.maxConsecutiveLosses, MANUAL_TUNE_DEFAULTS.maxConsecutiveLosses, 0, 30),
    ),
  }
}

export function loadManualTune(slot = 1): ManualTune {
  try {
    const raw = localStorage.getItem(manualTuneKeyForSlot(slot))
    if (!raw) return MANUAL_TUNE_DEFAULTS
    return sanitizeTune(JSON.parse(raw))
  } catch {
    return MANUAL_TUNE_DEFAULTS
  }
}

export function saveManualTune(tune: ManualTune, slot = 1): void {
  try {
    localStorage.setItem(manualTuneKeyForSlot(slot), JSON.stringify(tune))
  } catch {
    /* storage full / blocked — non-fatal */
  }
}

export function useManualTune(slot = 1) {
  const [tune, setTune] = useState<ManualTune>(() => loadManualTune(slot))
  // Re-load the slot's saved profile when the active robot slot changes (e.g.
  // navigating between /trading?robot=1 and ?robot=2 without a remount).
  const mountedSlot = useRef(slot)
  useEffect(() => {
    if (mountedSlot.current !== slot) {
      mountedSlot.current = slot
      setTune(loadManualTune(slot))
    }
  }, [slot])

  const update = useCallback(
    (patch: Partial<ManualTune>) => {
      setTune((prev) => {
        const next = { ...prev, ...patch }
        saveManualTune(next, slot)
        return next
      })
    },
    [slot],
  )

  const applyPreset = useCallback(
    (level: Aggressiveness) => {
      const next: ManualTune = { aggressiveness: level, ...MANUAL_TUNE_PRESETS[level] }
      setTune(next)
      saveManualTune(next, slot)
    },
    [slot],
  )

  const reset = useCallback(() => {
    setTune(MANUAL_TUNE_DEFAULTS)
    saveManualTune(MANUAL_TUNE_DEFAULTS, slot)
  }, [slot])

  return { tune, update, applyPreset, reset }
}