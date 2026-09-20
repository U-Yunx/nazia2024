/**
 * Lot sizing — forex-standard contract sizes, account-aware.
 *
 * One lot means a different number of units depending on the account flavour:
 * 100,000 units on a Standard (or Custom) account, 10,000 on Mini, 1,000 on
 * Micro, 100 on Nano/Minimal. Lots are entered to 0.01 precision (0.01 lot =
 * one "micro-lot" of the account's contract); the engine only ever sees whole
 * units, so lot entries are converted at the account's contract size.
 *
 * The robot has two sizing modes built on top of this: 'risk' (default) —
 * each trade is sized from a % of current equity and its own stop distance,
 * rounded down to 0.01-lot steps — and 'fixed' — every trade at one picked lot.
 */

/** Contract size of one standard lot (also used by Custom + the default when
 * no account kind is known). */
export const LOT_UNITS = 100_000

/** Smallest lot a broker-style order can express. */
export const MIN_LOT = 0.01

/** Lot granularity — all lot values are multiples of 0.01. */
export const LOT_STEP = 0.01

/** Units → lots at a contract size (a standard lot is 100,000 units), trimmed to 4 decimals. */
export function unitsToLots(units: number, contractSize: number = LOT_UNITS): number {
  if (!Number.isFinite(units) || units <= 0) return 0
  if (!Number.isFinite(contractSize) || contractSize <= 0) return 0
  return trim(units / contractSize, 4)
}

/** Lots → whole units (rounded; minimum 1 unit so a position is never zero). */
export function lotsToUnits(lots: number, contractSize: number = LOT_UNITS): number {
  if (!Number.isFinite(lots) || lots <= 0) return 0
  if (!Number.isFinite(contractSize) || contractSize <= 0) return 0
  if (lots < MIN_LOT) return 0
  return Math.max(1, Math.round(lots * contractSize))
}

/** Snap a lot to the 0.01 step (and at least one micro-lot when non-zero). */
export function normalizeLots(lots: number): number {
  if (!Number.isFinite(lots) || lots <= 0) return 0
  const stepped = Math.round(lots / LOT_STEP) * LOT_STEP
  return Math.max(MIN_LOT, Number(stepped.toFixed(4)))
}

/** Render lots like a broker would: 0.07, 1 → "1", 1.25 → "1.25". */
export function formatLots(lots: number): string {
  if (!Number.isFinite(lots)) return '0'
  const fixed = (Math.abs(lots) >= 1 ? Math.abs(lots).toFixed(2) : Math.abs(lots).toFixed(4))
  return Number(fixed).toString()
}

/** Inputs for risk-based sizing ('risk' mode). */
export interface RiskUnitsInput {
  equityUsd: number
  riskPct: number
  stopPips: number
  pipValuePerUnit: number
  contractSize?: number
}

/**
 * Position size (units) that risks exactly `riskPct`% of equity if the trade
 * is stopped out at `stopPips`, rounded DOWN to the account's 0.01-lot step so
 * the risk budget is never exceeded. Returns 0 when the maths can't produce a
 * valid position (missing rates / non-positive inputs).
 */
export function riskUnits({ equityUsd, riskPct, stopPips, pipValuePerUnit, contractSize = LOT_UNITS }: RiskUnitsInput): number {
  if (!Number.isFinite(equityUsd) || equityUsd <= 0) return 0
  if (!Number.isFinite(riskPct) || riskPct <= 0) return 0
  if (!Number.isFinite(stopPips) || stopPips <= 0) return 0
  if (!Number.isFinite(pipValuePerUnit) || pipValuePerUnit <= 0) return 0
  if (!Number.isFinite(contractSize) || contractSize <= 0) return 0
  // One micro-lot (0.01 lot) of this account's contract — the floor.
  const stepUnits = Math.max(1, Math.round(contractSize * MIN_LOT))
  // USD lost on one unit if the trade hits its stop.
  const lossPerUnit = stopPips * pipValuePerUnit
  const exactUnits = (equityUsd * riskPct) / 100 / lossPerUnit
  const stepped = Math.floor(exactUnits / stepUnits) * stepUnits
  // Brokers never step below one micro-lot, so a tiny budget still floors there.
  return Math.max(stepUnits, stepped)
}

/** Inputs for the robot's per-trade position size. */
export interface SizingUnitsInput {
  mode: 'risk' | 'fixed'
  lot: number
  riskPct: number
  equityUsd: number
  stopPips: number
  pipValuePerUnit: number
  contractSize: number
}

/**
 * The number of units the robot opens a trade at:
 *  - 'risk' → % of equity sized against the trade's own stop (0.01-lot steps);
 *  - 'fixed' → the pre-picked lot converted at the account's contract size.
 * Returns 0 when sizing can't produce a valid position (caller skips the trade).
 */
export function sizingUnits(input: SizingUnitsInput): number {
  const { mode, lot, riskPct, equityUsd, stopPips, pipValuePerUnit, contractSize } = input
  if (!Number.isFinite(contractSize) || contractSize <= 0) return 0
  if (mode === 'risk') {
    return riskUnits({ equityUsd, riskPct, stopPips, pipValuePerUnit, contractSize })
  }
  return lotsToUnits(lot, contractSize)
}

function trim(x: number, decimals: number): number {
  const p = 10 ** decimals
  return Math.round(x * p) / p
}