/**
 * Robot market-open limits by subscription tier.
 *
 * Free users and subscribers who have held an active subscription for fewer
 * than 30 days get the "starter" tier: the robot may open positions on at most
 * 6 currency pairs, with only 1 position per pair at a time. Once a user has
 * been an active subscriber for 30 days or more the limit is lifted — the full
 * watchlist and the configured per-pair caps apply. Admins are never limited.
 *
 * The same rule is mirrored server-side in the `robot-runner` Edge Function so
 * it is enforced even when the page is closed (see
 * supabase/functions/robot-runner/index.ts).
 */
import type { Profile, SubscriptionRow } from '../types'
import type { RobotConfig } from './types'

/** Max distinct pairs the starter tier may open positions on. */
export const STARTER_MAX_PAIRS = 6
/** Max open positions per pair for the starter tier. */
export const STARTER_MAX_PER_PAIR = 1
/** Days of active subscription that unlock the full limits. */
export const UNLOCK_SUBSCRIPTION_DAYS = 30

const DAY_MS = 86_400_000

export interface RobotTier {
  /** True for free users and subscribers under 30 days. */
  limited: boolean
  /** How long the user has been an active subscriber, in days (null = no active subscription). */
  subscriberDays: number | null
  /** Max distinct pairs the robot may open positions on (Infinity = unlocked). */
  maxPairs: number
  /** Max open positions per pair when limited (Infinity = unlocked). */
  maxPerPair: number
}

/**
 * How long the user has held an active subscription. Anchored to the EARLIEST
 * still-active subscription's start (starts_at, falling back to activated_at,
 * then created_at), so a user who has kept an active subscription through
 * renewals counts from their first activation. Expired/ended rows are ignored.
 * Returns null when there is no active subscription (free / trial user).
 */
export function subscriberDays(subscriptions: SubscriptionRow[], now = Date.now()): number | null {
  const starts = subscriptions
    .filter((s) => s.status === 'active' && (!s.ends_at || new Date(s.ends_at).getTime() > now))
    .map((s) => s.starts_at ?? s.activated_at ?? s.created_at)
    .filter((t): t is string => Boolean(t))
    .map((t) => new Date(t).getTime())
  if (starts.length === 0) return null
  return Math.max(0, Math.floor((now - Math.min(...starts)) / DAY_MS))
}

/** The robot market-open tier for a user, from their profile + subscriptions. */
export function robotTier(
  profile: Pick<Profile, 'role'> | null,
  subscriptions: SubscriptionRow[],
  now = Date.now(),
): RobotTier {
  if (profile?.role === 'admin') {
    return { limited: false, subscriberDays: null, maxPairs: Infinity, maxPerPair: Infinity }
  }
  const days = subscriberDays(subscriptions, now)
  const unlocked = days != null && days >= UNLOCK_SUBSCRIPTION_DAYS
  return {
    limited: !unlocked,
    subscriberDays: days,
    maxPairs: unlocked ? Infinity : STARTER_MAX_PAIRS,
    maxPerPair: unlocked ? Infinity : STARTER_MAX_PER_PAIR,
  }
}

export interface EffectiveRobotCaps {
  /** At most this many ranked targets the robot may open on (Infinity = all). */
  maxTargets: number
  tradeMode: RobotConfig['tradeMode']
  maxPerPair: number
  /** 0 = no global cap beyond the per-pair caps. */
  maxOpenTrades: number
}

/**
 * Apply the tier to the user's chosen robot caps. Limited tiers are forced to
 * sequential mode, 1 position per pair, at most 6 distinct pairs and a global
 * cap of 6 open positions; unlocked tiers keep the user's settings untouched.
 */
export function effectiveRobotCaps(
  tier: RobotTier,
  desired: { tradeMode: RobotConfig['tradeMode']; maxPerPair: number; maxOpenTrades: number },
): EffectiveRobotCaps {
  if (!tier.limited) {
    return {
      maxTargets: Infinity,
      tradeMode: desired.tradeMode,
      maxPerPair: Math.max(1, desired.maxPerPair),
      maxOpenTrades: Math.max(0, desired.maxOpenTrades),
    }
  }
  const global = desired.maxOpenTrades > 0 ? Math.min(STARTER_MAX_PAIRS, desired.maxOpenTrades) : STARTER_MAX_PAIRS
  return {
    maxTargets: STARTER_MAX_PAIRS,
    tradeMode: 'sequential',
    maxPerPair: STARTER_MAX_PER_PAIR,
    maxOpenTrades: global,
  }
}