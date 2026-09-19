/**
 * Lot sizing for the manual trade form — forex-standard contract sizes.
 * One standard lot is 100,000 units of the base currency; the form lets the
 * trader pick the position size in lots (e.g. 0.01 micro lot, 0.10 mini lot,
 * 1.00 standard lot) instead of raw units. The engine only ever sees whole
 * units, so lot entries are converted at submit time.
 */

/** Contract size of one standard lot. */
export const LOT_UNITS = 100_000

/** Units → lots (a standard lot is 100,000 units), trimmed to 4 decimals. */
export function unitsToLots(units: number): number {
  if (!Number.isFinite(units) || units <= 0) return 0
  return trim(units / LOT_UNITS, 4)
}

/** Lots → whole units (rounded; minimum 1 unit so a position is never zero). */
export function lotsToUnits(lots: number): number {
  if (!Number.isFinite(lots) || lots <= 0) return 0
  return Math.max(1, Math.round(lots * LOT_UNITS))
}

/** Render lots like a broker would: 0.07, 1 → "1", 1.25 → "1.25". */
export function formatLots(lots: number): string {
  if (!Number.isFinite(lots)) return '0'
  const fixed = (Math.abs(lots) >= 1 ? Math.abs(lots).toFixed(2) : Math.abs(lots).toFixed(4))
  return Number(fixed).toString()
}

function trim(x: number, decimals: number): number {
  const p = 10 ** decimals
  return Math.round(x * p) / p
}