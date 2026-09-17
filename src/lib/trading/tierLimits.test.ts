/**
 * Tier-limit unit tests: the 6-pair / 1-position-per-pair starter cap for free
 * users and subscribers under 30 days, and the unlock at 30+ days.
 */
import { describe, expect, it } from 'vitest'
import type { SubscriptionRow } from '../types'
import {
  STARTER_MAX_PAIRS,
  STARTER_MAX_PER_PAIR,
  effectiveRobotCaps,
  robotTier,
  subscriberDays,
} from './tierLimits'

const DAY_MS = 86_400_000
const now = Date.UTC(2026, 8, 15, 12, 0, 0) // fixed "today"

function sub(overrides: Partial<SubscriptionRow>): SubscriptionRow {
  return {
    id: 's1',
    user_id: 'u1',
    package_id: 'p1',
    status: 'active',
    amount: 100,
    payment_method: 'bank',
    tx_ref: null,
    activated_by: null,
    activated_at: null,
    starts_at: null,
    ends_at: null,
    robots: 1,
    mt_accounts: 0,
    duration_days: 30,
    created_at: new Date(now - 10 * DAY_MS).toISOString(),
    ...overrides,
  }
}

describe('subscriberDays', () => {
  it('returns null for a user with no active subscription', () => {
    expect(subscriberDays([], now)).toBeNull()
    expect(subscriberDays([sub({ status: 'expired' })], now)).toBeNull()
  })

  it('counts from the earliest active subscription start', () => {
    const subs = [
      sub({ id: 'old', starts_at: new Date(now - 40 * DAY_MS).toISOString() }),
      sub({ id: 'new', starts_at: new Date(now - 5 * DAY_MS).toISOString() }),
    ]
    expect(subscriberDays(subs, now)).toBe(40)
  })

  it('falls back to activated_at then created_at when starts_at is null', () => {
    expect(subscriberDays([sub({ starts_at: null, activated_at: new Date(now - 12 * DAY_MS).toISOString() })], now)).toBe(12)
    expect(subscriberDays([sub({ starts_at: null, activated_at: null })], now)).toBe(10)
  })

  it('ignores subscriptions that already ended', () => {
    const ended = sub({ starts_at: new Date(now - 90 * DAY_MS).toISOString(), ends_at: new Date(now - 30 * DAY_MS).toISOString() })
    expect(subscriberDays([ended], now)).toBeNull()
  })
})

describe('robotTier', () => {
  it('limits a free (no subscription) user to 6 pairs / 1 per pair', () => {
    const tier = robotTier({ role: 'user' }, [], now)
    expect(tier.limited).toBe(true)
    expect(tier.maxPairs).toBe(STARTER_MAX_PAIRS)
    expect(tier.maxPerPair).toBe(STARTER_MAX_PER_PAIR)
  })

  it('limits a subscriber under 30 days', () => {
    const tier = robotTier({ role: 'user' }, [sub({ starts_at: new Date(now - 29 * DAY_MS).toISOString() })], now)
    expect(tier.limited).toBe(true)
    expect(tier.subscriberDays).toBe(29)
  })

  it('unlocks exactly at 30 days', () => {
    const tier = robotTier({ role: 'user' }, [sub({ starts_at: new Date(now - 30 * DAY_MS).toISOString() })], now)
    expect(tier.limited).toBe(false)
    expect(tier.maxPairs).toBe(Infinity)
  })

  it('unlocks a 30+ day subscriber', () => {
    const tier = robotTier({ role: 'user' }, [sub({ starts_at: new Date(now - 45 * DAY_MS).toISOString() })], now)
    expect(tier.limited).toBe(false)
    expect(tier.subscriberDays).toBe(45)
  })

  it('never limits an admin', () => {
    expect(robotTier({ role: 'admin' }, [], now).limited).toBe(false)
  })

  it('counts renewal tenure from the first active subscription', () => {
    const subs = [
      sub({ id: 'first', starts_at: new Date(now - 60 * DAY_MS).toISOString(), ends_at: new Date(now - 30 * DAY_MS).toISOString() }),
      sub({ id: 'renewal', starts_at: new Date(now - 25 * DAY_MS).toISOString() }),
    ]
    // The FIRST period ended; the renewal is active — tenure restarts at renewal.
    expect(subscriberDays(subs, now)).toBe(25)
  })
})

describe('effectiveRobotCaps', () => {
  const limited = robotTier({ role: 'user' }, [], now)
  const unlocked = robotTier({ role: 'user' }, [sub({ starts_at: new Date(now - 31 * DAY_MS).toISOString() })], now)

  it('forces sequential 1-per-pair and caps targets at 6 for the starter tier', () => {
    const caps = effectiveRobotCaps(limited, { tradeMode: 'concurrent', maxPerPair: 5, maxOpenTrades: 0 })
    expect(caps.maxTargets).toBe(STARTER_MAX_PAIRS)
    expect(caps.tradeMode).toBe('sequential')
    expect(caps.maxPerPair).toBe(1)
    expect(caps.maxOpenTrades).toBe(6)
  })

  it('respects a tighter global cap on the starter tier', () => {
    const caps = effectiveRobotCaps(limited, { tradeMode: 'sequential', maxPerPair: 1, maxOpenTrades: 3 })
    expect(caps.maxOpenTrades).toBe(3)
  })

  it('passes user caps through untouched when unlocked', () => {
    const caps = effectiveRobotCaps(unlocked, { tradeMode: 'concurrent', maxPerPair: 4, maxOpenTrades: 20 })
    expect(caps.maxTargets).toBe(Infinity)
    expect(caps.tradeMode).toBe('concurrent')
    expect(caps.maxPerPair).toBe(4)
    expect(caps.maxOpenTrades).toBe(20)
  })
})