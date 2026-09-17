/**
 * Pure trading-engine reducer. Given an account state and an input it returns a
 * new state — no I/O, no side effects — so the paper robot and any future
 * broker share exactly the same, testable rules.
 */
import type {
  AccountState,
  ApplySignalInput,
  ClosedTrade,
  CloseReason,
  OpenPositionRequest,
  RatesMap,
  RobotConfig,
  RobotCycleInput,
  Side,
} from './types'
import { DEFAULT_RISK, PROFIT_PROBABILITY_THRESHOLD } from './types'
import { consecutiveLosses, perTradeTargetUsd, pnlUsd, pipSize, stopTakePrices } from './risk'

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** Ingredients describing how strong a setup is — the robot uses these to
 * estimate the probability of profit before opening a trade. */
export interface ProbabilityIngredients {
  /** 0–100 setup score from pair ranking / best-strategy (signal strength). */
  score?: number
  /** 0–1 momentum of the latest bar vs the recent range (direction-free). */
  momentum?: number
  /** 0–100 RSI — used for reversion conviction (room to mean-revert). */
  rsi?: number
  /** -1 against trend, 0 flat, +1 with trend (SMA-20 alignment). */
  trend?: number
  /** Recent volatility (ATR14 as a % of price). */
  volatilityPct?: number
  /** Stop-loss distance in pips (part of the risk:reward geometry). */
  stopPips?: number
  /** Take-profit distance in pips (part of the risk:reward geometry). */
  takeProfitPips?: number
}

/**
 * Estimate the probability of profit (0–1) for a setup from its signal
 * strength and risk:reward geometry. Centered at 0.5 (a coin flip); strong
 * momentum, trend alignment, reversion room and a favourable reward window
 * push it up, wild volatility pulls it down. Returns null when no ingredients
 * are given — the caller then falls back to the old behaviour (no gate).
 */
export function estimateProfitProbability(i: ProbabilityIngredients): number | null {
  const hasData =
    i.score != null || i.momentum != null || i.rsi != null || i.trend != null ||
    i.volatilityPct != null || i.stopPips != null || i.takeProfitPips != null
  if (!hasData) return null

  let p = 0.5

  // Score: the pair-ranking / best-strategy estimate (5–99) already encodes
  // how strong the setup is — map it onto the [0.5 ± 0.45] band.
  if (i.score != null) p += ((clamp(i.score, 5, 99) - 50) / 50) * 0.45

  // Trend alignment: trading WITH the trend adds conviction; fading it drains.
  if (i.trend != null) p += clamp(i.trend, -1, 1) * 0.06

  // Momentum: a big move on the latest bar confirms the signal.
  if (i.momentum != null) p += clamp(i.momentum - 0.5, -0.5, 0.5) * 0.1

  // RSI reversion room: deep oversold/overbought leaves more room to run —
  // which side is implied by the pair rather than the value itself, so use
  // the absolute distance from neutral.
  if (i.rsi != null) p += clamp(0.5 - Math.abs(i.rsi - 50) / 100, -0.5, 0.5) * 0.1

  // Volatility penalty: whipsaw-prone markets shrink the edge, however strong.
  if (i.volatilityPct != null) {
    const vol = Math.max(0, i.volatilityPct)
    if (vol > 2) p -= Math.min(0.08, (vol - 2) * 0.01)
    else if (vol < 1) p += Math.min(0.04, (1 - vol) * 0.02) // calm markets help
  }

  // Risk:reward geometry — a wider target than the stop makes reaching profit
  // harder in price terms but pays more when hit; weight it lightly.
  if (i.stopPips != null && i.takeProfitPips != null && i.stopPips > 0 && i.takeProfitPips > 0) {
    p += ((i.takeProfitPips - i.stopPips) / (i.takeProfitPips + i.stopPips)) * 0.04
  }

  return clamp(p, 0.05, 0.95)
}

/** Probability of profit (0–1) driving a robot entry — explicit override wins,
 * otherwise the engine estimates it from the setup's signal strength. */
export function entryProfitProbability(input: ApplySignalInput): number | null {
  if (input.profitProbability != null) return clamp(input.profitProbability, 0, 1)
  return estimateProfitProbability({
    score: input.score,
    momentum: input.momentum,
    rsi: input.rsi,
    trend: input.trend,
    volatilityPct: input.volatilityPct,
    stopPips: input.stopPips,
    takeProfitPips: input.takeProfitPips,
  })
}

/** The 50%+ profit-probability gate — the robot only opens when it expects to
 *  win more than half the time. */
export function probabilityGate(
  input: ApplySignalInput,
): { ok: boolean; probability?: number; reason?: string } {
  const prob = entryProfitProbability(input)
  if (prob == null) return { ok: true } // no strength data — legacy behaviour
  if (prob <= PROFIT_PROBABILITY_THRESHOLD) {
    return {
      ok: false,
      probability: prob,
      reason: `${Math.round(prob * 100)}% chance of profit — below the ${Math.round(PROFIT_PROBABILITY_THRESHOLD * 100)}% entry bar. Standing aside.`,
    }
  }
  return { ok: true, probability: prob }
}

export function createAccount(initialBalance: number, id: string | null = null): AccountState {
  return {
    id,
    broker: 'paper',
    currency: 'USD',
    initialBalance,
    balance: initialBalance,
    risk: { ...DEFAULT_RISK },
    positions: [],
    trades: [],
    createdAt: null,
    updatedAt: null,
  }
}

/** Total equity = balance + unrealized PnL on open positions. */
export function equity(state: AccountState, rates: RatesMap): number {
  return state.balance + unrealizedPnl(state, rates)
}

export function unrealizedPnl(state: AccountState, rates: RatesMap): number {
  let total = 0
  for (const p of state.positions) {
    const cur = rates[p.symbol]
    if (cur != null) total += pnlUsd(p.side, p.entryPrice, cur, p.units, p.symbol, rates)
  }
  return total
}

export function openPosition(
  state: AccountState,
  input: OpenPositionRequest,
  rates: RatesMap,
  opts: { maxPerPair?: number } = {},
): { state: AccountState; error: string | null } {
  const risk = state.risk
  const maxPerPair = opts.maxPerPair ?? 1
  if (!input.entryPrice || input.entryPrice <= 0) return { state, error: 'No valid price to open at.' }
  if (input.units <= 0) return { state, error: 'Position size is too small to trade.' }
  if (input.stopPips <= 0) return { state, error: 'A stop loss is required on every position.' }
  // Per-pair cap: sequential defaults to 1 open per pair; concurrent allows N.
  const onSymbol = state.positions.filter((p) => p.symbol === input.symbol).length
  if (onSymbol >= maxPerPair) {
    return {
      state,
      error:
        maxPerPair === 1
          ? `A ${input.symbol} position is already open.`
          : `Max ${maxPerPair} ${input.symbol} positions already open.`,
    }
  }
  if (state.positions.length >= risk.maxOpenPositions) {
    return { state, error: `Max ${risk.maxOpenPositions} open positions reached.` }
  }
  const gate = canOpen(state, rates)
  if (!gate.ok) return { state, error: gate.reason ?? 'Risk limits block this trade.' }

  const now = input.time ?? new Date().toISOString()
  const { stopPrice, takeProfitPrice } = stopTakePrices(
    input.symbol,
    input.side,
    input.entryPrice,
    input.stopPips,
    Math.max(0, input.takeProfitPips),
  )

  const position = {
    id: crypto.randomUUID(),
    symbol: input.symbol,
    side: input.side,
    units: input.units,
    entryPrice: input.entryPrice,
    entryTime: now,
    stopPrice,
    takeProfitPrice,
    entryEquity: equity(state, rates),
    strategy: input.strategy,
    targetProfitUsd: input.targetProfitUsd ?? undefined,
    targetLossUsd: input.targetLossUsd ?? undefined,
    entryProbability: input.profitProbability,
    status: 'open' as const,
  }

  return { state: { ...state, positions: [...state.positions, position], updatedAt: now }, error: null }
}

export function closePosition(
  state: AccountState,
  positionId: string,
  opts: { price: number; reason: CloseReason; rates: RatesMap; time?: string },
): { state: AccountState; trade: ClosedTrade | null } {
  const pos = state.positions.find((p) => p.id === positionId)
  if (!pos) return { state, trade: null }
  const now = opts.time ?? new Date().toISOString()
  const pnl = pnlUsd(pos.side, pos.entryPrice, opts.price, pos.units, pos.symbol, opts.rates)
  const pnlPct = pos.entryEquity > 0 ? (pnl / pos.entryEquity) * 100 : 0
  const trade: ClosedTrade = {
    id: pos.id,
    symbol: pos.symbol,
    side: pos.side,
    units: pos.units,
    entryPrice: pos.entryPrice,
    entryTime: pos.entryTime,
    exitPrice: opts.price,
    exitTime: now,
    stopPrice: pos.stopPrice,
    takeProfitPrice: pos.takeProfitPrice,
    entryEquity: pos.entryEquity,
    pnl,
    pnlPct,
    closeReason: opts.reason,
    strategy: pos.strategy,
    entryProbability: pos.entryProbability,
    status: 'closed',
  }
  return {
    state: {
      ...state,
      balance: state.balance + pnl,
      positions: state.positions.filter((p) => p.id !== positionId),
      trades: [trade, ...state.trades],
      updatedAt: now,
    },
    trade,
  }
}

/** Check SL/TP against the latest rates and close anything that was hit. */
export function markToMarket(
  state: AccountState,
  rates: RatesMap,
): { state: AccountState; closed: ClosedTrade[] } {
  let next = state
  const closed: ClosedTrade[] = []
  // Ratchet trailing stops first so a profit-protecting stop can trigger below.
  if (state.risk.trailingStop && state.risk.trailPips > 0) {
    next = trailStops(next, rates)
  }
  for (const p of next.positions) {
    const cur = rates[p.symbol]
    if (cur == null) continue
    let reason: CloseReason | null = null
    // A stop hit always wins — nothing is allowed to hold a dying trade.
    if (p.side === 'long' && cur <= p.stopPrice) reason = 'stop_loss'
    else if (p.side === 'short' && cur >= p.stopPrice) reason = 'stop_loss'

    // Per-trade targets, checked before the price take-profit so a $ or pip
    // rule can fire on a smaller favourable move: the position's own stamp wins
    // (manual form), otherwise the robot's per-trade knobs (honouring its
    // pips/USD denomination, 0 = off). The loss cap is enforced like a stop —
    // a trade bleeding money is cut at -$limit.
    if (!reason) {
      const pnl = pnlUsd(p.side, p.entryPrice, cur, p.units, p.symbol, rates)
      const { targetProfitUsd, targetLossUsd } = perTradeTargetUsd(state.risk, p.symbol, p.units, rates)
      const profitTarget = p.targetProfitUsd ?? targetProfitUsd
      const lossTarget = p.targetLossUsd ?? targetLossUsd
      if (lossTarget > 0 && pnl <= -lossTarget) reason = 'stop_loss'
      else if (profitTarget > 0 && pnl >= profitTarget) reason = 'target'
    }

    if (!reason) {
      if (p.side === 'long' && cur >= p.takeProfitPrice) reason = 'take_profit'
      else if (p.side === 'short' && cur <= p.takeProfitPrice) reason = 'take_profit'
    }
    if (reason) {
      const res = closePosition(next, p.id, { price: cur, reason, rates })
      if (res.trade) closed.push(res.trade)
      next = res.state
    }
  }
  return { state: next, closed }
}

/** Move trailing stops toward the best price so profits are locked in. */
function trailStops(state: AccountState, rates: RatesMap): AccountState {
  let positions = state.positions
  for (const p of positions) {
    const cur = rates[p.symbol]
    if (cur == null) continue
    const pipSizeValue = pipSize(p.symbol)
    // Distance the market has already moved in our favour, in pips.
    const profitPips =
      (p.side === 'long' ? cur - p.entryPrice : p.entryPrice - cur) / pipSizeValue

    // Break-even protection: once the trade is in profit by `breakEvenPips`,
    // lift the stop to the entry price so a winner can't turn back into a
    // loser. Only ever tightens, never loosens.
    if (profitPips >= state.risk.breakEvenPips) {
      if (p.side === 'long' && p.stopPrice < p.entryPrice) {
        positions = positions.map((x) => (x.id === p.id ? { ...x, stopPrice: p.entryPrice } : x))
      } else if (p.side === 'short' && p.stopPrice > p.entryPrice) {
        positions = positions.map((x) => (x.id === p.id ? { ...x, stopPrice: p.entryPrice } : x))
      }
    }

    // Trailing stop: only start ratcheting once the trade is meaningfully in
    // profit (`trailActivationPips`). This stops the stop from being dragged
    // up on noise at entry and lets winners run further before locking in.
    if (profitPips >= state.risk.trailActivationPips) {
      const trail = state.risk.trailPips * pipSizeValue
      const newStop = p.side === 'long' ? cur - trail : cur + trail
      const currentStop =
        positions.find((x) => x.id === p.id)?.stopPrice ?? p.stopPrice
      const improved =
        p.side === 'long' ? newStop > currentStop : newStop < currentStop
      if (improved) {
        positions = positions.map((x) =>
          x.id === p.id ? { ...x, stopPrice: newStop } : x,
        )
      }
    }
  }
  return positions === state.positions ? state : { ...state, positions }
}

/** Close every open position at the current market price (emergency stop). */
export function closeAllPositions(
  state: AccountState,
  rates: RatesMap,
): { state: AccountState; closed: ClosedTrade[] } {
  let next = state
  const closed: ClosedTrade[] = []
  for (const p of state.positions) {
    const cur = rates[p.symbol] ?? p.entryPrice
    const res = closePosition(next, p.id, { price: cur, reason: 'risk', rates })
    if (res.trade) closed.push(res.trade)
    next = res.state
  }
  return { state: next, closed }
}

/** Close only the positions the robot opened (strategy-tagged), leaving manual
 * positions untouched. Used when the robot stops — a stopped robot never leaves
 * open trades it started, but manual trades the user placed stay on the book.
 * Manual trades are tagged with strategy 'manual', so they are always excluded. */
export function closeRobotPositions(
  state: AccountState,
  rates: RatesMap,
): { state: AccountState; closed: ClosedTrade[] } {
  let next = state
  const closed: ClosedTrade[] = []
  for (const p of state.positions) {
    if (!p.strategy || p.strategy === 'manual') continue
    const cur = rates[p.symbol] ?? p.entryPrice
    const res = closePosition(next, p.id, { price: cur, reason: 'robot_stop', rates })
    if (res.trade) closed.push(res.trade)
    next = res.state
  }
  return { state: next, closed }
}

/** Realized (today) + unrealized PnL — used by the daily loss limit. */
export function todayPnlUsd(state: AccountState, rates: RatesMap): number {
  const startOfDay = new Date()
  startOfDay.setHours(0, 0, 0, 0)
  const startMs = startOfDay.getTime()
  let total = 0
  for (const t of state.trades) {
    if (new Date(t.exitTime).getTime() >= startMs) total += t.pnl
  }
  return total + unrealizedPnl(state, rates)
}

/** Safety gate: block new entries when the daily loss limit is reached. */
export function canOpen(state: AccountState, rates: RatesMap): { ok: boolean; reason?: string } {
  // Consecutive-loss circuit breaker: after N losses in a row the robot stands
  // down until the streak is broken (a win) or the limit is raised. Off by
  // default (maxConsecutiveLosses = 0); presets turn it on.
  const maxLosses = state.risk.maxConsecutiveLosses
  if (maxLosses > 0) {
    const streak = consecutiveLosses(state.trades)
    if (streak >= maxLosses) {
      return {
        ok: false,
        reason: `${streak} losses in a row — the robot is standing down. Raise the consecutive-loss limit or let a win reset the streak.`,
      }
    }
  }
  const limitPct = state.risk.maxDailyLossPct
  if (limitPct > 0) {
    const limitUsd = (state.initialBalance * limitPct) / 100
    if (todayPnlUsd(state, rates) <= -limitUsd) {
      return {
        ok: false,
        reason: `Daily loss limit (${limitPct}%) reached — the robot is standing down until tomorrow.`,
      }
    }
  }
  return { ok: true }
}

/**
 * Act on a strategy signal: open when a new buy/sell appears, flip on a
 * reversal, and hold through neutral stretches (exits are handled by SL/TP and
 * reversals). This is the "enhancement robot" behaviour.
 */
export function applySignal(
  state: AccountState,
  input: ApplySignalInput,
): { state: AccountState; events: string[] } {
  const { symbol, signal, price, rates, strategy, stopPips, takeProfitPips, units } = input
  if (signal === 'neutral') return { state, events: [] }

  let next = state
  const events: string[] = []
  const side: Side = signal === 'buy' ? 'long' : 'short'
  const pos = next.positions.find((p) => p.symbol === symbol)

  if (pos) {
    if (pos.side === side) return { state: next, events: [] } // already on the right side
    const res = closePosition(next, pos.id, { price, reason: 'signal', rates })
    next = res.state
    events.push(`Closed ${symbol} ${pos.side} on reversal (${price.toFixed(5)}).`)
  }

  const gate = canOpen(next, rates)
  if (!gate.ok) return { state: next, events: [...events, gate.reason ?? 'Risk limit.'] }

  // The 50%+ profit-probability gate — the enhancement robot only acts on
  // setups it expects to win more than half the time.
  const probGate = probabilityGate(input)
  if (!probGate.ok) {
    return { state: next, events: [...events, `${symbol}: ${probGate.reason ?? 'Not enough edge right now.'}`] }
  }

  const res = openPosition(
    next,
    { symbol, side, entryPrice: price, stopPips, takeProfitPips, units, strategy, profitProbability: probGate.probability },
    rates,
  )
  if (res.error) return { state: next, events: [...events, `${symbol}: ${res.error}`] }
  next = res.state
  events.push(`Opened ${symbol} ${side} at ${price.toFixed(5)}.`)
  return { state: next, events }
}


/**
 * Run one multi-pair robot cycle: evaluate every pair on the watchlist and
 * open a trade on each qualifying pair, subject to the per-pair cap
 * (config.maxPerPair — 1 by default, raise it to hold several positions per
 * pair) and the global maxOpenTrades cap. A pair at either cap is skipped —
 * never over-filled. Per-pair failures (risk gate, position sizing, open
 * error) are isolated: the cycle keeps going for the other pairs. Pure
 * reducer — no I/O — so paper and live share it.
 */
export function runRobotCycle(
  state: AccountState,
  inputs: RobotCycleInput[],
  config: RobotConfig,
): { state: AccountState; events: string[] } {
  let next = state
  const events: string[] = []
  const perPairCap = Math.max(1, config.maxPerPair)

  for (const input of inputs) {
    const { symbol, signal, price, rates, strategy, stopPips, takeProfitPips, units } = input
    if (signal === 'neutral') continue

    const side: Side = signal === 'buy' ? 'long' : 'short'
    const openOnSymbol = next.positions.filter((p) => p.symbol === symbol).length

    // Per-pair cap — a pair at its cap is skipped, never over-filled.
    if (openOnSymbol >= perPairCap) {
      events.push(`Skipped ${symbol}: ${openOnSymbol} open, per-pair cap ${perPairCap} reached.`)
      continue
    }
    // Global cap — remaining qualifying pairs are deferred to the next cycle.
    if (config.maxOpenTrades > 0 && next.positions.length >= config.maxOpenTrades) {
      events.push(`Deferred ${symbol}: global cap ${config.maxOpenTrades} reached.`)
      continue
    }

    const gate = canOpen(next, rates)
    if (!gate.ok) {
      events.push(gate.reason ?? `${symbol}: risk limits block this trade.`)
      continue
    }

    // The 50%+ profit-probability gate — the robot only opens a trade when
    // its estimated chance of profit is strictly above the threshold. Pairs
    // below it are skipped (and logged) so capital isn't parked on coin flips.
    const probGate = probabilityGate(input)
    if (!probGate.ok) {
      events.push(`Skipped ${symbol}: ${probGate.reason ?? 'not enough edge right now.'}`)
      continue
    }

    const res = openPosition(
      next,
      { symbol, side, entryPrice: price, stopPips, takeProfitPips, units, strategy, profitProbability: probGate.probability },
      rates,
      { maxPerPair: perPairCap },
    )
    if (res.error) {
      events.push(`${symbol}: ${res.error}`)
      continue // isolate this pair — the rest of the cycle proceeds
    }
    next = res.state
    events.push(`Opened ${symbol} ${side} at ${price.toFixed(5)}.`)
  }

  return { state: next, events }
}