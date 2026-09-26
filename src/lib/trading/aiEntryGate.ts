/**
 * Deep Analyst entry gate — the robot's strict AI veto.
 *
 * When `account.risk.deepAnalystGate` is on, every robot entry is vetted by
 * the `deep-analyst` Edge Function (entry mode) BEFORE the engine opens it:
 *   - verdict 'enter'  → the trade opens normally.
 *   - verdict 'skip'   → the trade stands aside (the AI veto).
 *   - any failure / unavailable analysis / non-enter verdict → the trade
 *     stands aside too (STRICT mode: fail-closed, never fail-open).
 *
 * The strict "no opens until signed in" rule is enforced by the caller: the
 * robot loop refuses to open ANY trade when the gate is on and the trader is
 * signed out (the function would only return the deterministic engine, and
 * the user explicitly chose a strict gate).
 *
 * Verdicts are cached per symbol+side for a few minutes so an idle robot
 * doesn't re-bill the LLM on every tick — a vetoed pair is re-vetted only
 * after the cooldown, and an approved pair is re-vetted once the market moves
 * far enough to warrant it.
 */
import { supabase } from '../supabase'
import type { DeepAnalystEntryContext } from '../deepAnalyst'
import type { AccountState, RobotCycleInput, Side } from './types'
import { equity } from './engine'

export const ENTRY_GATE_CACHE_TTL_MS = 4 * 60_000

export interface EntryGateVerdict {
  allowed: boolean
  reason: string
  verdict?: string
  engine?: string
}

/** Pure verdict rule: only an explicit 'enter' clears the gate (strict). */
export function verdictAllows(verdict: string | undefined): boolean {
  return verdict === 'enter'
}

const cache = new Map<string, { side: Side; verdict: 'enter' | 'skip'; at: number }>()

export function entryCacheKey(symbol: string, side: Side): string {
  return `${symbol}:${side}`
}

export function cachedEntryVerdict(symbol: string, side: Side): { verdict: 'enter' | 'skip'; at: number } | null {
  const hit = cache.get(entryCacheKey(symbol, side))
  if (!hit || hit.side !== side || Date.now() - hit.at > ENTRY_GATE_CACHE_TTL_MS) return null
  return { verdict: hit.verdict, at: hit.at }
}

export function rememberEntryVerdict(symbol: string, side: Side, verdict: 'enter' | 'skip'): void {
  cache.set(entryCacheKey(symbol, side), { side, verdict, at: Date.now() })
}

/** Clear the gate cache (used by tests and when risk settings change). */
export function clearEntryGateCache(): void {
  cache.clear()
}

/** Build the `deep-analyst` entry-mode request body for a planned robot entry. */
export function buildEntryGateBody(input: RobotCycleInput, account: AccountState): DeepAnalystEntryContext {
  const side: Side = input.signal === 'buy' ? 'long' : 'short'
  const accountCtx: DeepAnalystEntryContext['account'] = {
    mode: account.broker,
    balance: account.balance,
    equity: equity(account, input.rates),
    riskPerTradePct: account.risk.riskPerTradePct,
    trailingStop: account.risk.trailingStop,
    trailPips: account.risk.trailPips,
    breakEvenPips: account.risk.breakEvenPips,
    profitPullbackPct: account.risk.profitPullbackPct,
    partialTakeProfit: account.risk.partialTakeProfit,
    partialClosePct: account.risk.partialClosePct,
    partialTpRatio: account.risk.partialTpRatio,
  }
  return {
    entry: {
      symbol: input.symbol,
      side,
      price: input.price,
      stopPips: input.stopPips,
      takeProfitPips: input.takeProfitPips,
      units: input.units,
      strategy: input.strategy,
      score: input.score,
      momentum: input.momentum,
      rsi: input.rsi,
      trend: input.trend,
      volatilityPct: input.volatilityPct,
    },
    market: {
      mark: input.price,
      atrPct: input.volatilityPct ?? null,
      trendPct: input.trend != null ? input.trend * 100 : null,
    },
    account: accountCtx,
  }
}

/**
 * Vet one planned robot entry through the Deep Analyst (entry mode).
 * STRICT: any failure, unavailable analysis, or non-'enter' verdict blocks the
 * trade. The result is cached per symbol+side for the cooldown window.
 */
export async function gateRobotEntry(
  input: RobotCycleInput,
  account: AccountState,
): Promise<EntryGateVerdict> {
  const side: Side = input.signal === 'buy' ? 'long' : 'short'

  const hit = cachedEntryVerdict(input.symbol, side)
  if (hit) {
    return hit.verdict === 'enter'
      ? { allowed: true, reason: `AI entry gate: approved (${Math.round((Date.now() - hit.at) / 1000)}s ago).`, verdict: 'enter' }
      : { allowed: false, reason: 'AI entry gate: vetoed (recent analysis).', verdict: 'skip' }
  }

  try {
    const { data, error } = await supabase.functions.invoke('deep-analyst', {
      body: buildEntryGateBody(input, account),
    })
    if (error || !data || data.ok !== true) {
      rememberEntryVerdict(input.symbol, side, 'skip')
      return { allowed: false, reason: 'AI entry gate: analysis unavailable — strict gate stands aside.' }
    }
    const res = data as {
      ok: boolean
      engine?: string
      ai_requires_login?: boolean
      note?: string
      strategy?: { verdict?: string; action?: string }
    }
    if (res.ai_requires_login === true) {
      rememberEntryVerdict(input.symbol, side, 'skip')
      return { allowed: false, reason: 'AI entry gate: sign in to unlock robot trading (strict gate).' }
    }
    const verdict = res.strategy?.verdict
    if (verdictAllows(verdict)) {
      rememberEntryVerdict(input.symbol, side, 'enter')
      return {
        allowed: true,
        reason: res.strategy?.action || 'AI entry gate: approved.',
        verdict,
        engine: res.engine,
      }
    }
    rememberEntryVerdict(input.symbol, side, 'skip')
    return {
      allowed: false,
      reason: res.strategy?.action || `AI entry gate: '${verdict ?? 'unknown'}' — standing aside.`,
      verdict,
      engine: res.engine,
    }
  } catch {
    rememberEntryVerdict(input.symbol, side, 'skip')
    return { allowed: false, reason: 'AI entry gate: analysis unavailable — strict gate stands aside.' }
  }
}
