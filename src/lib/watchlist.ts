/**
 * The canonical watchlist — every symbol the market-data Edge Function quotes
 * and the robot can trade. Must stay in sync with `market-data/index.ts`.
 *
 * Coverage is the full liquid market universe the free keyless data sources can
 * serve (Yahoo for FX + metals, Binance for crypto):
 *   * 7 FX majors
 *   * 21 FX crosses
 *   * 25 FX exotics (the OANDA-class emerging-market set)
 *   * 9 gold / silver / platinum / palladium pairs (OANDA-spot via Yahoo)
 *   * the top ~30 crypto pairs by market cap (all Binance-listed / Yahoo-covered)
 */
export interface WatchlistPair {
  symbol: string
  name: string
}

export const FX_PAIRS: WatchlistPair[] = [
  // --- Majors ---
  { symbol: 'EUR/USD', name: 'Euro / US Dollar' },
  { symbol: 'GBP/USD', name: 'British Pound / US Dollar' },
  { symbol: 'USD/JPY', name: 'US Dollar / Japanese Yen' },
  { symbol: 'USD/CHF', name: 'US Dollar / Swiss Franc' },
  { symbol: 'AUD/USD', name: 'Australian Dollar / US Dollar' },
  { symbol: 'NZD/USD', name: 'New Zealand Dollar / US Dollar' },
  { symbol: 'USD/CAD', name: 'US Dollar / Canadian Dollar' },

  // --- Crosses ---
  { symbol: 'EUR/GBP', name: 'Euro / British Pound' },
  { symbol: 'EUR/JPY', name: 'Euro / Japanese Yen' },
  { symbol: 'GBP/JPY', name: 'British Pound / Japanese Yen' },
  { symbol: 'EUR/CHF', name: 'Euro / Swiss Franc' },
  { symbol: 'GBP/CHF', name: 'British Pound / Swiss Franc' },
  { symbol: 'EUR/AUD', name: 'Euro / Australian Dollar' },
  { symbol: 'EUR/CAD', name: 'Euro / Canadian Dollar' },
  { symbol: 'EUR/NZD', name: 'Euro / New Zealand Dollar' },
  { symbol: 'GBP/AUD', name: 'British Pound / Australian Dollar' },
  { symbol: 'GBP/CAD', name: 'British Pound / Canadian Dollar' },
  { symbol: 'GBP/NZD', name: 'British Pound / New Zealand Dollar' },
  { symbol: 'AUD/JPY', name: 'Australian Dollar / Japanese Yen' },
  { symbol: 'AUD/CHF', name: 'Australian Dollar / Swiss Franc' },
  { symbol: 'AUD/CAD', name: 'Australian Dollar / Canadian Dollar' },
  { symbol: 'AUD/NZD', name: 'Australian Dollar / New Zealand Dollar' },
  { symbol: 'NZD/JPY', name: 'New Zealand Dollar / Japanese Yen' },
  { symbol: 'NZD/CHF', name: 'New Zealand Dollar / Swiss Franc' },
  { symbol: 'NZD/CAD', name: 'New Zealand Dollar / Canadian Dollar' },
  { symbol: 'CAD/JPY', name: 'Canadian Dollar / Japanese Yen' },
  { symbol: 'CAD/CHF', name: 'Canadian Dollar / Swiss Franc' },
  { symbol: 'CHF/JPY', name: 'Swiss Franc / Japanese Yen' },

  // --- Exotics (emerging-market liquid set) ---
  { symbol: 'USD/TRY', name: 'US Dollar / Turkish Lira' },
  { symbol: 'USD/MXN', name: 'US Dollar / Mexican Peso' },
  { symbol: 'USD/ZAR', name: 'US Dollar / South African Rand' },
  { symbol: 'USD/SGD', name: 'US Dollar / Singapore Dollar' },
  { symbol: 'USD/HKD', name: 'US Dollar / Hong Kong Dollar' },
  { symbol: 'USD/NOK', name: 'US Dollar / Norwegian Krone' },
  { symbol: 'USD/SEK', name: 'US Dollar / Swedish Krona' },
  { symbol: 'USD/DKK', name: 'US Dollar / Danish Krone' },
  { symbol: 'USD/PLN', name: 'US Dollar / Polish Zloty' },
  { symbol: 'USD/HUF', name: 'US Dollar / Hungarian Forint' },
  { symbol: 'USD/CZK', name: 'US Dollar / Czech Koruna' },
  { symbol: 'USD/CNH', name: 'US Dollar / Offshore Chinese Yuan' },
  { symbol: 'EUR/TRY', name: 'Euro / Turkish Lira' },
  { symbol: 'EUR/NOK', name: 'Euro / Norwegian Krone' },
  { symbol: 'EUR/SEK', name: 'Euro / Swedish Krona' },
  { symbol: 'EUR/PLN', name: 'Euro / Polish Zloty' },
  { symbol: 'EUR/HUF', name: 'Euro / Hungarian Forint' },
  { symbol: 'EUR/CZK', name: 'Euro / Czech Koruna' },
  { symbol: 'EUR/MXN', name: 'Euro / Mexican Peso' },
  { symbol: 'EUR/ZAR', name: 'Euro / South African Rand' },
  { symbol: 'GBP/TRY', name: 'British Pound / Turkish Lira' },
  { symbol: 'GBP/NOK', name: 'British Pound / Norwegian Krone' },
  { symbol: 'GBP/SEK', name: 'British Pound / Swedish Krona' },
  { symbol: 'GBP/MXN', name: 'British Pound / Mexican Peso' },
  { symbol: 'GBP/ZAR', name: 'British Pound / South African Rand' },
]

// --- Metals (gold / silver / platinum / palladium, OANDA spot via Yahoo) ---
export const METAL_PAIRS: WatchlistPair[] = [
  { symbol: 'XAU/USD', name: 'Gold / US Dollar' },
  { symbol: 'XAU/EUR', name: 'Gold / Euro' },
  { symbol: 'XAU/GBP', name: 'Gold / British Pound' },
  { symbol: 'XAU/JPY', name: 'Gold / Japanese Yen' },
  { symbol: 'XAU/CHF', name: 'Gold / Swiss Franc' },
  { symbol: 'XAG/USD', name: 'Silver / US Dollar' },
  { symbol: 'XAG/EUR', name: 'Silver / Euro' },
  { symbol: 'XPT/USD', name: 'Platinum / US Dollar' },
  { symbol: 'XPD/USD', name: 'Palladium / US Dollar' },
]

export const CRYPTO_PAIRS: WatchlistPair[] = [
  { symbol: 'BTC/USD', name: 'Bitcoin / US Dollar' },
  { symbol: 'ETH/USD', name: 'Ethereum / US Dollar' },
  { symbol: 'BNB/USD', name: 'BNB / US Dollar' },
  { symbol: 'SOL/USD', name: 'Solana / US Dollar' },
  { symbol: 'XRP/USD', name: 'XRP / US Dollar' },
  { symbol: 'ADA/USD', name: 'Cardano / US Dollar' },
  { symbol: 'DOGE/USD', name: 'Dogecoin / US Dollar' },
  { symbol: 'LTC/USD', name: 'Litecoin / US Dollar' },
  { symbol: 'AVAX/USD', name: 'Avalanche / US Dollar' },
  { symbol: 'LINK/USD', name: 'Chainlink / US Dollar' },
  { symbol: 'DOT/USD', name: 'Polkadot / US Dollar' },
  { symbol: 'MATIC/USD', name: 'Polygon / US Dollar' },
  { symbol: 'SHIB/USD', name: 'Shiba Inu / US Dollar' },
  { symbol: 'TRX/USD', name: 'TRON / US Dollar' },
  { symbol: 'UNI/USD', name: 'Uniswap / US Dollar' },
  { symbol: 'ATOM/USD', name: 'Cosmos / US Dollar' },
  { symbol: 'XLM/USD', name: 'Stellar / US Dollar' },
  { symbol: 'ALGO/USD', name: 'Algorand / US Dollar' },
  { symbol: 'FIL/USD', name: 'Filecoin / US Dollar' },
  { symbol: 'ETC/USD', name: 'Ethereum Classic / US Dollar' },
  { symbol: 'ICP/USD', name: 'Internet Computer / US Dollar' },
  { symbol: 'VET/USD', name: 'VeChain / US Dollar' },
  { symbol: 'XTZ/USD', name: 'Tezos / US Dollar' },
  { symbol: 'HBAR/USD', name: 'Hedera / US Dollar' },
  { symbol: 'APT/USD', name: 'Aptos / US Dollar' },
  { symbol: 'NEAR/USD', name: 'NEAR Protocol / US Dollar' },
  { symbol: 'ARB/USD', name: 'Arbitrum / US Dollar' },
  { symbol: 'OP/USD', name: 'Optimism / US Dollar' },
  { symbol: 'SUI/USD', name: 'Sui / US Dollar' },
  { symbol: 'TON/USD', name: 'Toncoin / US Dollar' },
  { symbol: 'LDO/USD', name: 'Lido DAO / US Dollar' },
  { symbol: 'STX/USD', name: 'Stacks / US Dollar' },
  { symbol: 'INJ/USD', name: 'Injective / US Dollar' },
]

/** Full market universe — FX, metals, then crypto. */
export const WATCHLIST: WatchlistPair[] = [...FX_PAIRS, ...METAL_PAIRS, ...CRYPTO_PAIRS]

/** Every metal base asset quoted in the watchlist (OANDA spot metals via Yahoo). */
export const METAL_BASES = new Set(
  METAL_PAIRS.map((p) => p.symbol.split('/')[0].toUpperCase()),
)

/** Every crypto base asset quoted in the watchlist (USDT/USD listed on Binance + Yahoo). */
export const CRYPTO_BASES = new Set(
  CRYPTO_PAIRS.map((p) => p.symbol.split('/')[0].toUpperCase()),
)

export function isCryptoPair(symbol: string): boolean {
  const base = symbol.split('/')[0]?.trim().toUpperCase()
  return CRYPTO_BASES.has(base)
}

export function isMetalPair(symbol: string): boolean {
  const base = symbol.split('/')[0]?.trim().toUpperCase()
  return METAL_BASES.has(base)
}

export function pairBySymbol(symbol: string): WatchlistPair | null {
  return WATCHLIST.find((p) => p.symbol === symbol) ?? null
}