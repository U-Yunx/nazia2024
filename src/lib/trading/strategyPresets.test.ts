/**
 * Strategy-preset tests: the Pro scale-out preset encodes the battle-tested
 * exit values (50% at 1R → break-even → trail) and its risk guardrails.
 */
import { describe, expect, it } from 'vitest'
import { proStrategyPreset, PRO_PARTIAL, presetById, strategyPresets } from './strategyPresets'

describe('proStrategyPreset', () => {
  it('enables the partial take-profit scale-out for both methods', () => {
    for (const method of ['scalping', 'longterm'] as const) {
      const p = proStrategyPreset(method)
      expect(p.id).toBe('pro')
      expect(p.risk.partialTakeProfit).toBe(true)
      expect(p.risk.partialClosePct).toBe(50)
      expect(p.risk.partialTpRatio).toBe(1)
    }
  })

  it('ships the risk guardrails of a stable robot', () => {
    const p = proStrategyPreset('scalping')
    expect(p.risk.trailingStop).toBe(true)
    expect(p.risk.breakEvenPips).toBeGreaterThan(0)
    expect(p.risk.profitPullbackPct).toBe(30)
    expect(p.risk.drawdownClosePct).toBe(20)
    expect(p.risk.maxConsecutiveLosses).toBeGreaterThan(0)
    expect(p.risk.adaptiveRisk).toBe(true)
    expect(p.risk.volatilityFilter).toBe(true)
    expect(p.risk.takeProfitRatio).toBeGreaterThan(1)
  })

  it('trades more: concurrent mode, 2 per pair, up to 6 open', () => {
    const p = proStrategyPreset('scalping')
    expect(p.prefs.tradeMode).toBe('concurrent')
    expect(p.prefs.maxPerPair).toBe(2)
    expect(p.prefs.maxOpenTrades).toBe(6)
    expect(p.prefs.autoPickPairs).toBe(true)
  })

  it('tunes stops per method — scalping tight, long-term wide', () => {
    const scalp = proStrategyPreset('scalping')
    const long = proStrategyPreset('longterm')
    expect(scalp.risk.defaultStopPips).toBeLessThan(long.risk.defaultStopPips ?? 0)
    expect(scalp.risk.trailPips ?? 0).toBeLessThan(long.risk.trailPips ?? 0)
    expect(long.risk.takeProfitRatio).toBeGreaterThanOrEqual(scalp.risk.takeProfitRatio ?? 0)
  })

  it('keeps the user-facing description human and specific', () => {
    const p = proStrategyPreset('scalping')
    expect(p.name).toBe('Pro Scale-Out')
    expect(p.tagline).toMatch(/2 legs/i)
    expect(p.description).toMatch(/50% at 1R/i)
    expect(p.description).toMatch(/break-even/i)
  })
})

describe('PRO_PARTIAL / preset lookup', () => {
  it('exposes the scale-out constants', () => {
    expect(PRO_PARTIAL).toEqual({ partialTakeProfit: true, partialClosePct: 50, partialTpRatio: 1 })
  })

  it('lists the scalping and longterm variants', () => {
    const presets = strategyPresets()
    expect(presets).toHaveLength(2)
    expect(presets.map((p) => p.id)).toEqual(['pro', 'pro'])
  })

  it('looks a preset up by id', () => {
    expect(presetById('pro')).toBeDefined()
    expect(presetById('nope')).toBeUndefined()
  })
})
