/**
 * Records robot runs as sessions + equity history so users can review past
 * performance (Performance page) and admins can see robot usage. Defensive:
 * silently no-ops for anonymous visitors and when Supabase is unavailable.
 *
 * A session opens as soon as the account shows any activity — the robot is
 * running, a position is open, or a trade is on the books — and stays open for
 * the life of the page, INCLUDING while the robot is paused or stopped. This
 * is deliberate: positions keep closing at market / SL / TP after the robot
 * stops, so the equity curve must keep accruing those settled results instead
 * of freezing the moment trading pauses.
 *
 * Sessions close when the account changes (reset) and on unmount (navigation
 * away / refresh / sign out) — without the unmount close, every page load with
 * persisted auto-trading would leak a phantom 'running' session.
 */
import { useEffect, useRef } from 'react'
import type { User } from '@supabase/supabase-js'
import type { AccountState, RatesMap } from './types'
import { equity } from './engine'
import { isSupabaseConfigured, supabase } from '../supabase'

interface UseRobotRecorderOptions {
  user: User | null
  account: AccountState | null
  running: boolean
  strategyLabel: string
  method: 'scalping' | 'longterm'
  rates: RatesMap
}

export function useRobotRecorder(opts: UseRobotRecorderOptions) {
  const { user, account, running, strategyLabel, method, rates } = opts
  const sessionIdRef = useRef<string | null>(null)
  const lastWriteRef = useRef<number>(0)
  const accountIdRef = useRef<string | null>(null)
  // Latest values mirrored into refs so the unmount cleanup can close the
  // session with final figures even while the component is being torn down.
  const userRef = useRef(user)
  userRef.current = user
  const accountRef = useRef(account)
  accountRef.current = account
  const ratesRef = useRef(rates)
  ratesRef.current = rates

  // The account has something worth recording: the robot is running, or there
  // are open positions, or trades already closed — the session stays open
  // across pauses so history keeps accruing while the account settles.
  const hasActivity = Boolean(
    user && account && (running || account.positions.length > 0 || account.trades.length > 0),
  )

  // Open a session when the account first shows activity. Keyed on
  // `account?.id` so switching accounts always opens a session for the right
  // ledger (the previous one is closed by the close-on-account-change effect).
  useEffect(() => {
    if (!hasActivity || !account) return
    if (sessionIdRef.current) return
    let cancelled = false
    void (async () => {
      if (!isSupabaseConfigured) return
      const { data } = await supabase
        .from('robot_sessions')
        .insert({
          user_id: user?.id,
          account_id: account.id,
          method,
          strategy: strategyLabel,
          initial_balance: account.initialBalance,
          status: 'running',
        })
        .select('id')
        .maybeSingle()
      if (!cancelled && data?.id) {
        sessionIdRef.current = data.id
        accountIdRef.current = account.id
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasActivity, account?.id])

  // Record equity history points for as long as the account is open on this
  // page. Throttled: ~1/sec while the robot runs, ~1/5s while paused/stopped —
  // enough to keep the curve accruing settled P&L without flooding the table.
  useEffect(() => {
    if (!user || !account) return
    const sessionId = sessionIdRef.current
    if (!sessionId || !isSupabaseConfigured) return
    const now = Date.now()
    const minGap = running ? 1000 : 5000
    if (now - lastWriteRef.current < minGap) return
    lastWriteRef.current = now
    const unrealized = equity(account, rates) - account.balance
    void supabase.from('robot_history').insert({
      user_id: user.id,
      account_id: account.id,
      session_id: sessionId,
      balance: account.balance,
      equity: equity(account, rates),
      unrealized,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account, running, rates])

  // Close the current session with final figures. Idempotent — a null
  // session id means it already ran (account change, unmount, reset).
  const closeSession = () => {
    const sessionId = sessionIdRef.current
    if (!sessionId) return
    const accountId = accountIdRef.current
    sessionIdRef.current = null
    accountIdRef.current = null
    const u = userRef.current
    const acc = accountRef.current
    if (!u || !acc || !isSupabaseConfigured) return
    void supabase
      .from('robot_sessions')
      .update({
        ended_at: new Date().toISOString(),
        status: 'finished',
        final_balance: acc.balance,
        pnl: acc.balance - acc.initialBalance,
        trade_count: acc.trades.length,
      })
      .eq('id', sessionId)
    void supabase
      .from('robot_history')
      .insert({
        user_id: u.id,
        account_id: accountId,
        session_id: sessionId,
        balance: acc.balance,
        equity: equity(acc, ratesRef.current),
        unrealized: equity(acc, ratesRef.current) - acc.balance,
      })
  }
  const closeSessionRef = useRef(closeSession)
  closeSessionRef.current = closeSession

  // Close the session when the account changes (reset / switch) so the run is
  // never recorded against the wrong account.
  useEffect(() => {
    return () => {
      closeSessionRef.current()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account?.id])

  // Close on unmount (navigate away / refresh / sign out) so a reload can
  // never leak a phantom 'running' session. The server-side runner opens its
  // own session when it takes over.
  useEffect(() => {
    return () => {
      closeSessionRef.current()
    }
  }, [])
}