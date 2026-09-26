/**
 * Types for the trading engine (paper robot + broker adapters).
 *
 * Everything is denominated in the account currency (USD). Positions are
 * measured in "units" of the base currency and PnL is converted to USD using
 * the live watchlist rates — the same math the robot uses to size positions.
 */

export type Side = 'long' | 'short'

export type PositionStatus = 'open' | 'closed'

export type CloseReason =
  | 'signal'
  | 'stop_loss'
  | 'take_profit'
  | 'target'
  | 'manual'
  | 'risk'
  | 'robot_stop'
  | 'pullback'
  /**
   * Peak-return close: the position profited, gave back `peakReturnGivebackPct`
   * from its best unrealized PnL, then rallied back to that same highest
   * profit — the robot closed it AT the peak ("trade the profit, watch it
   * dip, then bank it the moment it returns to the top").
   */
  | 'peak_return'
  /**
   * Drawdown stop: the position bled `risk.drawdownClosePct` from its entry
   * price and was closed at the % level (NOT used for fast crashes — those
   * are held open; see Position.crashHold).
   */
  | 'drawdown'
  /**
   * Emergency margin closeout: the account's balance or equity reached the
   * near-zero floor (`engine.NEAR_ZERO_BALANCE_USD`), so every open position
   * was closed at market and the robot stood down.
   */
  | 'margin'
  /**
   * Auto-reverse ("reverse open position trading"): the position was closed
   * because it moved `risk.reverseTriggerPips` against the robot's entry while
   * `risk.autoReverse` was activated — the robot immediately opened the
   * opposite direction at the same size to ride the reversal.
   */
  | 'reverse'

export type BrokerMode = 'paper' | 'managed' | 'oanda' | 'mt'

/** Live price per watchlist symbol (symbol -> price). */
export interface RatesMap {
  [symbol: string]: number
}

/** An open position. */
export interface Position {
  id: string
  symbol: string
  side: Side
  units: number
  entryPrice: number
  entryTime: string
  stopPrice: number
  takeProfitPrice: number
  /**
   * USD profit target for this position: markToMarket closes it as soon as
   * unrealized PnL reaches this amount. 0 / undefined = off. Manual orders
   * stamp their own value; robot trades fall back to the robot's per-trade
   * target at close time.
   */
  targetProfitUsd?: number
  /**
   * USD loss cap for this position: markToMarket closes it if unrealized PnL
   * ever dips to -$this. 0 / undefined = off. Enforced like a stop — a trade
   * bleeding money is cut at the $ limit.
   */
  targetLossUsd?: number
  /**
   * Best unrealized PnL (USD) this position has reached while open. The
   * profit-pullback lock (`risk.profitPullbackPct`) closes the trade once it
   * gives back that % from this peak, banking the gains. Persisted so the
   * peak survives reloads and server-side takeovers. 0 / undefined = not
   * tracked (lock off, or a position that never went green).
   */
  peakProfitUsd?: number
  /**
   * Set by the peak-return rule once a position has given back
   * `risk.peakReturnGivebackPct` from its best unrealized PnL ("it dipped").
   * While set, the peak is frozen at the LAST highest profit — the engine no
   * longer raises it — and markToMarket closes the trade the moment PnL
   * returns to that frozen peak (reason 'peak_return'): bank it AT the top.
   * Persisted so the arm survives reloads and server-side takeovers.
   */
  peakRetraced?: boolean
  /**
   * Price this position was last marked at (persisted). The drawdown stop
   * uses the gap between two consecutive marks to tell a *fast crash* (one
   * giant step that crossed the whole drawdown band) apart from a slow bleed,
   * so a flash crash isn't sold at the bottom. Undefined = never marked yet
   * (the engine treats the entry price as the previous mark).
   */
  lastMarkPrice?: number
  /**
   * Set when the position's adverse move crossed `risk.drawdownClosePct`
   * inside a single mark-to-market step — a fast, long drop. While set, the
   * % drawdown stop is suppressed for this position (it rides the crash out
   * instead of selling the bottom) but every other rule — real stop, targets,
   * take-profit, pullback, signal flip — still applies. Persisted so the hold
   * survives reloads and server-side takeovers.
   */
  crashHold?: boolean
  /** Account equity at the moment the position was opened (for PnL %). */
  entryEquity: number
  strategy?: string
  /**
   * Estimated probability of profit (0–1) when this position was opened —
   * derived by the engine from the setup's signal strength (score, trend,
   * RSI, momentum, volatility) and the stop/target geometry. Only robot
   * entries carry it; manual orders are unrated.
   */
  entryProbability?: number
  /**
   * Set when this position already banked its partial take-profit (scale-out):
   * part of the units were closed at the first target, the stop was moved to
   * break-even and the remaining units ride to the full target / trailing stop.
   * The scale-out rule only fires once per position. Persisted so a reload or
   * server-side takeover doesn't re-bank the first target.
   */
  partialTaken?: boolean
  /**
   * The scale-out first-target price, stamped at OPEN time (entry ±
   * `partialTpRatio` × the stop distance) when partial take-profit is enabled.
   * Stamping it at open — instead of recomputing it from the CURRENT stop each
   * mark — is what keeps the first target fixed even after the trailing stop /
   * break-even logic has ratcheted the stop toward price. Absent on positions
   * opened while scale-out was off (they never fire the rule).
   */
  tp1Price?: number
  status: 'open'
}

/** A fully closed trade, retained for the journal. */
export interface ClosedTrade {
  id: string
  symbol: string
  side: Side
  units: number
  entryPrice: number
  entryTime: string
  exitPrice: number
  exitTime: string
  stopPrice: number
  takeProfitPrice: number
  /** Account equity at the moment the position was opened (for PnL %). */
  entryEquity: number
  /** Realized PnL in account currency (USD). */
  pnl: number
  pnlPct: number
  closeReason: CloseReason
  strategy?: string
  /** Probability of profit (0–1) estimated when the position was opened. */
  entryProbability?: number
  status: 'closed'
}

/** Paper/ledger account flavour. Each preset maps a starting balance to a
 * small-broker-style contract size per lot, from full-size Standard (100,000
 * units/lot) down to Nano (100 units/lot) and the $10 Minimal starter account.
 * 'custom' = user-chosen starting balance (any amount ≥ MIN_PAPER_DEPOSIT)
 * with the standard 100,000-unit contract. */
export type PaperAccountKind = 'standard' | 'mini' | 'micro' | 'nano' | 'minimal' | 'custom'

/** Risk-management knobs the robot enforces. */
export interface RiskConfig {
  /** Paper account flavour (standard vs micro). Optional for legacy saved accounts. */
  kind?: PaperAccountKind
  /** % of equity risked per trade (position sizing). */
  riskPerTradePct: number
  /** Max concurrently open positions (across all robot pairs). */
  maxOpenPositions: number
  /** Default stop-loss distance in pips. */
  defaultStopPips: number
  /** Take-profit distance as a multiple of the stop (risk:reward). */
  takeProfitRatio: number
  /**
   * Denomination the per-trade profit target / loss cap are entered in.
   * 'usd' → the fields below; 'pips' → the pips fields below, converted to
   * USD per position at mark-to-market using that position's size and the
   * pair's live pip value.
   */
  profitUnit: 'pips' | 'usd'
  /**
   * Per-trade profit target in USD: when an open trade's unrealized PnL reaches
   * this amount the robot closes it and banks the win. 0 = off (only the
   * price-based take-profit applies).
   */
  targetPerTradeUsd: number
  /**
   * Per-trade loss cap in USD: when an open trade's unrealized PnL reaches
   * -$this the robot closes it and cuts the loss. 0 = off (only the
   * price-based stop applies).
   */
  maxLossPerTradeUsd: number
  /**
   * Per-trade profit target in pips (used when profitUnit = 'pips'): the
   * target is re-computed per position as `pips × pip value × units` so it
   * scales with the pair and size actually traded. 0 = off.
   */
  targetPerTradePips: number
  /**
   * Per-trade loss cap in pips (used when profitUnit = 'pips'): the cap is
   * `pips × pip value × units` for each position. 0 = off.
   */
  maxLossPerTradePips: number
  /** Daily loss limit as % of starting equity — blocks new entries when hit. */
  maxDailyLossPct: number
  /** When true, the robot acts on strategy signals automatically. */
  autoTrade: boolean
  /** When true, the stop-loss ratchets toward price once a trade is in profit. */
  trailingStop: boolean
  /** How far (in pips) the trailing stop trails behind the best price. */
  trailPips: number
  /** Move the stop to break-even once price is this many pips in profit. */
  breakEvenPips: number
  /** Start trailing the stop only after price is this many pips in profit. */
  trailActivationPips: number
  /**
   * Consecutive-loss circuit breaker: block new entries after N losses in a
   * row (0 = off). "Loss" = any recent closed trade that lost money; manual
   * closes and robot-stop closes don't count toward the streak.
   */
  maxConsecutiveLosses: number
  /** Scale position size down after consecutive losses (risk-aware sizing). */
  adaptiveRisk: boolean
  /** Skip new entries when volatility (ATR) is spiking — stand aside. */
  volatilityFilter: boolean
  /**
   * Profit-pullback lock (%): when a position's unrealized PnL retraces this
   * percentage from its peak, markToMarket closes it to bank the gains.
   * Example — a trade at peak $20 with 25% locks at $15. 0 = off.
   * The lock only ARMS once the position's profit has exceeded
   * `profitPullbackActivateUsd` (default $1) — a trade that never got meaningfully
   * green can't be trapped by the pull-back rule.
   */
  profitPullbackPct: number
  /**
   * Profit-pullback activation ($): the lock arms only after a position's
   * unrealized profit has exceeded this amount. Below it, the pull-back rule is
   * dormant — a $0.40 blip up then back down never closes a trade. Default $1:
   * "active once the profit is more than a dollar, then close on X% give-back".
   */
  profitPullbackActivateUsd: number
  /**
   * Peak-return close: when a position's unrealized PnL profited, gave back
   * `peakReturnGivebackPct` from its peak, then rallied BACK to that same
   * highest profit, markToMarket closes it right there (reason 'peak_return')
   * — "watch it dip, then bank it the moment it returns to the top". Off by
   * default; the one-click Pro strategy preset and pro-trader copies enable it.
   */
  peakReturnClose: boolean
  /**
   * How much a position must give back from its peak unrealized PnL (as a %)
   * before the peak-return close arms. 10 = the trade dipped 10% off its best
   * profit before a return to the peak counts as a close signal. Guards
   * against closing on sub-pip noise right at the high.
   */
  peakReturnGivebackPct: number
  /**
   * Drawdown stop (%): a losing position is closed once it is down this %
   * from its entry price — the slow bleed to -25% case. EXCEPTION: when the
   * whole threshold is crossed in one fast mark (a crash), the position is
   * kept open instead (Position.crashHold) so it isn't sold at the bottom.
   * 0 = off (default risk preset enables it at 25).
   */
  drawdownClosePct: number
  /**
   * Round-trip trading cost per trade in USD (commission + spread model).
   * Deducted from the position's gross PnL when it closes, so paper results
   * and backtests reflect realistic broker costs instead of free fills.
   * 0 = cost-free simulation (default).
   */
  costPerTradeUsd: number
  /**
   * Partial take-profit / scale-out: when enabled, a winning position closes
   * `partialClosePct`% of its units at the first target (`partialTpRatio` ×
   * the stop distance — 1 = one R), banks that win, then moves the stop to
   * break-even and lets the remaining units run to the full take-profit with
   * trailing. This is the scale-out exit style used by long-running,
   * stable professional trading robots: lock profit early, keep upside.
   * 0/off (default) = the whole position rides to one take-profit.
   */
  partialTakeProfit: boolean
  /** % of a position's units closed at the first (partial) target. 50 = half. */
  partialClosePct: number
  /** First target as a multiple of the stop distance (1 = one R / risk unit). */
  partialTpRatio: number
  /**
   * Auto-reverse ("reverse open position trading"). When activated, the robot
   * closes a strategy-tagged position that has moved `reverseTriggerPips`
   * against its entry and immediately opens the OPPOSITE direction at the same
   * size — riding the reversal instead of waiting for the stop. It runs
   * automatically (autorun) on every mark-to-market pass while the robot is
   * running (`autoTrade`), never touches manual positions, and the reversed
   * open still passes every risk gate (caps, daily loss, circuit breaker).
   * Off by default. Optional so saved risk configs written before this feature
   * load unchanged.
   */
  autoReverse?: boolean
  /** Adverse pips from entry that triggers an auto-reverse (off when ≤ 0). */
  reverseTriggerPips?: number
  /**
   * Hedge on loss ("open the opposite trade"). When activated, a
   * strategy-tagged position that has moved `hedgeTriggerPips` against its
   * entry gets an OPPOSITE-direction position opened ALONGSIDE it — the loser
   * stays open (unlike auto-reverse, which closes it). The hedge is sized
   * risk-based (% of equity against its own stop distance), deliberately
   * BYPASSES the per-pair cap (so a sequential pair capped at 1 can still
   * hold a 2-leg book), and never stacks a third leg: it only fires when no
   * opposite position exists on the pair yet. Every other risk gate (global
   * max-open-positions, daily loss limit, circuit breaker) still applies.
   * Runs automatically while the robot is running (`autoTrade`) and never
   * touches manual positions. Off by default. Optional so saved risk configs
   * written before this feature load unchanged.
   */
  hedgeEnabled?: boolean
  /** Adverse pips from entry that opens the opposite (hedge) leg (off ≤ 0). */
  hedgeTriggerPips?: number
  /**
   * Deep Analyst entry gate ("auto deep analyst for the robot"). When
   * activated, every robot entry is vetted by the Deep Analyst Edge Function
   * before it opens — a 'skip' verdict stands the trade aside. STRICT mode:
   * when the trader is not signed in (AI unavailable), the robot opens NO
   * trades at all until they sign in. Off by default. Optional so saved risk
   * configs written before this feature load unchanged.
   */
  deepAnalystGate?: boolean
}

/** Default adverse pips from entry that triggers an auto-reverse when the
 *  account does not carry its own `reverseTriggerPips` value yet. */
export const DEFAULT_REVERSE_TRIGGER_PIPS = 15

/** Default adverse pips from entry that opens the opposite (hedge) leg when
 *  the account does not carry its own `hedgeTriggerPips` value yet. */
export const DEFAULT_HEDGE_TRIGGER_PIPS = 30

export const DEFAULT_RISK: RiskConfig = {
  kind: 'standard',
  riskPerTradePct: 1,
  maxOpenPositions: 5,
  defaultStopPips: 20,
  takeProfitRatio: 2,
  profitUnit: 'usd',
  targetPerTradeUsd: 0,
  maxLossPerTradeUsd: 0,
  targetPerTradePips: 0,
  maxLossPerTradePips: 0,
  maxDailyLossPct: 5,
  autoTrade: false,
  trailingStop: true,
  trailPips: 15,
  breakEvenPips: 10,
  trailActivationPips: 12,
  maxConsecutiveLosses: 0,
  adaptiveRisk: true,
  volatilityFilter: false,
  profitPullbackPct: 25,
  profitPullbackActivateUsd: 1,
  // Peak-return close is off by default — the one-click Pro preset and the
  // pro-trader copies turn it on with a 10% give-back arm.
  peakReturnClose: false,
  peakReturnGivebackPct: 10,
  drawdownClosePct: 25,
  costPerTradeUsd: 0,
  // Scale-out exit is off by default — the one-click Pro strategy preset turns
  // it on with battle-tested 50%-at-1R + break-even + trail values.
  partialTakeProfit: false,
  partialClosePct: 50,
  partialTpRatio: 1,
  // Auto-reverse is off by default — flipping a loser 1:1 into the opposite
  // direction past the trigger pips is aggressive, so it is always an
  // explicit activation.
  autoReverse: false,
  reverseTriggerPips: DEFAULT_REVERSE_TRIGGER_PIPS,
  // Hedge-on-loss is off by default — opening a second leg on a pair that is
  // capped at 1 position is aggressive, so it is always an explicit
  // activation. The Deep Analyst entry gate is off too; when enabled it is a
  // strict AI veto (no opens until the trader signs in).
  hedgeEnabled: false,
  hedgeTriggerPips: DEFAULT_HEDGE_TRIGGER_PIPS,
  deepAnalystGate: false,
}

/** The full persisted state of a paper account. */
export interface AccountState {
  id: string | null
  broker: BrokerMode
  currency: 'USD'
  initialBalance: number
  balance: number
  risk: RiskConfig
  positions: Position[]
  trades: ClosedTrade[]
  createdAt: string | null
  updatedAt: string | null
}

export interface OpenPositionRequest {
  symbol: string
  side: Side
  entryPrice: number
  stopPips: number
  takeProfitPips: number
  units: number
  strategy?: string
  /** Optional per-order $ profit target (0 / undefined = off). */
  targetProfitUsd?: number
  /** Optional per-order $ loss cap (0 / undefined = off). */
  targetLossUsd?: number
  /** Probability of profit (0–1) driving a robot entry — stamped on the trade. */
  profitProbability?: number
  time?: string
}

export interface ApplySignalInput {
  symbol: string
  signal: 'buy' | 'sell' | 'neutral'
  price: number
  rates: RatesMap
  strategy?: string
  stopPips: number
  takeProfitPips: number
  units: number
  /**
   * Ingredients the engine uses to estimate this setup's probability of
   * profit. When present and the estimate is ≤ PROFIT_PROBABILITY_THRESHOLD
   * the robot stands aside — it only opens trades it expects to win more
   * than half the time.
   */
  score?: number
  momentum?: number
  rsi?: number
  trend?: number
  volatilityPct?: number
  /** Optional explicit probability override (0–1). Estimate wins unless set. */
  profitProbability?: number
}

/** Per-strategy trade mode: one open position per pair vs. N concurrent. */
export type TradeMode = 'sequential' | 'concurrent'

/**
 * Multi-trade / multi-pair robot configuration (Phase 2). A single-pair robot
 * is just a watchlist of 1 with tradeMode 'sequential' — backward compatible.
 */
export interface RobotConfig {
  /** Watchlist of 1..N symbols the robot scans each cycle. */
  pairs: string[]
  /** 'sequential' → max 1 open position per pair; 'concurrent' → up to maxPerPair. */
  tradeMode: TradeMode
  /** Concurrent mode only: max open positions on the same pair. */
  maxPerPair: number
  /** Global cap on open positions across all pairs (0 = no cap beyond risk). */
  maxOpenTrades: number
}

export const DEFAULT_ROBOT_CONFIG: RobotConfig = {
  pairs: [],
  tradeMode: 'sequential',
  maxPerPair: 1,
  maxOpenTrades: 0,
}

/**
 * The robot only OPENS a trade when its estimated probability of profit is
 * strictly greater than this threshold (0.5 = 50%). At or below this the
 * setup has no edge — the cycle skips the pair and parks the capital.
 */
export const PROFIT_PROBABILITY_THRESHOLD = 0.5

/** Input for a single pair inside a multi-pair robot cycle. */
export interface RobotCycleInput extends ApplySignalInput {}