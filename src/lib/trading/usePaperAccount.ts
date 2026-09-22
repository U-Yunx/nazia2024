import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '../../hooks/useAuth'
import type {
  AccountState,
  ApplySignalInput,
  BrokerMode,
  CloseReason,
  OpenPositionRequest,
  RatesMap,
  RiskConfig,
  RobotConfig,
  RobotCycleInput,
  Side,
} from './types'
import { applySignal, canOpen, closeAllPositions, closeRobotPositions as engineCloseRobotPositions, createAccount, openPosition } from './engine'
import { clearLocal, loadLocal, loadRemote, resetRemote, saveLocal, saveRemote } from './persistence'
import { clearRobotRunning, loadRobotRunning, saveRobotRunning } from './robotState'
import { createBroker, type BrokerAdapter } from './broker'
import { MIN_PAPER_DEPOSIT, startingBalanceForKind } from './accountKind'
import type { PaperAccountKind } from './types'

const MODE_KEY = 'fx-toolkit.broker-mode'

/** localStorage key for a scope's broker mode: slot 0 (manual trading) and
 *  slots 2..N get their own key so each workspace keeps its own paper/live
 *  mode; slot 1 keeps the legacy key so existing users keep their mode. */
export function modeKeyForRobot(robot: number): string {
  if (robot === 0) return `${MODE_KEY}.manual`
  return robot > 1 ? `${MODE_KEY}.slot-${robot}` : MODE_KEY
}

function initialMode(robot: number): BrokerMode {
  try {
    const saved = localStorage.getItem(modeKeyForRobot(robot))
    if (saved === 'oanda' || saved === 'mt' || saved === 'managed') return saved
    return 'paper'
  } catch {
    return 'paper'
  }
}

/** Robot on/off flag key: slot 0 (manual trading) and slots 2..N are
 *  namespaced so a refresh on one workspace can't turn another back on; slot 1
 *  keeps the legacy per-user key. */
function stateKey(userId: string | undefined, robot: number): string | undefined {
  if (!userId) return undefined
  if (robot === 0) return `${userId}:manual`
  return robot > 1 ? `${userId}:slot-${robot}` : userId
}

export const DEFAULT_PAPER_BALANCE = 10_000

/**
 * Serialized signatures of the account state last mirrored to Supabase, keyed by
 * `${userId}:${robot}`.
 *
 * Deliberately module-level rather than a ref: it has to OUTLIVE the hook
 * instance so that navigating between pages (or refreshing) doesn't re-write a
 * ledger the server already holds. The old mount-time echo rewrote the whole
 * trade ledger on every page load, which is how a tab change that landed
 * mid-write could wipe the history.
 */
const remoteSignatures = new Map<string, string>()

/** Cache key for a user's robot slot. */
function signatureKey(userId: string, robot: number): string {
  return `${userId}:${robot}`
}

/**
 * Owns the paper account lifecycle: loads (Supabase when signed in, otherwise
 * localStorage), persists on every change, and exposes a `BrokerAdapter` so the
 * UI never talks to the engine directly. `connectionIds` maps each live platform
 * to the broker_connections row it should trade (one per connected broker) —
 * when omitted the bridges fall back to the user's default robot slot.
 * `robot` selects which robot slot this ledger belongs to (1 = first/default);
 * each slot gets its own balance, trades and saved settings so several robots
 * can run side by side.
 */
export function usePaperAccount(connectionIds?: { oanda?: string; mt?: string }, robot = 1) {
  const { user } = useAuth()
  const [account, setAccount] = useState<AccountState | null>(null)
  const [loading, setLoading] = useState(true)
  const [mode, setMode] = useState<BrokerMode>(() => initialMode(robot))

  const stateRef = useRef<AccountState | null>(null)
  stateRef.current = account
  const userRef = useRef(user)
  userRef.current = user

  useEffect(() => {
    let active = true
    setLoading(true)
    void (async () => {
      const u = userRef.current
      let next: AccountState | null = null
      if (u) next = await loadRemote(u, robot)
      if (next) {
        // Repair a ledger the server lost. The old save path deleted every trade
        // row and then failed to re-insert them (it sent null for NOT NULL
        // columns), so signed-in users came back to a blank journal and vanished
        // open positions. If this browser still holds a richer local copy of the
        // same slot, prefer it — the history is restored instead of silently
        // staying lost.
        if (next.trades.length === 0 && next.positions.length === 0) {
          const local = loadLocal(robot)
          if (local && (local.trades.length > 0 || local.positions.length > 0)) next = local
        }
      } else {
        next = loadLocal(robot)
      }
      if (!next) next = createAccount(DEFAULT_PAPER_BALANCE)
      // Restore the robot's on/off state across refreshes / tab closes. Live
      // OANDA / MetaTrader mirrors are never saved (the broker is the source of
      // truth), so the flag written on every start/stop is the only record of
      // whether the robot was running. Paper / managed already carry it on the
      // account — the flag is applied uniformly so every mode behaves the same.
      if (next && loadRobotRunning(stateKey(u?.id, robot))) {
        next = { ...next, risk: { ...next.risk, autoTrade: true } }
      }
      if (active) {
        setAccount(next)
        setLoading(false)
      }
    })()
    return () => {
      active = false
    }
  }, [user?.id, robot])

  useEffect(() => {
    if (!account || loading) return
    // Persist accounts that live on the platform's own ledger (paper and the
    // "managed live" ledger). Live OANDA / MetaTrader mirrors are never saved —
    // their authoritative state is always re-fetched from the broker.
    if (account.broker === 'oanda' || account.broker === 'mt') return
    saveLocal(account, robot)
    const u = userRef.current
    if (!u) return
    // Skip the remote rewrite when the server already holds exactly this state —
    // e.g. the mount-time echo of an account that's already saved. The cache
    // lives OUTSIDE the hook so it survives remounts: without it every page load
    // (and every tab switch back) rewrote the whole trade ledger, which is how a
    // navigation that landed mid-write could wipe the history.
    const signature = u.id + ':' + robot + ':' + JSON.stringify({ b: account.balance, r: account.risk, p: account.positions, t: account.trades })
    const key = signatureKey(u.id, robot)
    if (remoteSignatures.get(key) === signature) return
    const id = setTimeout(() => {
      void saveRemote(u, account, robot).then((ok) => {
        // Only trust the cache once the server accepted the write — otherwise a
        // failed save would look "done" and never be retried.
        if (ok) remoteSignatures.set(key, signature)
        else remoteSignatures.delete(key)
      })
    }, 400)
    return () => clearTimeout(id)
  }, [account, loading, robot])

  const commit = useCallback((next: AccountState) => setAccount(next), [])

  // Pick the connection matching the active mode (oanda ↔ oandaConn, mt ↔
  // mtConn). Passing the id lets a user with several brokers trade the exact
  // account shown in the UI instead of always the default robot slot.
  const brokerConnectionId = mode === 'oanda' ? connectionIds?.oanda : mode === 'mt' ? connectionIds?.mt : undefined
  const broker = useMemo<BrokerAdapter>(
    () =>
      createBroker(mode, {
        getState: () => stateRef.current ?? createAccount(DEFAULT_PAPER_BALANCE),
        commit,
      }, brokerConnectionId),
    [mode, commit, brokerConnectionId],
  )

  // In live mode, pull the authoritative account from the broker as soon as the
  // broker adapter exists (before the first quote tick arrives). Only do this
  // when signed in — the broker bridges require a user session JWT and would
  // otherwise 401 for anonymous visitors (persisted live mode).
  useEffect(() => {
    if (mode === 'paper') return
    if (!userRef.current) return
    void broker.refresh()
  }, [mode, broker])

  const open = useCallback(
    (req: OpenPositionRequest, rates: RatesMap) => broker.openPosition(req, rates),
    [broker],
  )
  const close = useCallback(
    (id: string, reason: CloseReason, price: number, rates: RatesMap) =>
      broker.closePosition(id, reason, price, rates),
    [broker],
  )
  const sync = useCallback((rates: RatesMap) => broker.markToMarket(rates), [broker])
  const refresh = useCallback(() => broker.refresh(), [broker])
  /** Submit one multi-pair robot cycle (caps + per-pair error isolation). */
  const runCycle = useCallback(
    (inputs: RobotCycleInput[], config: RobotConfig) => broker.runCycle(inputs, config),
    [broker],
  )

  /**
   * Act on a strategy signal. In paper mode this runs the pure engine reducer.
   * In live (OANDA) mode it validates against the same risk rules, then routes
   * the actual order through the broker so real money moves on the user's
   * account. The authoritative mirror state is refreshed from the broker after
   * every execution.
   */
  const runSignal = useCallback(
    async (input: ApplySignalInput): Promise<{ events: string[] }> => {
      const cur = stateRef.current
      if (!cur) return { events: ['No account yet — create one first.'] }

      if (broker.mode !== 'paper') {
        const { symbol, signal, price, rates, strategy, stopPips, takeProfitPips, units } = input
        if (signal === 'neutral') return { events: [] }
        const events: string[] = []
        const side: Side = signal === 'buy' ? 'long' : 'short'
        const pos = cur.positions.find((p) => p.symbol === symbol)

        if (pos) {
          if (pos.side === side) return { events: [] } // already on the right side
          const { error } = await broker.closePosition(pos.id, 'signal', price, rates)
          if (error) return { events: [`${symbol}: couldn't flip — ${error}`] }
          events.push(`Closed ${symbol} ${pos.side} on reversal (${price.toFixed(5)}).`)
        }

        const gate = canOpen(cur, rates)
        if (!gate.ok) return { events: [gate.reason ?? 'Risk limit.'] }

        const planned = openPosition(
          cur,
          { symbol, side, entryPrice: price, stopPips, takeProfitPips, units, strategy },
          rates,
        )
        if (planned.error) return { events: [`${symbol}: ${planned.error}`] }

        const { error } = await broker.openPosition(
          { symbol, side, entryPrice: price, stopPips, takeProfitPips, units, strategy },
          rates,
        )
        if (error) return { events: [`${symbol}: live order failed — ${error}`] }
        events.push(`Opened ${symbol} ${side} at ${price.toFixed(5)} (${broker.label}).`)
        return { events }
      }

      const { state, events } = applySignal(cur, input)
      setAccount(state)
      return { events }
    },
    [broker],
  )

  const setRisk = useCallback((patch: Partial<RiskConfig>) => {
    const cur = stateRef.current
    if (!cur) return
    setAccount({ ...cur, risk: { ...cur.risk, ...patch } })
    // Mirror the robot on/off flag so a refresh / tab close restores it in
    // every mode — live broker mirrors are never persisted, so this flag is
    // their only record of whether the robot was running.
    if (typeof patch.autoTrade === 'boolean') {
      saveRobotRunning(patch.autoTrade, stateKey(userRef.current?.id, robot))
    }
  }, [robot])

  /** Emergency stop: disable auto-trading. */
  const stopRobot = useCallback(() => {
    const cur = stateRef.current
    if (!cur) return
    if (!cur.risk.autoTrade) return
    setAccount({ ...cur, risk: { ...cur.risk, autoTrade: false } })
    saveRobotRunning(false, stateKey(userRef.current?.id, robot))
  }, [robot])

  /** Close every open position at the current market price (stop-loss button). */
  const closeAll = useCallback(
    (rates: RatesMap): { closed: number } => {
      const cur = stateRef.current
      if (!cur || cur.positions.length === 0) return { closed: 0 }
      const { state, closed } = closeAllPositions(cur, rates)
      setAccount(state)
      return { closed: closed.length }
    },
    [],
  )

  /** Close every position the robot opened (strategy-tagged, not 'manual') at
   * market, leaving manual trades the user placed untouched. Paper/managed run
   * the pure engine reducer (journal tagged 'robot_stop'); live OANDA/MT place
   * a real close order through the broker for each robot position, throttled,
   * then re-sync the authoritative mirror — a stopped robot never leaves its
   * own trades open on the book, in paper or live. */
  const closeRobotPositions = useCallback(
    async (rates: RatesMap): Promise<{ closed: number; error: string | null }> => {
      const cur = stateRef.current
      if (!cur || cur.positions.length === 0) return { closed: 0, error: null }
      const robotPositions = cur.positions.filter((p) => p.strategy && p.strategy !== 'manual')
      if (robotPositions.length === 0) return { closed: 0, error: null }

      // Ledger-backed modes: pure engine close on the local account state.
      if (broker.mode === 'paper' || broker.mode === 'managed') {
        const { state, closed } = engineCloseRobotPositions(cur, rates)
        if (closed.length > 0) setAccount(state)
        return { closed: closed.length, error: null }
      }

      // Live broker: one real close order per robot position (throttled so
      // broker rate limits are respected), then refresh the mirror so the UI
      // reflects what the broker actually did.
      let closed = 0
      let lastError: string | null = null
      for (const p of robotPositions) {
        const price = rates[p.symbol] ?? p.entryPrice
        const { error } = await broker.closePosition(p.id, 'robot_stop', price, rates)
        if (error) {
          lastError = error
        } else {
          closed += 1
        }
        await new Promise((resolve) => setTimeout(resolve, 350))
      }
      await broker.refresh()
      return { closed, error: lastError }
    },
    [broker],
  )

  /** Close EVERY open position — robot AND manual — at the current market
   * price. Used by the "Stop robot & close all" button so a stopped robot
   * leaves the open-positions panel empty, not just its own trades. Paper and
   * managed run the pure engine reducer (journal tagged 'risk'); live
   * OANDA/MT place a real close order through the broker for each position,
   * throttled, then re-sync the authoritative mirror. */
  const flattenAll = useCallback(
    async (rates: RatesMap): Promise<{ closed: number; error: string | null }> => {
      const cur = stateRef.current
      if (!cur || cur.positions.length === 0) return { closed: 0, error: null }

      // Ledger-backed modes: pure engine close on the local account state.
      if (broker.mode === 'paper' || broker.mode === 'managed') {
        const { state, closed } = closeAllPositions(cur, rates)
        if (closed.length > 0) setAccount(state)
        return { closed: closed.length, error: null }
      }

      // Live broker: one real close order per open position (throttled so
      // broker rate limits are respected), then refresh the mirror so the UI
      // reflects what the broker actually did.
      let closed = 0
      let lastError: string | null = null
      for (const p of cur.positions) {
        const price = rates[p.symbol] ?? p.entryPrice
        const { error } = await broker.closePosition(p.id, 'robot_stop', price, rates)
        if (error) {
          lastError = error
        } else {
          closed += 1
        }
        await new Promise((resolve) => setTimeout(resolve, 350))
      }
      await broker.refresh()
      return { closed, error: lastError }
    },
    [broker],
  )

  const reset = useCallback(
    (initialBalance: number) => {
      clearLocal(robot)
      setAccount(createAccount(initialBalance))
      // A fresh account starts with the robot off — forget any saved running
      // flag so a reload doesn't bring it back on.
      clearRobotRunning(stateKey(userRef.current?.id, robot))
      // Wipe the Supabase mirror too, otherwise a signed-in user's reload loads
      // the old account + trades back from the server (see resetRemote).
      const u = userRef.current
      if (u) {
        // Forget the cached signature so the fresh account is written up.
        remoteSignatures.delete(signatureKey(u.id, robot))
        void resetRemote(u, initialBalance, robot)
      }
    },
    [robot],
  )

  /**
   * Switch the paper account between Standard, Micro, Minimal and Custom. A
   * micro account is a smaller, realistic demo account; the minimal flavour is
   * the smallest viable starting balance; the custom flavour takes the user's
   * own deposit amount (clamped to MIN_PAPER_DEPOSIT). Switching starts a fresh
   * paper account with that balance (local ledger + Supabase mirror reset) so
   * position sizes stay honest, like opening a real micro account.
   */
  const setAccountKind = useCallback((kind: PaperAccountKind, customBalance?: number) => {
    clearLocal(robot)
    const balance =
      kind === 'custom'
        ? Math.max(MIN_PAPER_DEPOSIT, Math.round(customBalance ?? MIN_PAPER_DEPOSIT))
        : startingBalanceForKind(kind)
    const fresh = createAccount(balance)
    setAccount({ ...fresh, risk: { ...fresh.risk, kind } })
    clearRobotRunning(stateKey(userRef.current?.id, robot))
    const u = userRef.current
    if (u) {
      // Forget the cached signature so the fresh account is written up.
      remoteSignatures.delete(signatureKey(u.id, robot))
      void resetRemote(u, balance, robot)
    }
  }, [robot])

  const setBrokerMode = useCallback((m: BrokerMode) => {
    setMode(m)
    try {
      localStorage.setItem(modeKeyForRobot(robot), m)
    } catch {
      /* noop */
    }
    // Keep the account's `broker` label in sync for the ledger-backed modes
    // (paper and managed live). OANDA / MT are overwritten by the live mirror
    // when it next refreshes from the broker.
    if (m === 'paper' || m === 'managed') {
      setAccount((cur) => (cur ? { ...cur, broker: m } : cur))
    }
  }, [robot])

  return {
    account,
    loading,
    mode,
    setBrokerMode,
    broker,
    open,
    close,
    sync,
    refresh,
    runCycle,
    runSignal,
    setRisk,
    stopRobot,
    closeAll,
    closeRobotPositions,
    flattenAll,
    reset,
    /** Switch the paper account to Standard or Micro (resets the demo balance). */
    setAccountKind,
  }
}