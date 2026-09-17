/**
 * Types for the trading engine (paper robot + broker adapters).
 *
 * Everything is denominated in the account currency (USD). Positions are
 * measured in "units" of the base currency and PnL is converted to USD using
 * the live watchlist rates — the same math the robot uses to size positions.
 */

export type Side = 'long' | 'short'

export type PositionStatus = 'open' | 'closed'

export type CloseReason = 'signal' | 'stop_loss' | 'take_profit' | 'target' | 'manual' | 'risk' | 'robot_stop'

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

/** Risk-management knobs the robot enforces. */
export interface RiskConfig {
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
}

export const DEFAULT_RISK: RiskConfig = {
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