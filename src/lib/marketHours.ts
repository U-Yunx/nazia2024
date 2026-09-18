/**
 * Market-open check used for sorting, badges and the status card. Crypto trades
 * 24/7; forex and precious metals follow the standard 22:00 UTC Sunday open →
 * 21:00 UTC Friday close.
 */
import { isCryptoPair } from './watchlist'

export function isPairOpen(symbol: string): boolean {
  if (isCryptoPair(symbol)) return true
  const now = new Date()
  const day = now.getUTCDay()
  const hour = now.getUTCHours() + now.getUTCMinutes() / 60
  // Sunday before 22:00 UTC is still closed.
  if (day === 0) return hour >= 22
  // Friday after 21:00 UTC is closed for the weekend.
  if (day === 5) return hour < 21
  // Saturday is fully closed.
  if (day === 6) return false
  return true
}