/**
 * Paper-account persistence.
 *
 * Signed-in users get their account backed up to Supabase (owner-scoped RLS);
 * anonymous visitors fall back to localStorage. Live OANDA / MetaTrader mirrors
 * are never persisted here — their authoritative state always comes from the
 * broker bridge (see usePaperAccount).
 */
import type { User } from '@supabase/supabase-js'
import { supabase } from '../supabase'
import { createAccount } from './engine'
import { DEFAULT_RISK } from './types'
import type { AccountState, ClosedTrade, Position, RiskConfig } from './types'

const LOCAL_KEY = 'fx-toolkit.paper-account'

/** localStorage key for a robot slot's ledger: slot 1 keeps the legacy key so
 *  existing users keep their saved paper account; slots 2..N get a namespaced
 *  key so every robot runs on its own balance. */
export function localKeyForSlot(slot: number): string {
  return slot > 1 ? `${LOCAL_KEY}.slot-${slot}` : LOCAL_KEY
}

/* --------------------------------- local --------------------------------- */

export function loadLocal(slot = 1): AccountState | null {
  try {
    const raw = localStorage.getItem(localKeyForSlot(slot))
    if (!raw) return null
    const parsed = JSON.parse(raw) as AccountState
    if (!parsed || typeof parsed.balance !== 'number' || !Array.isArray(parsed.positions)) return null
    return { ...parsed, risk: { ...DEFAULT_RISK, ...(parsed.risk ?? {}) } }
  } catch {
    return null
  }
}

export function saveLocal(account: AccountState, slot = 1): void {
  try {
    localStorage.setItem(localKeyForSlot(slot), JSON.stringify(account))
  } catch {
    /* storage full / blocked — non-fatal */
  }
}

export function clearLocal(slot = 1): void {
  try {
    localStorage.removeItem(localKeyForSlot(slot))
  } catch {
    /* noop */
  }
}

/* --------------------------------- remote -------------------------------- */

interface PaperAccountRow {
  id: string
  user_id: string
  /** Robot slot this ledger belongs to (1 = first/default robot). */
  robot_number: number
  broker: string
  currency: string
  initial_balance: number
  balance: number
  risk: RiskConfig | null
  created_at: string | null
  updated_at: string | null
}

interface PaperTradeRow {
  id: string
  user_id: string
  /** Robot slot this trade belongs to (mirrors the owning account row). */
  robot_number: number
  symbol: string
  side: 'long' | 'short'
  status: 'open' | 'closed'
  quantity: number
  entry_price: number
  entry_time: string
  exit_price: number | null
  exit_time: string | null
  stop_loss: number | null
  take_profit: number | null
  pnl: number | null
  pnl_pct: number | null
  entry_equity: number | null
  close_reason: string | null
  strategy: string | null
  target_profit_usd: number | null
  target_loss_usd: number | null
  /** Best unrealized PnL (USD) the position reached — profit-pullback lock. */
  peak_profit_usd: number | null
  /** Scale-out first-target price (open-time stamp) — partial take-profit. */
  tp1_price: number | null
  /** Whether the position already banked its partial take-profit. */
  partial_taken: boolean | null
  created_at: string | null
}

function toRow(account: AccountState, userId: string, robotNumber = 1): {
  account: Omit<PaperAccountRow, 'id' | 'created_at' | 'updated_at'>
  trades: PaperTradeRow[]
} {
  const trades: PaperTradeRow[] = [
    ...account.positions.map<PaperTradeRow>((p) => ({
      id: p.id,
      user_id: userId,
      robot_number: robotNumber,
      symbol: p.symbol,
      side: p.side,
      status: 'open',
      quantity: p.units,
      entry_price: p.entryPrice,
      entry_time: p.entryTime,
      exit_price: null,
      exit_time: null,
      stop_loss: p.stopPrice,
      take_profit: p.takeProfitPrice,
      pnl: null,
      pnl_pct: null,
      entry_equity: p.entryEquity,
      close_reason: null,
      strategy: p.strategy ?? null,
      target_profit_usd: p.targetProfitUsd ?? null,
      target_loss_usd: p.targetLossUsd ?? null,
      peak_profit_usd: p.peakProfitUsd ?? null,
      tp1_price: p.tp1Price ?? null,
      partial_taken: p.partialTaken ?? false,
      created_at: null,
    })),
    ...account.trades.map<PaperTradeRow>((t) => ({
      id: t.id,
      user_id: userId,
      robot_number: robotNumber,
      symbol: t.symbol,
      side: t.side,
      status: 'closed',
      quantity: t.units,
      entry_price: t.entryPrice,
      entry_time: t.entryTime,
      exit_price: t.exitPrice,
      exit_time: t.exitTime,
      stop_loss: t.stopPrice,
      take_profit: t.takeProfitPrice,
      pnl: t.pnl,
      pnl_pct: t.pnlPct,
      entry_equity: t.entryEquity,
      close_reason: t.closeReason,
      strategy: t.strategy ?? null,
      target_profit_usd: null,
      target_loss_usd: null,
      peak_profit_usd: null,
      tp1_price: null,
      partial_taken: null,
      created_at: null,
    })),
  ]
  return {
    account: {
      user_id: userId,
      robot_number: robotNumber,
      broker: account.broker,
      currency: account.currency,
      initial_balance: account.initialBalance,
      balance: account.balance,
      risk: account.risk,
    },
    trades,
  }
}

function fromRows(row: PaperAccountRow, trades: PaperTradeRow[]): AccountState {
  const positions: Position[] = []
  const closed: ClosedTrade[] = []
  for (const t of trades) {
    if (t.status === 'open') {
      positions.push({
        id: t.id,
        symbol: t.symbol,
        side: t.side,
        units: t.quantity,
        entryPrice: t.entry_price,
        entryTime: t.entry_time,
        stopPrice: t.stop_loss ?? 0,
        takeProfitPrice: t.take_profit ?? 0,
        entryEquity: t.entry_equity ?? Number(row.balance ?? 0),
        strategy: t.strategy ?? undefined,
        targetProfitUsd: t.target_profit_usd ?? undefined,
        targetLossUsd: t.target_loss_usd ?? undefined,
        peakProfitUsd: t.peak_profit_usd ?? undefined,
        tp1Price: t.tp1_price ?? undefined,
        partialTaken: t.partial_taken === true,
        status: 'open',
      })
    } else {
      closed.push({
        id: t.id,
        symbol: t.symbol,
        side: t.side,
        units: t.quantity,
        entryPrice: t.entry_price,
        entryTime: t.entry_time,
        exitPrice: t.exit_price ?? t.entry_price,
        exitTime: t.exit_time ?? t.entry_time,
        stopPrice: t.stop_loss ?? 0,
        takeProfitPrice: t.take_profit ?? 0,
        entryEquity: t.entry_equity ?? Number(row.balance ?? 0),
        pnl: t.pnl ?? 0,
        pnlPct: t.pnl_pct ?? 0,
        closeReason: (t.close_reason as ClosedTrade['closeReason']) ?? 'manual',
        strategy: t.strategy ?? undefined,
        status: 'closed',
      })
    }
  }
  return {
    id: row.id,
    broker: (row.broker as AccountState['broker']) ?? 'paper',
    currency: (row.currency as AccountState['currency']) ?? 'USD',
    initialBalance: Number(row.initial_balance ?? 0),
    balance: Number(row.balance ?? 0),
    risk: { ...DEFAULT_RISK, ...(row.risk ?? {}) },
    positions,
    trades: closed,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** Load a robot slot's account from Supabase (null when none exists yet). */
export async function loadRemote(user: User, robotNumber = 1): Promise<AccountState | null> {
  try {
    // Fetch the account row and its trade ledger in parallel — the trades query
    // previously waited on the account query, adding ~150-250ms of latency to
    // every Trading page mount.
    const [acctRes, tradesRes] = await Promise.all([
      supabase
        .from('paper_accounts')
        .select('*')
        .eq('user_id', user.id)
        .eq('robot_number', robotNumber)
        .maybeSingle(),
      supabase
        .from('paper_trades')
        .select('*')
        .eq('user_id', user.id)
        .eq('robot_number', robotNumber)
        .order('created_at', { ascending: true }),
    ])
    const acct = acctRes.data
    if (!acct) return null
    return fromRows(acct as unknown as PaperAccountRow, (tradesRes.data as unknown as PaperTradeRow[]) ?? [])
  } catch {
    return null
  }
}

/** Replace a robot slot's account (and all its trades) in Supabase. */
export async function saveRemote(user: User, account: AccountState, robotNumber = 1): Promise<void> {
  try {
    const { account: accRow, trades } = toRow(account, user.id, robotNumber)
    await supabase.from('paper_accounts').upsert(accRow, { onConflict: 'user_id,robot_number' })
    await supabase.from('paper_trades').delete().eq('user_id', user.id).eq('robot_number', robotNumber)
    if (trades.length > 0) {
      await supabase.from('paper_trades').insert(trades)
    }
  } catch {
    /* best-effort — local copy still exists */
  }
}

/** Wipe a robot slot's Supabase mirror and seed a fresh account. */
export async function resetRemote(user: User, initialBalance: number, robotNumber = 1): Promise<void> {
  try {
    await supabase.from('paper_trades').delete().eq('user_id', user.id).eq('robot_number', robotNumber)
    await supabase.from('paper_accounts').delete().eq('user_id', user.id).eq('robot_number', robotNumber)
    const fresh = createAccount(initialBalance)
    await supabase.from('paper_accounts').insert({
      user_id: user.id,
      robot_number: robotNumber,
      broker: fresh.broker,
      currency: fresh.currency,
      initial_balance: fresh.initialBalance,
      balance: fresh.balance,
      risk: fresh.risk,
    })
  } catch {
    /* best-effort */
  }
}