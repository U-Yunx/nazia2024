/**
 * Community live-progress + profit-leaderboard data.
 *
 * Both RPCs are SECURITY DEFINER functions that return ONLY name-masked,
 * aggregated rows (see supabase/migrations/20271215_live_progress_leaderboard.sql)
 * — raw accounts, trades and profiles stay behind owner-scoped RLS. When
 * Supabase is absent or the functions are unreachable the hooks degrade to
 * empty lists so pages render their offline empty states.
 */
import { useEffect, useRef, useState } from 'react'
import { isSupabaseConfigured, supabase } from '../lib/supabase'

export interface LiveTrader {
  /** Masked handle, e.g. "A***n" — never an email or full name. */
  handle: string
  /** Current net P&L across the user's paper accounts (USD). */
  pnl: number
  /** Number of open positions right now. */
  open_trades: number
  /** Number of robots actively running right now. */
  active_robots: number
  /** ISO timestamp of their last activity, or null when unknown. */
  last_seen: string | null
}

export interface LeaderboardEntry {
  handle: string
  /** The user's single highest profit event ever (USD, always positive). */
  best_profit: number
  /** Number of winning events (closed trades / sessions / peaks). */
  events: number
  last_seen: string | null
}

/** Postgres numerics arrive as JSON numbers (or strings for extreme values). */
function toNum(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

async function fetchLiveTraders(): Promise<LiveTrader[]> {
  if (!isSupabaseConfigured) return []
  const { data, error } = await supabase.rpc('get_live_traders', { limit_n: 8 })
  if (error || !Array.isArray(data)) return []
  return (data as unknown[]).map((row) => {
    const r = row as Record<string, unknown>
    return {
      handle: String(r.handle ?? 'Trader'),
      pnl: toNum(r.pnl),
      open_trades: Math.round(toNum(r.open_trades)),
      active_robots: Math.round(toNum(r.active_robots)),
      last_seen: (r.last_seen as string | null) ?? null,
    }
  })
}

async function fetchLeaderboard(limit: number): Promise<LeaderboardEntry[]> {
  if (!isSupabaseConfigured) return []
  const { data, error } = await supabase.rpc('get_leaderboard', { limit_n: limit })
  if (error || !Array.isArray(data)) return []
  return (data as unknown[]).map((row) => {
    const r = row as Record<string, unknown>
    return {
      handle: String(r.handle ?? 'Trader'),
      best_profit: toNum(r.best_profit),
      events: Math.round(toNum(r.events)),
      last_seen: (r.last_seen as string | null) ?? null,
    }
  })
}

/**
 * Polls the masked "traders now" feed. Used by the global live-progress bar;
 * refresh interval defaults to 15s.
 */
export function useLiveTraders(intervalMs = 15_000): { traders: LiveTrader[]; loading: boolean } {
  const [traders, setTraders] = useState<LiveTrader[]>([])
  const [loading, setLoading] = useState(true)
  const intervalRef = useRef(intervalMs)
  intervalRef.current = intervalMs

  useEffect(() => {
    let active = true
    const run = async () => {
      const rows = await fetchLiveTraders()
      if (!active) return
      setTraders(rows)
      setLoading(false)
    }
    void run()
    const id = setInterval(() => void run(), intervalRef.current)
    return () => {
      active = false
      clearInterval(id)
    }
  }, [])

  return { traders, loading }
}

/**
 * Polls the public profit-history leaderboard. Used on the public landing page
 * (Home); refresh interval defaults to 60s.
 */
export function useLeaderboard(limit = 10, intervalMs = 60_000): {
  entries: LeaderboardEntry[]
  loading: boolean
} {
  const [entries, setEntries] = useState<LeaderboardEntry[]>([])
  const [loading, setLoading] = useState(true)
  const limitRef = useRef(limit)
  limitRef.current = limit
  const intervalRef = useRef(intervalMs)
  intervalRef.current = intervalMs

  useEffect(() => {
    let active = true
    const run = async () => {
      const rows = await fetchLeaderboard(limitRef.current)
      if (!active) return
      setEntries(rows)
      setLoading(false)
    }
    void run()
    const id = setInterval(() => void run(), intervalRef.current)
    return () => {
      active = false
      clearInterval(id)
    }
  }, [])

  return { entries, loading }
}
