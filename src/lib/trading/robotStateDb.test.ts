import { describe, expect, it } from 'vitest'
import { isSupabaseConfigured } from '../supabase'
import { clearRobotState, loadRobotState, pairsFrom, saveRobotState, sizingFrom, strategyFrom } from './robotStateDb'

/**
 * With no Supabase env vars configured (CI and fresh previews) the client is the
 * offline no-op stub, so every durable robot-state call must resolve safely and
 * report "nothing saved" — the Trading page then falls back to its localStorage
 * copy instead of crashing on load.
 */
describe('robotStateDb (offline)', () => {
  it('runs against the offline client', () => {
    expect(isSupabaseConfigured).toBe(false)
  })

  it('loads nothing when Supabase is not configured', async () => {
    expect(await loadRobotState('user-1', 1)).toBeNull()
  })

  it('saves and clears without throwing', async () => {
    await expect(
      saveRobotState('user-1', 1, { running: true, activity: [{ t: 1, m: 'Started.' }] }),
    ).resolves.toBeUndefined()
    await expect(clearRobotState('user-1', 1)).resolves.toBeUndefined()
  })

  it('is a no-op without a user id (anonymous visitors stay local-only)', async () => {
    expect(await loadRobotState('', 1)).toBeNull()
    await expect(saveRobotState('', 1, { running: true })).resolves.toBeUndefined()
    await expect(clearRobotState('', 1)).resolves.toBeUndefined()
  })

  it('accepts every field of a full state patch', async () => {
    await expect(
      saveRobotState('user-1', 2, {
        running: false,
        run_end_at: null,
        run_start_at: 1_700_000_000_000,
        session_start_equity: 10_000,
        last_run_at: 1_700_000_100_000,
        activity: [],
      }),
    ).resolves.toBeUndefined()
  })

  it('mirrors the trading config (pairs + strategy) without throwing', async () => {
    await expect(
      saveRobotState('user-1', 1, {
        pairs: ['EUR/USD', 'GBP/USD'],
        strategy: {
          method: 'longterm',
          strategyMode: 'manual',
          manualStrategy: 'MACD',
          autoPickPairs: false,
          selected: { type: 'MACD', pair: 'GBP/USD', interval: '1h', params: { fast: 12 } },
        },
        sizing: { sizingMode: 'fixed', riskPerTradePct: 2, lot: 0.05 },
      }),
    ).resolves.toBeUndefined()
  })
})

/**
 * The row comes back as jsonb, so every field is untrusted: a corrupt or
 * partial blob must coerce to something the Trading page can apply safely
 * rather than throwing or restoring garbage pairs/strategy.
 */
describe('robotStateDb normalizers', () => {
  it('keeps only well-formed symbols from a pairs blob', () => {
    expect(pairsFrom(['EUR/USD', 42, 'GBP/JPY', null, { s: 'x' }])).toEqual(['EUR/USD', 'GBP/JPY'])
    expect(pairsFrom([])).toEqual([])
    expect(pairsFrom(null)).toEqual([])
    expect(pairsFrom('EUR/USD')).toEqual([])
  })

  it('round-trips a full strategy blob', () => {
    expect(
      strategyFrom({
        method: 'longterm',
        strategyMode: 'manual',
        manualStrategy: 'MACD',
        autoPickPairs: true,
        selected: { type: 'MACD', pair: 'GBP/USD', interval: '1h', params: { fast: 12 } },
      }),
    ).toEqual({
      method: 'longterm',
      strategyMode: 'manual',
      manualStrategy: 'MACD',
      autoPickPairs: true,
      selected: { type: 'MACD', pair: 'GBP/USD', interval: '1h', params: { fast: 12 } },
    })
  })

  it('rejects a blob that is not a strategy at all', () => {
    expect(strategyFrom(null)).toBeNull()
    expect(strategyFrom('MACD')).toBeNull()
    expect(strategyFrom({ strategyMode: 'turbo' })).toBeNull()
    expect(strategyFrom({ method: 'scalping' })).toBeNull()
  })

  it('falls back to safe defaults for invalid fields', () => {
    const s = strategyFrom({
      method: 'weird',
      strategyMode: 'auto',
      manualStrategy: 'TURBO',
      autoPickPairs: 'yes',
      selected: { type: 'RSI', params: [] },
    })
    expect(s?.method).toBe('scalping')
    expect(s?.strategyMode).toBe('auto')
    expect(s?.manualStrategy).toBe('MA')
    // Only a real `true` counts — a truthy string must not switch auto-pick on.
    expect(s?.autoPickPairs).toBe(false)
    expect(s?.selected?.type).toBe('RSI')
    expect(s?.selected?.interval).toBe('5min')
    expect(s?.selected?.params).toEqual([])
  })

  it('drops an unknown strategy type but keeps the mode/method', () => {
    const s = strategyFrom({
      method: 'scalping',
      strategyMode: 'manual',
      manualStrategy: 'BOLLINGER',
      autoPickPairs: false,
      selected: { type: 'SUPERTREND' },
    })
    expect(s?.selected).toBeUndefined()
    expect(s?.manualStrategy).toBe('BOLLINGER')
  })

  it('round-trips a full sizing blob', () => {
    expect(sizingFrom({ sizingMode: 'fixed', riskPerTradePct: 2.5, lot: 0.25 })).toEqual({
      sizingMode: 'fixed',
      riskPerTradePct: 2.5,
      lot: 0.25,
    })
  })

  it('rejects a blob that is not sizing at all', () => {
    expect(sizingFrom(null)).toBeNull()
    expect(sizingFrom(0.5)).toBeNull()
    expect(sizingFrom('fixed')).toBeNull()
    expect(sizingFrom({ lot: 0.1 })).toBeNull()
    expect(sizingFrom({ sizingMode: 'turbo', lot: 0.1 })).toBeNull()
  })

  it('clamps risk % into the 0.05–10 band and snaps the lot to 0.01 steps', () => {
    // A stale/hostile row can never size a trade outside the supported ranges.
    expect(sizingFrom({ sizingMode: 'risk', riskPerTradePct: 0, lot: 0 })?.riskPerTradePct).toBe(0.05)
    expect(sizingFrom({ sizingMode: 'risk', riskPerTradePct: 500, lot: 0 })?.riskPerTradePct).toBe(10)
    expect(sizingFrom({ sizingMode: 'fixed', riskPerTradePct: 1, lot: 0.013 })?.lot).toBeCloseTo(0.01, 4)
    expect(sizingFrom({ sizingMode: 'fixed', riskPerTradePct: 1, lot: 1.999 })?.lot).toBe(2)
  })

  it('falls back to the safe defaults for missing/invalid numbers', () => {
    const s = sizingFrom({ sizingMode: 'risk' })
    expect(s?.sizingMode).toBe('risk')
    expect(s?.riskPerTradePct).toBe(1)
    // No lot picked yet — fixed mode must stay locked rather than invent one.
    expect(s?.lot).toBe(0)
    expect(sizingFrom({ sizingMode: 'fixed', riskPerTradePct: 'lots', lot: null })?.lot).toBe(0)
    expect(sizingFrom({ sizingMode: 'fixed', riskPerTradePct: NaN, lot: -3 })?.lot).toBe(0)
  })
})
