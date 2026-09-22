/**
 * Durable robot state — the Supabase copy of what the browser keeps locally.
 *
 * The robot's running flag, auto-run window, session-guard baseline, last-run
 * stamp, trading config (pairs + strategy + sizing + stops + session limits),
 * autopilot prefs (duration, trade mode, pair caps) + manual-tune profile and
 * activity feed are written to `robot_state` (one row per user + robot slot)
 * and read back on load, so a refresh — or moving to another tab, device or
 * browser — restores what the robot was doing instead of starting blank.
 *
 * localStorage stays the fast path: every call here is best-effort and guarded,
 * so anonymous visitors (no user id) and offline runs keep working exactly as
 * before, with the local copy as the only store.
 */
import { isSupabaseConfigured, supabase } from '../supabase'
import { defaultParams } from '../strategies'
import type { Interval, RobotPrefs, StrategyConfig, StrategyParams, StrategyType, TradingMethod } from '../types'
import { normalizeLots } from './lots'
import { sanitizePrefs } from './robotPrefs'
import { sanitizeTune, type ManualTune } from './manualTune'
import type { ActivityEntry } from './robotActivity'

export interface RobotStateRow {
  id: string
  user_id: string
  robot_number: number
  running: boolean
  /** Auto-run window end (epoch ms), or null when "until stopped". */
  run_end_at: number | null
  /** When the current run started (epoch ms), or null. */
  run_start_at: number | null
  /** Equity captured when the run started (USD), or null. */
  session_start_equity: number | null
  /** When the robot last ran a successful cycle (epoch ms), or null. */
  last_run_at: number | null
  /** The pairs the robot trades (the ticked list). */
  pairs: string[]
  /** The robot's strategy configuration (method, mode, manual type, selected). */
  strategy: RobotStrategyState | null
  /** The robot's position sizing (mode, risk %, fixed lot). */
  sizing: RobotSizingState | null
  /** The robot's per-trade stop overrides (TP/SL pips, 0 = risk-based default). */
  stops: RobotStopsState | null
  /** The robot's session guardrails (max profit/loss USD, pull-back %). */
  limits: RobotLimitsState | null
  /**
   * The robot's full autopilot configuration (auto-run duration, trade mode,
   * pair count, per-pair / max-open / per-cycle caps …), captured so a restore
   * on another device keeps the COMPLETE run configuration. Without it a
   * resumed robot ran "until stopped" with a single position per pair and no
   * cycle cap, whatever this device happened to have saved.
   */
  prefs: RobotPrefs | null
  /** The manual-tune profile (aggressiveness knobs + guardrails). */
  tune: ManualTune | null
  /** Persisted activity feed, newest first. */
  activity: ActivityEntry[]
  updated_at: string | null
}

/**
 * The robot's strategy configuration, captured so a reload on another device
 * restores WHAT the robot trades (pairs + strategy), not just that it was
 * running — without it a restored `running` robot came back trading the
 * default pairs with the default strategy.
 */
export interface RobotStrategyState {
  method: TradingMethod
  strategyMode: 'auto' | 'manual'
  manualStrategy: StrategyType
  autoPickPairs: boolean
  /** The strategy profile the workspace was last configured with. */
  selected?: StrategyConfig
}

/**
 * The robot's position sizing, captured so a run that resumes on another device
 * trades at the SAME size it was configured with: 'risk' = a % of equity per
 * trade sized against the trade's own stop, 'fixed' = one picked lot on every
 * trade. Without it a restored robot fell back to the default risk sizing (or a
 * blank fixed lot, which refuses to start at all).
 */
export interface RobotSizingState {
  sizingMode: 'risk' | 'fixed'
  /** % of current equity risked per trade (clamped to the 0.05–10 band). */
  riskPerTradePct: number
  /** Fixed lot in 0.01 steps (0 = none picked yet — fixed mode won't start). */
  lot: number
}

/**
 * The robot's per-trade stop overrides, captured so a run that resumes on
 * another device keeps the SAME TP/SL pips instead of falling back to the
 * strategy's risk-based defaults. 0 = off (the risk-based default applies).
 */
export interface RobotStopsState {
  /** Per-trade take-profit override in pips (0 = off). */
  tpPips: number
  /** Per-trade stop-loss override in pips (0 = off). */
  slPips: number
}

/**
 * The robot's session guardrails, captured so a run that resumes on another
 * device keeps the SAME profit/loss limits and pull-back lock — the robot
 * stops and flattens at the same numbers it was configured with instead of
 * running unprotected against a different device's defaults.
 */
export interface RobotLimitsState {
  /** Session max profit in USD (0 = off). */
  maxProfitUsd: number
  /** Session max loss in USD (0 = off). */
  maxLossUsd: number
  /** Profit pull-back lock % — a winner closes after giving back this much (0 = off). */
  pullbackPct: number
}

/** A partial update: omitted fields are left untouched in the row. */
export interface RobotStatePatch {
  running?: boolean
  run_end_at?: number | null
  run_start_at?: number | null
  session_start_equity?: number | null
  last_run_at?: number | null
  pairs?: string[]
  strategy?: RobotStrategyState | null
  sizing?: RobotSizingState | null
  stops?: RobotStopsState | null
  limits?: RobotLimitsState | null
  prefs?: RobotPrefs | null
  tune?: ManualTune | null
  activity?: ActivityEntry[]
}

const STRATEGY_TYPES_SET: ReadonlySet<string> = new Set(['MA', 'RSI', 'MACD', 'BOLLINGER'])
const INTERVAL_SET: ReadonlySet<string> = new Set(['1min', '5min', '15min', '30min', '1h', '4h', '1day'])

/** Coerce the stored jsonb pairs list into well-formed symbols. */
export function pairsFrom(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((s): s is string => typeof s === 'string')
}

/** Coerce the stored jsonb strategy object into a typed, valid state (or null
 *  when the blob isn't a strategy at all). Every field falls back to a safe
 *  default so a corrupt/partial row can never crash the Trading page. */
export function strategyFrom(v: unknown): RobotStrategyState | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (o.strategyMode !== 'auto' && o.strategyMode !== 'manual') return null
  const sel = o.selected && typeof o.selected === 'object' ? (o.selected as Record<string, unknown>) : null
  let selected: StrategyConfig | undefined
  if (sel && typeof sel.type === 'string' && STRATEGY_TYPES_SET.has(sel.type)) {
    const type = sel.type as StrategyType
    selected = {
      type,
      pair: typeof sel.pair === 'string' ? sel.pair : 'EUR/USD',
      interval: typeof sel.interval === 'string' && INTERVAL_SET.has(sel.interval) ? (sel.interval as Interval) : '5min',
      params: sel.params && typeof sel.params === 'object' ? (sel.params as StrategyParams) : defaultParams(type),
    }
  }
  return {
    method: o.method === 'longterm' ? 'longterm' : 'scalping',
    strategyMode: o.strategyMode,
    manualStrategy: typeof o.manualStrategy === 'string' && STRATEGY_TYPES_SET.has(o.manualStrategy)
      ? (o.manualStrategy as StrategyType)
      : 'MA',
    autoPickPairs: o.autoPickPairs === true,
    selected,
  }
}

/** Coerce the stored jsonb sizing object into a typed, valid state (or null
 *  when the blob isn't sizing at all). Invalid numbers fall back to the safe
 *  defaults — risk % clamped into the 0.05–10 band, lot snapped to the 0.01
 *  step — so a corrupt/partial row can never lock Start or size a trade wildly. */
export function sizingFrom(v: unknown): RobotSizingState | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (o.sizingMode !== 'risk' && o.sizingMode !== 'fixed') return null
  const risk = Number(o.riskPerTradePct)
  const lot = Number(o.lot)
  return {
    sizingMode: o.sizingMode,
    riskPerTradePct: Number.isFinite(risk) ? Math.min(10, Math.max(0.05, risk)) : 1,
    lot: Number.isFinite(lot) ? normalizeLots(lot) : 0,
  }
}

/** Coerce the stored jsonb per-trade stops into a typed, valid state (or null
 *  when the blob isn't a stops object). Pips are floored at 0 — a corrupt or
 *  partial row can never produce a negative stop or a huge unsigned value. */
export function stopsFrom(v: unknown): RobotStopsState | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const tp = Number(o.tpPips)
  const sl = Number(o.slPips)
  return {
    tpPips: Number.isFinite(tp) ? Math.max(0, tp) : 0,
    slPips: Number.isFinite(sl) ? Math.max(0, sl) : 0,
  }
}

/** Coerce the stored jsonb session limits into a typed, valid state (or null
 *  when the blob isn't a limits object). USD amounts are floored at 0 (off);
 *  the pull-back % is clamped into the 0–90 band the UI allows, so a typo'd or
 *  hostile row can never trap a winner into closing almost immediately. */
export function limitsFrom(v: unknown): RobotLimitsState | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const profit = Number(o.maxProfitUsd)
  const loss = Number(o.maxLossUsd)
  const pullback = Number(o.pullbackPct)
  return {
    maxProfitUsd: Number.isFinite(profit) ? Math.max(0, profit) : 0,
    maxLossUsd: Number.isFinite(loss) ? Math.max(0, loss) : 0,
    pullbackPct: Number.isFinite(pullback) ? Math.min(90, Math.max(0, pullback)) : 0,
  }
}

/** Coerce the stored jsonb autopilot config into a complete RobotPrefs (or
 *  null when the blob isn't an object at all). Reuses the same validator as
 *  the localStorage copy, so a restored config obeys exactly the rules a
 *  locally saved one does. */
export function prefsFrom(v: unknown): RobotPrefs | null {
  if (!v || typeof v !== 'object') return null
  return sanitizePrefs(v as Partial<RobotPrefs>)
}

/** Coerce the stored jsonb manual-tune profile into a typed ManualTune (or
 *  null when the blob isn't an object at all). Every knob is clamped to its
 *  sane band — a corrupt row can never size a trade 10×, or zero, the default. */
export function tuneFrom(v: unknown): ManualTune | null {
  if (!v || typeof v !== 'object') return null
  return sanitizeTune(v)
}

/** Postgres bigint comes back as a string in some drivers — normalise to a number. */
function numOrNull(v: unknown): number | null {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** Coerce the stored jsonb feed into well-formed entries. */
function activityFrom(v: unknown): ActivityEntry[] {
  if (!Array.isArray(v)) return []
  return v.filter(
    (e): e is ActivityEntry =>
      !!e &&
      typeof e === 'object' &&
      typeof (e as ActivityEntry).m === 'string' &&
      typeof (e as ActivityEntry).t === 'number',
  )
}

/**
 * Load a slot's durable robot state (null when nothing is saved yet, when the
 * visitor is anonymous, or when Supabase is unreachable).
 */
export async function loadRobotState(userId: string, robotNumber = 1): Promise<RobotStateRow | null> {
  if (!isSupabaseConfigured || !userId) return null
  try {
    const { data } = await supabase
      .from('robot_state')
      .select('*')
      .eq('user_id', userId)
      .eq('robot_number', robotNumber)
      .maybeSingle()
    if (!data) return null
    const row = data as unknown as RobotStateRow
    return {
      ...row,
      running: row.running === true,
      run_end_at: numOrNull(row.run_end_at),
      run_start_at: numOrNull(row.run_start_at),
      session_start_equity: numOrNull(row.session_start_equity),
      last_run_at: numOrNull(row.last_run_at),
      pairs: pairsFrom(row.pairs),
      strategy: strategyFrom(row.strategy),
      sizing: sizingFrom(row.sizing),
      stops: stopsFrom(row.stops),
      limits: limitsFrom(row.limits),
      prefs: prefsFrom(row.prefs),
      tune: tuneFrom(row.tune),
      activity: activityFrom(row.activity),
    }
  } catch {
    return null
  }
}

/**
 * Mirror a patch of durable state to Supabase (upsert — one row per slot).
 * Fire-and-forget: a failed write leaves the localStorage copy authoritative.
 */
export async function saveRobotState(
  userId: string,
  robotNumber: number,
  patch: RobotStatePatch,
): Promise<void> {
  if (!isSupabaseConfigured || !userId) return
  try {
    await supabase.from('robot_state').upsert(
      {
        user_id: userId,
        robot_number: robotNumber,
        ...patch,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,robot_number' },
    )
  } catch {
    /* best-effort — the local copy still exists */
  }
}

/** Forget a slot's durable state (used when an account is reset). */
export async function clearRobotState(userId: string, robotNumber: number): Promise<void> {
  if (!isSupabaseConfigured || !userId) return
  try {
    await supabase.from('robot_state').delete().eq('user_id', userId).eq('robot_number', robotNumber)
  } catch {
    /* best-effort */
  }
}
