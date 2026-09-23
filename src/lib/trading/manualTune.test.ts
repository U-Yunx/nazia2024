import { describe, expect, it } from 'vitest'
import {
  MANUAL_TUNE_DEFAULTS,
  MANUAL_TUNE_PRESETS,
  manualTuneKeyForSlot,
  sanitizeTune,
} from './manualTune'

describe('manualTuneKeyForSlot', () => {
  it('keeps the legacy key for slot 1 and namespaces the rest', () => {
    expect(manualTuneKeyForSlot(1)).toBe('ana24.robot-tune')
    expect(manualTuneKeyForSlot(0)).toBe('ana24.robot-tune.manual')
    expect(manualTuneKeyForSlot(2)).toBe('ana24.robot-tune.slot-2')
    expect(manualTuneKeyForSlot(3)).toBe('ana24.robot-tune.slot-3')
  })
})

describe('sanitizeTune', () => {
  it('round-trips every preset exactly', () => {
    for (const level of [1, 2, 3, 4, 5] as const) {
      const preset = { aggressiveness: level, ...MANUAL_TUNE_PRESETS[level] }
      expect(sanitizeTune(preset)).toEqual(preset)
    }
  })

  it('round-trips the defaults', () => {
    expect(sanitizeTune(MANUAL_TUNE_DEFAULTS)).toEqual(MANUAL_TUNE_DEFAULTS)
  })

  it('falls back to the defaults for a blob that is not a tune object', () => {
    expect(sanitizeTune(null)).toEqual(MANUAL_TUNE_DEFAULTS)
    expect(sanitizeTune(7)).toEqual(MANUAL_TUNE_DEFAULTS)
    expect(sanitizeTune('aggressive')).toEqual(MANUAL_TUNE_DEFAULTS)
    expect(sanitizeTune(undefined)).toEqual(MANUAL_TUNE_DEFAULTS)
  })

  it('clamps a hostile size multiplier so trades are never sized to zero', () => {
    // 0 or a negative multiplier scaled every position to zero units, which
    // silently skipped every trade; a huge one multiplied risk unchecked.
    expect(sanitizeTune({ sizeMultiplier: 0 }).sizeMultiplier).toBe(0.05)
    expect(sanitizeTune({ sizeMultiplier: -3 }).sizeMultiplier).toBe(0.05)
    expect(sanitizeTune({ sizeMultiplier: 900 }).sizeMultiplier).toBe(5)
    expect(sanitizeTune({ sizeMultiplier: 'lots' }).sizeMultiplier).toBe(MANUAL_TUNE_DEFAULTS.sizeMultiplier)
  })

  it('clamps risk, targets, position caps and the loss breaker into their bands', () => {
    const t = sanitizeTune({
      aggressiveness: 9,
      riskPerTradePct: 500,
      takeProfitRatio: 0,
      maxOpenPositions: 0,
      maxDailyLossPct: -10,
      maxConsecutiveLosses: -4,
      targetProfitPct: -1,
    })
    expect(t.aggressiveness).toBe(5)
    expect(t.riskPerTradePct).toBe(10)
    expect(t.takeProfitRatio).toBe(0.5)
    expect(t.maxOpenPositions).toBe(1)
    expect(t.maxDailyLossPct).toBe(0)
    expect(t.maxConsecutiveLosses).toBe(0)
    expect(t.targetProfitPct).toBe(0)
  })

  it('rounds the discrete knobs and never yields a fractional level or cap', () => {
    const t = sanitizeTune({ aggressiveness: 3.7, maxOpenPositions: 4.6, maxConsecutiveLosses: 2.2 })
    expect(t.aggressiveness).toBe(4)
    expect(t.maxOpenPositions).toBe(5)
    expect(t.maxConsecutiveLosses).toBe(2)
  })

  it('keeps the guardrail flags boolean — adaptive risk on unless explicitly off', () => {
    expect(sanitizeTune({}).adaptiveRisk).toBe(true)
    expect(sanitizeTune({ adaptiveRisk: false }).adaptiveRisk).toBe(false)
    // Anything that is not `false` keeps the guardrail ON — a stale string must
    // never silently disable de-risking after a losing streak.
    expect(sanitizeTune({ adaptiveRisk: 'off' }).adaptiveRisk).toBe(true)
    expect(sanitizeTune({ volatilityFilter: 'yes' }).volatilityFilter).toBe(false)
    expect(sanitizeTune({ volatilityFilter: true }).volatilityFilter).toBe(true)
  })
})