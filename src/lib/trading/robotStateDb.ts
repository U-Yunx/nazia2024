/**
 * Durable robot state — the Supabase copy of what the browser keeps locally.
 *
 * The robot's running flag, auto-run window, session-guard baseline, last-run
 * stamp and activity feed are written to `robot_state` (one row per user + robot
 * slot) and read back on load, so a refresh — or moving to another tab, device
 * or browser — restores what the robot was doing instead of starting blank.
 *
 * localStorage stays the fast path: every call here is best-effort and guarded,
 * so anonymous visitors (no user id) and offline runs keep working exactly as
 * before, with the local copy as the only store.
 */
import { isSupabaseConfigured, supabase } from '../supabase'
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
  /** Persisted activity feed, newest first. */
  activity: ActivityEntry[]
  updated_at: string | null
}

/** A partial update: omitted fields are left untouched in the row. */
export interface RobotStatePatch {
  running?: boolean
  run_end_at?: number | null
  run_start_at?: number | null
  session_start_equity?: number | null
  last_run_at?: number | null
  activity?: ActivityEntry[]
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
