import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders } from "jsr:@supabase/supabase-js@2/cors";

// ---------------------------------------------------------------------------
// Market data proxy for the FX Toolkit.
//
// The browser NEVER talks to a market-data provider directly. This function
// holds each provider's API key as a secret, proxies requests server-side, and
// caches responses so dashboard polling and repeated signals don't burn the
// free-tier credit budget.
//
// v13 — keyless-first, self-contained:
//   * Default provider is the built-in FREE keyless source: Binance public API
//     for crypto + Yahoo Finance for FX/metals, so quotes, charts and the robot
//     work immediately with no API key and no signup.
//   * Optional keyed providers (Twelve Data, Finnhub, Alpha Vantage, Polygon.io)
//     and a broker-derived source (OANDA trader account) plug into the same
//     auto-fallback chain. The first provider that serves usable data wins and
//     is promoted to active, so the platform keeps working without intervention.
//   * Keys live in app_secrets.market_data_* server-side, never in the browser.
// ---------------------------------------------------------------------------

// Pairs / instruments (same universe as src/lib/watchlist.ts).
const FX_SYMBOLS = [
  "EUR/USD", "GBP/USD", "USD/JPY", "USD/CHF", "AUD/USD", "NZD/USD", "USD/CAD",
  "EUR/GBP", "EUR/JPY", "GBP/JPY", "EUR/CHF", "GBP/CHF", "EUR/AUD", "EUR/CAD",
  "EUR/NZD", "GBP/AUD", "GBP/CAD", "GBP/NZD", "AUD/JPY", "AUD/CHF", "AUD/CAD",
  "AUD/NZD", "NZD/JPY", "NZD/CHF", "NZD/CAD", "CAD/JPY", "CAD/CHF", "CHF/JPY",
  "USD/TRY", "USD/MXN", "USD/ZAR", "USD/SGD", "USD/HKD", "USD/NOK", "USD/SEK",
  "USD/DKK", "USD/PLN", "USD/HUF", "USD/CZK", "USD/CNH", "EUR/TRY", "EUR/NOK",
  "EUR/SEK", "EUR/PLN", "EUR/HUF", "EUR/CZK", "EUR/MXN", "EUR/ZAR", "GBP/TRY",
  "GBP/NOK", "GBP/SEK", "GBP/MXN", "GBP/ZAR",
];
const METAL_SYMBOLS = [
  "XAU/USD", "XAU/EUR", "XAU/GBP", "XAU/JPY", "XAU/CHF", "XAG/USD", "XAG/EUR",
  "XPT/USD", "XPD/USD",
];
const CRYPTO_SYMBOLS = [
  "BTC/USD", "ETH/USD", "BNB/USD", "SOL/USD", "XRP/USD", "ADA/USD", "DOGE/USD",
  "LTC/USD", "AVAX/USD", "LINK/USD", "DOT/USD", "MATIC/USD", "SHIB/USD",
  "TRX/USD", "UNI/USD", "ATOM/USD", "XLM/USD", "ALGO/USD", "FIL/USD", "ETC/USD",
  "ICP/USD", "VET/USD", "XTZ/USD", "HBAR/USD", "APT/USD", "NEAR/USD", "ARB/USD",
  "OP/USD", "SUI/USD", "TON/USD", "LDO/USD", "STX/USD", "INJ/USD",
];
const WATCHLIST = [...FX_SYMBOLS, ...METAL_SYMBOLS, ...CRYPTO_SYMBOLS];
const CRYPTO_BASES = new Set(CRYPTO_SYMBOLS.map((s) => s.split("/")[0].toUpperCase()));

const VALID_INTERVALS = ["1min", "5min", "15min", "30min", "1h", "4h", "1day"];
const MAX_OUTPUTSIZE = 5000;

const TD_BASE = "https://api.twelvedata.com";
const FH_BASE = "https://finnhub.io/api/v1";
const AV_BASE = "https://www.alphavantage.co/query";
const POLY_BASE = "https://api.polygon.io";
const YH_BASE = "https://query1.finance.yahoo.com/v8/finance/chart";
const BN_BASE = "https://api.binance.com/api/v3";
const OANDA_PRACTICE = "https://api-fxpractice.oanda.com";
const OANDA_LIVE = "https://api-fxtrade.oanda.com";

// --- Types ------------------------------------------------------------------
export interface Quote {
  symbol: string;
  price: number | null;
  change: number | null;
  percent_change: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  previous_close: number | null;
  is_market_open: boolean | null;
  datetime: string | null;
  stale?: boolean;
  error?: string | null;
}

export interface Bar {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

interface CacheState {
  payload: unknown;
  updated_at: string;
}

// --- Supabase admin client (service-role — never exposed to the browser) ------
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const ADMIN_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  (() => {
    try {
      const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}") as Record<string, unknown>;
      return (keys["default"] as string) ?? "";
    } catch {
      return "";
    }
  })();
const admin = ADMIN_KEY ? createClient(SUPABASE_URL, ADMIN_KEY) : null;

const memoryCache = new Map<string, { at: number; value: unknown }>();

const TTL_MS: Record<string, number> = {
  "1min": 5 * 60_000,
  "5min": 5 * 60_000,
  "15min": 15 * 60_000,
  "30min": 30 * 60_000,
  "1h": 30 * 60_000,
  "4h": 30 * 60_000,
  "1day": 12 * 60 * 60_000,
};
const QUOTES_FRESH_MS = 300_000; // keyed providers: 5 min
const QUOTES_FRESH_FREE_MS = 6_000; // keyless: live cadence
const FREE_FX_BUDGET = 2; // max FX/metals symbols refreshed per request
const RATE_MAX = 8;
const RATE_WINDOW_MS = 60_000;
const QUOTES_REFRESH_BUDGET = 2;

let tokens = RATE_MAX;
let lastRefill = Date.now();
let lastFreeBatchAt = 0;

function canUseCredit(): boolean {
  const now = Date.now();
  tokens = Math.min(RATE_MAX, tokens + ((now - lastRefill) / RATE_WINDOW_MS) * RATE_MAX);
  lastRefill = now;
  if (tokens >= 1) {
    tokens -= 1;
    return true;
  }
  return false;
}

function canUseFreeBatch(): boolean {
  const now = Date.now();
  if (now - lastFreeBatchAt < 4_000) return false;
  lastFreeBatchAt = now;
  return true;
}

// --- Shared upstream gate (DB-backed mutex, ~7.5s) ---------------------------
const GATE_KEY = "meta:upstream_gate";
const GATE_INTERVAL_MS = Math.max(1000, Math.floor(RATE_WINDOW_MS / RATE_MAX));

async function claimUpstreamSlot(): Promise<boolean> {
  if (!admin) return true;
  const now = new Date();
  const cutoff = new Date(now.getTime() - GATE_INTERVAL_MS).toISOString();
  const { data, error } = await admin
    .from("market_cache")
    .update({ updated_at: now.toISOString() })
    .eq("cache_key", GATE_KEY)
    .lt("updated_at", cutoff)
    .select("cache_key");
  if (error) return true;
  if (data && data.length > 0) return true;
  const { data: exists } = await admin
    .from("market_cache")
    .select("cache_key")
    .eq("cache_key", GATE_KEY)
    .maybeSingle();
  if (!exists) {
    const { error: insErr } = await admin.from("market_cache").upsert(
      { cache_key: GATE_KEY, payload: { at: now.toISOString() }, updated_at: now.toISOString() },
      { onConflict: "cache_key" },
    );
    return !insErr;
  }
  return false;
}

async function cacheGetMany(keys: string[]): Promise<Map<string, CacheState>> {
  const out = new Map<string, CacheState>();
  if (!admin || keys.length === 0) return out;
  const { data } = await admin
    .from("market_cache")
    .select("cache_key,payload,updated_at")
    .in("cache_key", keys);
  for (const row of data ?? []) {
    out.set(row.cache_key, { payload: row.payload, updated_at: row.updated_at });
  }
  return out;
}

async function cacheSet(key: string, payload: unknown): Promise<void> {
  if (!admin) return;
  memoryCache.set(key, { at: Date.now(), value: payload });
  await admin
    .from("market_cache")
    .upsert({ cache_key: key, payload, updated_at: new Date().toISOString() }, { onConflict: "cache_key" });
}

// --- Provider interface --------------------------------------------------------
interface MarketProvider {
  id: string;
  label: string;
  signupUrl: string;
  envKey: string;
  keyless?: boolean;
  source?: "keyed" | "keyless" | "broker";
  validate: (apiKey: string) => Promise<string | null>;
  fetchQuote: (apiKey: string, symbol: string) => Promise<Quote>;
  fetchTimeSeries: (
    apiKey: string,
    symbol: string,
    interval: string,
    outputsize: number,
    startDate?: string,
    endDate?: string,
  ) => Promise<{ bars: Bar[]; error?: string; rateLimited?: boolean }>;
}

// --- Helpers -----------------------------------------------------------------
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function optNum(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function isCryptoSymbol(symbol: string): boolean {
  const base = symbol.split("/")[0]?.trim().toUpperCase();
  return CRYPTO_BASES.has(base);
}

function isMarketOpen(symbol: string): boolean {
  if (isCryptoSymbol(symbol)) return true;
  const now = new Date();
  const day = now.getUTCDay();
  const hour = now.getUTCHours() + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600;
  if (day === 0) return hour >= 22;
  if (day >= 1 && day <= 4) return hour < 21 || hour >= 22;
  if (day === 5) return hour < 21;
  return false;
}

function isRateLimited(res: Response, data: { status?: string; message?: string } | null): boolean {
  return res.status === 429 || (data?.status === "error" && /credit|rate|limit/i.test(data?.message ?? ""));
}

function aggregateBars(bars: Bar[], n: number): Bar[] {
  const out: Bar[] = [];
  for (let i = 0; i < bars.length; i += n) {
    const chunk = bars.slice(i, i + n);
    if (chunk.length === 0) continue;
    out.push({
      time: chunk[0].time,
      open: chunk[0].open,
      high: Math.max(...chunk.map((b) => b.high)),
      low: Math.min(...chunk.map((b) => b.low)),
      close: chunk[chunk.length - 1].close,
      volume: chunk.reduce((s, b) => s + (b.volume ?? 0), 0),
    });
  }
  return out;
}

/**
 * Chart consumers (lightweight-charts) require strictly ascending, unique
 * times. Some upstream providers return bars newest-first (Twelve Data) and
 * cached rows may predate normalization, so sort + dedupe before serving or
 * caching. `slice(-n)` keeps the most recent bars after the sort.
 */
function normalizeBars(bars: Bar[], n?: number): Bar[] {
  const t = (b: Bar): number => Date.parse(b.time);
  const sorted: Bar[] = [];
  const seen = new Set<string>();
  const ordered = [...bars].sort((a, b) => t(a) - t(b));
  for (const b of ordered) {
    if (seen.has(b.time)) continue;
    seen.add(b.time);
    sorted.push(b);
  }
  return typeof n === "number" ? sorted.slice(-Math.max(0, n)) : sorted;
}

// --- Auth --------------------------------------------------------------------
const PROJECT_REF = (() => {
  try {
    const host = new URL(SUPABASE_URL).hostname;
    return host.endsWith(".supabase.co") ? host.split(".")[0] : "";
  } catch {
    return "";
  }
})();

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}

function isKnownPublishableKey(value: string): boolean {
  const anon = Deno.env.get("SUPABASE_ANON_KEY");
  if (anon && value === anon) return true;
  const pubsRaw = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS");
  if (pubsRaw) {
    try {
      const pubs = JSON.parse(pubsRaw) as Record<string, unknown>;
      for (const k of Object.values(pubs)) {
        if (typeof k === "string" && k === value) return true;
      }
    } catch {
      // ignore malformed JSON
    }
  }
  return false;
}

function isProjectKeyJwt(token: string): boolean {
  if (!PROJECT_REF) return false;
  const payload = decodeJwtPayload(token);
  return !!payload && typeof payload.ref === "string" && payload.ref === PROJECT_REF;
}

async function isAuthorized(req: Request): Promise<boolean> {
  const apikey = req.headers.get("apikey");
  if (apikey && isKnownPublishableKey(apikey)) return true;
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return false;
  const token = authHeader.slice("Bearer ".length).trim();
  if (!token) return false;
  if (isKnownPublishableKey(token) || isProjectKeyJwt(token)) return true;
  try {
    const supabase = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
      global: { headers: { Authorization: authHeader } },
    });
    const { data, error } = await supabase.auth.getUser(token);
    return !error && !!data?.user;
  } catch {
    return false;
  }
}

async function isAdminUser(req: Request): Promise<boolean> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return false;
  const payload = decodeJwtPayload(authHeader.slice("Bearer ".length).trim());
  if (!payload || typeof payload.sub !== "string" || !admin) return false;
  try {
    const { data } = await admin.from("profiles").select("role").eq("id", payload.sub).maybeSingle();
    return data?.role === "admin";
  } catch {
    return false;
  }
}

function hasSession(req: Request): boolean {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return false;
  const payload = decodeJwtPayload(authHeader.slice("Bearer ".length).trim());
  return !!payload && typeof payload.sub === "string" && payload.sub.length > 0;
}

// --- Provider config / secrets -------------------------------------------------
let apiKeyCache: { provider: string; key: string; at: number } | null = null;

async function resolveSelectedProvider(): Promise<string> {
  if (admin) {
    try {
      const { data } = await admin
        .from("app_secrets")
        .select("value")
        .eq("key", "market_data_provider")
        .maybeSingle();
      const v = data?.value;
      if (typeof v === "string" && v && PROVIDERS[v]) return v;
    } catch {
      // fall through
    }
  }
  return "yahoo"; // keyless default
}

async function resolveApiKey(providerId: string): Promise<string | null> {
  const now = Date.now();
  if (apiKeyCache && apiKeyCache.provider === providerId && now - apiKeyCache.at < 60_000) {
    return apiKeyCache.key;
  }
  let key: string | null = null;
  if (admin) {
    try {
      const { data } = await admin
        .from("app_secrets")
        .select("value")
        .eq("key", `market_data_${providerId}`)
        .maybeSingle();
      const v = data?.value;
      if (typeof v === "string" && v.trim()) key = v.trim();
    } catch {
      // fall through
    }
  }
  if (!key) {
    const env = Deno.env.get(PROVIDERS[providerId]?.envKey ?? "");
    if (env && env.trim()) key = env.trim();
  }
  apiKeyCache = key ? { provider: providerId, key, at: now } : null;
  return key;
}

async function resolveProviderChain(): Promise<string[]> {
  const selected = await resolveSelectedProvider();
  const chain: string[] = [];
  const push = (id: string) => {
    if (!chain.includes(id)) chain.push(id);
  };
  push(selected);
  for (const id of Object.keys(PROVIDERS)) {
    if (id === selected || PROVIDERS[id].keyless) continue;
    if (await resolveApiKey(id)) push(id);
  }
  for (const id of Object.keys(PROVIDERS)) {
    if (id === selected || chain.includes(id)) continue;
    if (PROVIDERS[id].keyless) push(id);
  }
  return chain;
}

async function resolveActiveProvider(): Promise<{ id: string | null; label: string | null }> {
  const chain = await resolveProviderChain();
  for (const id of chain) {
    const p = PROVIDERS[id];
    if (p.keyless || !!(await resolveApiKey(id))) return { id, label: p.label };
  }
  return { id: null, label: null };
}

let lastPromotion: { id: string; at: number } | null = null;
const PROMOTION_COOLDOWN_MS = 120_000;

async function maybePromoteProvider(providerId: string): Promise<void> {
  if (!admin) return;
  const now = Date.now();
  if (lastPromotion && lastPromotion.id === providerId && now - lastPromotion.at < PROMOTION_COOLDOWN_MS) return;
  lastPromotion = { id: providerId, at: now };
  try {
    await admin.from("app_secrets").upsert({ key: "market_data_provider", value: providerId }, { onConflict: "key" });
  } catch {
    // non-fatal
  }
}

async function configSummary(): Promise<Record<string, unknown>> {
  const selected = await resolveSelectedProvider();
  const chain = await resolveProviderChain();
  const active = await resolveActiveProvider();
  const providers = await Promise.all(
    Object.values(PROVIDERS).map(async (p) => ({
      id: p.id,
      label: p.label,
      configured: p.keyless ? true : !!(await resolveApiKey(p.id)),
      keyless: !!p.keyless,
      source: p.source ?? (p.keyless ? "keyless" : "keyed"),
    })),
  );
  return {
    provider: selected,
    provider_label: PROVIDERS[selected]?.label ?? "Free market data",
    configured: providers.find((p) => p.id === selected)?.configured ?? false,
    providers,
    active_provider: active.id ?? selected,
    active_provider_label: active.label,
    fallback_available: chain.length > 1,
  };
}

// --- Twelve Data ---------------------------------------------------------------
interface TDQuote {
  status?: string;
  message?: string;
  symbol?: string;
  datetime?: string;
  open?: string | number;
  high?: string | number;
  low?: string | number;
  close?: string | number;
  previous_close?: string | number;
  change?: string | number;
  percent_change?: string | number;
  is_market_open?: boolean;
}

async function twelveDataQuote(apiKey: string, symbol: string): Promise<Quote> {
  const base: Quote = {
    symbol, price: null, change: null, percent_change: null, open: null, high: null, low: null,
    previous_close: null, is_market_open: isMarketOpen(symbol), datetime: null, error: null,
  };
  const params = new URLSearchParams({ symbol, apikey: apiKey });
  const res = await fetch(`${TD_BASE}/quote?${params.toString()}`);
  const data = (await res.json().catch(() => null)) as TDQuote | null;
  if (isRateLimited(res, data)) return { ...base, error: "rate_limited" };
  if (data?.status === "error") return { ...base, error: data.message ?? "upstream error" };
  const price = optNum(data?.close);
  if (price == null) return { ...base, error: "no data" };
  return {
    symbol, price,
    change: optNum(data?.change),
    percent_change: optNum(data?.percent_change),
    open: optNum(data?.open),
    high: optNum(data?.high),
    low: optNum(data?.low),
    previous_close: optNum(data?.previous_close),
    is_market_open: data?.is_market_open ?? isMarketOpen(symbol),
    datetime: data?.datetime ?? null,
  };
}

async function twelveDataTimeSeries(
  apiKey: string, symbol: string, interval: string, outputsize: number,
  startDate?: string, endDate?: string,
): Promise<{ bars: Bar[]; error?: string; rateLimited?: boolean }> {
  const params = new URLSearchParams({ symbol, interval, outputsize: String(outputsize), apikey: apiKey });
  if (startDate) params.set("start_date", startDate);
  if (endDate) params.set("end_date", endDate);
  const res = await fetch(`${TD_BASE}/time_series?${params.toString()}`);
  const data = (await res.json().catch(() => null)) as {
    status?: string; message?: string;
    values?: Array<{ datetime: string; open: string; high: string; low: string; close: string; volume: string }>;
  } | null;
  if (isRateLimited(res, data)) return { bars: [], error: "rate_limited", rateLimited: true };
  if (data?.status === "error") return { bars: [], error: data.message ?? "Upstream error." };
  const values = Array.isArray(data?.values) ? data.values : [];
  return {
    bars: values.map((v) => ({
      time: v.datetime, open: num(v.open), high: num(v.high), low: num(v.low), close: num(v.close),
      volume: v.volume ? num(v.volume) : undefined,
    })),
  };
}

// --- Finnhub --------------------------------------------------------------------
function finnhubSymbol(symbol: string): string {
  const [base, quote] = symbol.split("/");
  if (!base || !quote) return symbol;
  if (isCryptoSymbol(symbol)) return `BINANCE:${base}${quote === "USD" ? "USDT" : quote}`;
  return `OAN:${base}${quote}`;
}

const FH_RESOLUTIONS: Record<string, string> = {
  "1min": "1", "5min": "5", "15min": "15", "30min": "30", "1h": "60", "4h": "60", "1day": "D",
};

async function finnhubQuote(apiKey: string, symbol: string): Promise<Quote> {
  const base: Quote = {
    symbol, price: null, change: null, percent_change: null, open: null, high: null, low: null,
    previous_close: null, is_market_open: isMarketOpen(symbol), datetime: null, error: null,
  };
  try {
    const res = await fetch(`${FH_BASE}/quote?symbol=${encodeURIComponent(finnhubSymbol(symbol))}&token=${encodeURIComponent(apiKey)}`);
    const data = (await res.json().catch(() => null)) as { c?: number; pc?: number; o?: number; h?: number; l?: number; t?: number; error?: string } | null;
    if (data?.error) return { ...base, error: data.error };
    const price = optNum(data?.c);
    if (price == null) return { ...base, error: "no data" };
    const prev = optNum(data?.pc);
    const change = prev != null ? price - prev : null;
    return {
      ...base, price, change,
      percent_change: change != null && prev != null && prev !== 0 ? (change / prev) * 100 : null,
      open: optNum(data?.o), high: optNum(data?.h), low: optNum(data?.l), previous_close: prev,
      datetime: data?.t ? new Date(data.t * 1000).toISOString() : null,
    };
  } catch {
    return { ...base, error: "upstream error" };
  }
}

async function finnhubTimeSeries(
  apiKey: string, symbol: string, interval: string, outputsize: number,
  startDate?: string, endDate?: string,
): Promise<{ bars: Bar[]; error?: string; rateLimited?: boolean }> {
  const resolution = FH_RESOLUTIONS[interval] ?? "5";
  const path = isCryptoSymbol(symbol) ? "crypto" : "forex";
  const to = endDate ? Math.floor(new Date(endDate).getTime() / 1000) : Math.floor(Date.now() / 1000);
  const barSecs = resolution === "D" ? 86_400 : Number(resolution) * 60;
  const from = startDate ? Math.floor(new Date(startDate).getTime() / 1000) : to - Math.max(outputsize * barSecs, 60);
  try {
    const res = await fetch(
      `${FH_BASE}/${path}/candle?symbol=${encodeURIComponent(finnhubSymbol(symbol))}&resolution=${resolution}&from=${from}&to=${to}&token=${encodeURIComponent(apiKey)}`,
    );
    const data = (await res.json().catch(() => null)) as { s?: string; t?: number[]; o?: number[]; h?: number[]; l?: number[]; c?: number[]; v?: number[] } | null;
    if (data?.s !== "ok" || !Array.isArray(data.t) || data.t.length === 0) return { bars: [], error: "no data" };
    const barsPre: Bar[] = [];
    for (let i = 0; i < data.t.length; i++) {
      barsPre.push({
        time: new Date(data.t[i] * 1000).toISOString(),
        open: num(data.o?.[i]), high: num(data.h?.[i]), low: num(data.l?.[i]), close: num(data.c?.[i]),
        volume: data.v?.[i] != null ? num(data.v[i]) : undefined,
      });
    }
    let bars = interval === "4h" ? aggregateBars(barsPre, 4) : barsPre;
    bars = bars.slice(-outputsize);
    return { bars };
  } catch {
    return { bars: [], error: "upstream error" };
  }
}

// --- Alpha Vantage (keyed, free tier) ---------------------------------------------
async function alphaVantageQuote(apiKey: string, symbol: string): Promise<Quote> {
  const base: Quote = {
    symbol, price: null, change: null, percent_change: null, open: null, high: null, low: null,
    previous_close: null, is_market_open: isMarketOpen(symbol), datetime: null, error: null,
  };
  const [from, to] = symbol.split("/");
  if (!from || !to) return { ...base, error: "bad symbol" };
  try {
    const res = await fetch(`${AV_BASE}?function=CURRENCY_EXCHANGE_RATE&from_currency=${from}&to_currency=${to}&apikey=${encodeURIComponent(apiKey)}`);
    const data = (await res.json().catch(() => null)) as { "Realtime Currency Exchange Rate"?: Record<string, string>; "Error Message"?: string } | null;
    if (data?.["Error Message"]) return { ...base, error: data["Error Message"] };
    const rate = data?.["Realtime Currency Exchange Rate"];
    const price = optNum(rate?.["5. Exchange Rate"]);
    if (price == null) return { ...base, error: "no data" };
    const bid = optNum(rate?.["8. Bid Price"]);
    const ask = optNum(rate?.["9. Ask Price"]);
    return {
      ...base, price: bid != null && ask != null ? (bid + ask) / 2 : price,
      previous_close: price, datetime: rate?.["6. Last Refreshed"] ?? null,
    };
  } catch {
    return { ...base, error: "upstream error" };
  }
}

const AV_INTERVALS: Record<string, string> = {
  "1min": "1min", "5min": "5min", "15min": "15min", "30min": "30min", "1h": "60min", "4h": "60min",
};

async function alphaVantageTimeSeries(
  apiKey: string, symbol: string, interval: string, outputsize: number,
  _startDate?: string, _endDate?: string,
): Promise<{ bars: Bar[]; error?: string; rateLimited?: boolean }> {
  const [from, to] = symbol.split("/");
  if (!from || !to) return { bars: [], error: "bad symbol" };
  const isCrypto = isCryptoSymbol(symbol);
  const params = new URLSearchParams({ apikey: apiKey });
  try {
    if (isCrypto) {
      params.set("function", "CRYPTO_INTRADAY");
      params.set("symbol", from);
      params.set("market", to);
      params.set("interval", AV_INTERVALS[interval] ?? "5min");
    } else if (interval === "1day") {
      params.set("function", "FX_DAILY");
      params.set("from_symbol", from);
      params.set("to_symbol", to);
    } else {
      params.set("function", "FX_INTRADAY");
      params.set("from_symbol", from);
      params.set("to_symbol", to);
      params.set("interval", AV_INTERVALS[interval] ?? "5min");
    }
    params.set("outputsize", String(Math.min(outputsize, 1000)));
    const res = await fetch(`${AV_BASE}?${params.toString()}`);
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (data?.["Error Message"]) return { bars: [], error: String(data["Error Message"]) };
    const seriesKey = Object.keys(data ?? {}).find((k) => k.startsWith("Time Series"));
    const series = seriesKey ? (data?.[seriesKey] as Record<string, Record<string, string>> | undefined) : undefined;
    if (!series) return { bars: [], error: "no data" };
    let bars: Bar[] = Object.entries(series).map(([time, v]) => ({
      time,
      open: num(v["1. open"] ?? v["1a. open (USD)"]),
      high: num(v["2. high"] ?? v["2a. high (USD)"]),
      low: num(v["3. low"] ?? v["3a. low (USD)"]),
      close: num(v["4. close"] ?? v["4a. close (USD)"]),
      volume: v["5. volume"] ? num(v["5. volume"]) : undefined,
    }));
    bars.sort((a, b) => a.time.localeCompare(b.time));
    if (interval === "4h") bars = aggregateBars(bars, 4);
    bars = bars.slice(-outputsize);
    return { bars };
  } catch {
    return { bars: [], error: "upstream error" };
  }
}

// --- Polygon.io (keyed, free tier) -----------------------------------------------
function polygonTicker(symbol: string): string {
  const [from, to] = symbol.split("/");
  if (!from || !to) return symbol;
  return isCryptoSymbol(symbol) ? `X:${from}${to}` : `C:${from}${to}`;
}

async function polygonQuote(apiKey: string, symbol: string): Promise<Quote> {
  const base: Quote = {
    symbol, price: null, change: null, percent_change: null, open: null, high: null, low: null,
    previous_close: null, is_market_open: isMarketOpen(symbol), datetime: null, error: null,
  };
  const ticker = polygonTicker(symbol);
  try {
    const [lastRes, prevRes] = await Promise.all([
      fetch(`${POLY_BASE}/v2/last/trade/${ticker}?apiKey=${encodeURIComponent(apiKey)}`),
      fetch(`${POLY_BASE}/v2/aggs/ticker/${ticker}/prev?apiKey=${encodeURIComponent(apiKey)}`),
    ]);
    const lastData = (await lastRes.json().catch(() => null)) as { results?: { price?: number; timestamp?: number } };
    const prevData = (await prevRes.json().catch(() => null)) as { results?: Array<{ c?: number }> };
    const price = optNum(lastData?.results?.price);
    if (price == null) return { ...base, error: "no data" };
    const prev = optNum(prevData?.results?.[0]?.c);
    const change = prev != null ? price - prev : null;
    return {
      ...base, price, change,
      percent_change: change != null && prev != null && prev !== 0 ? (change / prev) * 100 : null,
      previous_close: prev,
      datetime: lastData?.results?.timestamp ? new Date(lastData.results.timestamp).toISOString() : null,
    };
  } catch {
    return { ...base, error: "upstream error" };
  }
}

const POLY_TIMESPAN: Record<string, { mult: number; span: string }> = {
  "1min": { mult: 1, span: "minute" }, "5min": { mult: 5, span: "minute" }, "15min": { mult: 15, span: "minute" },
  "30min": { mult: 30, span: "minute" }, "1h": { mult: 1, span: "hour" }, "4h": { mult: 4, span: "hour" },
  "1day": { mult: 1, span: "day" },
};

async function polygonTimeSeries(
  apiKey: string, symbol: string, interval: string, outputsize: number,
  startDate?: string, endDate?: string,
): Promise<{ bars: Bar[]; error?: string; rateLimited?: boolean }> {
  const ticker = polygonTicker(symbol);
  const { mult, span } = POLY_TIMESPAN[interval] ?? { mult: 5, span: "minute" };
  const spanMs = span === "day" ? 86_400_000 : span === "hour" ? 3_600_000 : 60_000;
  const to = endDate ? Math.floor(new Date(endDate).getTime() / 1000) : Math.floor(Date.now() / 1000);
  const from = startDate ? Math.floor(new Date(startDate).getTime() / 1000) : to - Math.max(outputsize * mult * (spanMs / 1000), 60);
  try {
    const res = await fetch(
      `${POLY_BASE}/v2/aggs/ticker/${ticker}/range/${mult}/${span}/${from}/${to}?adjusted=true&sort=asc&limit=${Math.min(outputsize, 5000)}&apiKey=${encodeURIComponent(apiKey)}`,
    );
    const data = (await res.json().catch(() => null)) as { results?: Array<{ t: number; o: number; h: number; l: number; c: number; v?: number }> };
    const rows = data?.results ?? [];
    if (rows.length === 0) return { bars: [], error: "no data" };
    let bars: Bar[] = rows.map((r) => ({
      time: new Date(r.t).toISOString(),
      open: num(r.o), high: num(r.h), low: num(r.l), close: num(r.c),
      volume: r.v != null ? num(r.v) : undefined,
    }));
    if (interval === "4h") bars = aggregateBars(bars, 4);
    bars = bars.slice(-outputsize);
    return { bars };
  } catch {
    return { bars: [], error: "upstream error" };
  }
}

// --- Yahoo Finance (keyless, free) ------------------------------------------------
function yahooSymbol(symbol: string): string {
  const [from, to] = symbol.split("/");
  if (!from || !to) return symbol;
  return isCryptoSymbol(symbol) ? `${from}-${to}` : `${from}${to}=X`;
}

async function yahooQuote(_apiKey: string, symbol: string): Promise<Quote> {
  const base: Quote = {
    symbol, price: null, change: null, percent_change: null, open: null, high: null, low: null,
    previous_close: null, is_market_open: isMarketOpen(symbol), datetime: null, error: null,
  };
  try {
    const res = await fetch(`${YH_BASE}/${encodeURIComponent(yahooSymbol(symbol))}?interval=1d&range=1d`, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; FXToolkit/1.0)" },
    });
    const data = (await res.json().catch(() => null)) as {
      chart?: { result?: Array<{ meta?: { regularMarketPrice?: number; chartPreviousClose?: number; regularMarketDayHigh?: number; regularMarketDayLow?: number; regularMarketOpen?: number; regularMarketTime?: number } }> };
    };
    const meta = data?.chart?.result?.[0]?.meta;
    const price = optNum(meta?.regularMarketPrice);
    if (price == null) return { ...base, error: "no data" };
    const prev = optNum(meta?.chartPreviousClose);
    const change = prev != null ? price - prev : null;
    return {
      ...base, price, change,
      percent_change: change != null && prev != null && prev !== 0 ? (change / prev) * 100 : null,
      open: optNum(meta?.regularMarketOpen),
      high: optNum(meta?.regularMarketDayHigh),
      low: optNum(meta?.regularMarketDayLow),
      previous_close: prev,
      datetime: meta?.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : null,
    };
  } catch {
    return { ...base, error: "upstream error" };
  }
}

const YH_INTERVALS: Record<string, string> = {
  "1min": "1m", "5min": "5m", "15min": "15m", "30min": "30m", "1h": "60m", "4h": "60m", "1day": "1d",
};
const YH_RANGES: Record<string, string> = {
  "1min": "1d", "5min": "5d", "15min": "5d", "30min": "1mo", "1h": "1mo", "4h": "3mo", "1day": "1y",
};

async function yahooTimeSeries(
  _apiKey: string, symbol: string, interval: string, outputsize: number,
  startDate?: string, endDate?: string,
): Promise<{ bars: Bar[]; error?: string; rateLimited?: boolean }> {
  const iv = YH_INTERVALS[interval] ?? "5m";
  const range = YH_RANGES[interval] ?? "5d";
  try {
    const res = await fetch(`${YH_BASE}/${encodeURIComponent(yahooSymbol(symbol))}?interval=${iv}&range=${range}`, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; FXToolkit/1.0)" },
    });
    const data = (await res.json().catch(() => null)) as {
      chart?: { result?: Array<{ timestamp?: number[]; indicators?: { quote?: Array<{ open?: (number | null)[]; high?: (number | null)[]; low?: (number | null)[]; close?: (number | null)[]; volume?: (number | null)[] }> } }> };
    };
    const result = data?.chart?.result?.[0];
    const q = result?.indicators?.quote?.[0];
    const ts = result?.timestamp ?? [];
    if (!ts.length || !q) return { bars: [], error: "no data" };
    let bars: Bar[] = [];
    for (let i = 0; i < ts.length; i++) {
      const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
      if (o == null || h == null || l == null || c == null) continue;
      const v = q.volume?.[i];
      bars.push({ time: new Date(ts[i] * 1000).toISOString(), open: o, high: h, low: l, close: c, volume: v != null ? v : undefined });
    }
    if (interval === "4h") bars = aggregateBars(bars, 4);
    bars = bars.slice(-outputsize);
    return { bars };
  } catch {
    return { bars: [], error: "upstream error" };
  }
}

// --- Free keyless (Binance for crypto + Yahoo for FX/metals) ------------------------
function binanceSymbol(symbol: string): string {
  const [from, to] = symbol.split("/");
  if (!from) return symbol;
  const quote = to && to.trim().toUpperCase() !== "USD" ? to.trim().toUpperCase() : "USDT";
  return `${from.toUpperCase()}${quote}`;
}

const BN_INTERVALS: Record<string, string> = {
  "1min": "1m", "5min": "5m", "15min": "15m", "30min": "30m", "1h": "1h", "4h": "4h", "1day": "1d",
};

async function binanceQuote(_apiKey: string, symbol: string): Promise<Quote> {
  const base: Quote = {
    symbol, price: null, change: null, percent_change: null, open: null, high: null, low: null,
    previous_close: null, is_market_open: isMarketOpen(symbol), datetime: null, error: null,
  };
  try {
    const res = await fetch(`${BN_BASE}/ticker/24hr?symbol=${encodeURIComponent(binanceSymbol(symbol))}`);
    if (res.status === 429 || res.status === 418) return { ...base, error: "rate_limited" };
    const data = (await res.json().catch(() => null)) as {
      lastPrice?: string; openPrice?: string; highPrice?: string; lowPrice?: string; prevClosePrice?: string;
      priceChange?: string; priceChangePercent?: string; closeTime?: number; code?: number;
    } | null;
    if (data?.code || typeof data?.lastPrice !== "string") return { ...base, error: "no data" };
    const price = num(data.lastPrice);
    if (price <= 0) return { ...base, error: "no data" };
    return {
      symbol, price, change: optNum(data.priceChange), percent_change: optNum(data.priceChangePercent),
      open: optNum(data.openPrice), high: optNum(data.highPrice), low: optNum(data.lowPrice),
      previous_close: optNum(data.prevClosePrice), is_market_open: true,
      datetime: data.closeTime ? new Date(data.closeTime).toISOString() : null,
    };
  } catch {
    return { ...base, error: "upstream error" };
  }
}

async function binanceBatchQuote(symbols: string[]): Promise<Map<string, Quote>> {
  const out = new Map<string, Quote>();
  const unique = [...new Set(symbols)];
  if (unique.length === 0) return out;
  const reverse = new Map<string, string>();
  for (const s of unique) reverse.set(binanceSymbol(s), s);
  const batch = [...reverse.keys()].slice(0, 100);
  try {
    const res = await fetch(`${BN_BASE}/ticker?symbols=${encodeURIComponent(JSON.stringify(batch))}`);
    if (res.status === 429 || res.status === 418) return out;
    const data = (await res.json().catch(() => null)) as
      | Array<{ symbol?: string; lastPrice?: string; openPrice?: string; highPrice?: string; lowPrice?: string; prevClosePrice?: string; priceChange?: string; priceChangePercent?: string; closeTime?: number }>
      | { code?: number; msg?: string }
      | null;
    if (!Array.isArray(data)) return out;
    for (const d of data) {
      const orig = d.symbol ? reverse.get(d.symbol) : undefined;
      if (!orig) continue;
      const price = num(d.lastPrice ?? "");
      if (price <= 0) continue;
      out.set(orig, {
        symbol: orig, price, change: optNum(d.priceChange), percent_change: optNum(d.priceChangePercent),
        open: optNum(d.openPrice), high: optNum(d.highPrice), low: optNum(d.lowPrice),
        previous_close: optNum(d.prevClosePrice), is_market_open: true,
        datetime: d.closeTime ? new Date(d.closeTime).toISOString() : null,
      });
    }
  } catch {
    // non-fatal — caller falls back to Yahoo
  }
  return out;
}

async function binanceTimeSeries(
  _apiKey: string, symbol: string, interval: string, outputsize: number,
  startDate?: string, endDate?: string,
): Promise<{ bars: Bar[]; error?: string; rateLimited?: boolean }> {
  const params = new URLSearchParams({ symbol: binanceSymbol(symbol), interval: BN_INTERVALS[interval] ?? "5m" });
  if (startDate) params.set("startTime", String(new Date(startDate).getTime()));
  if (endDate) params.set("endTime", String(new Date(endDate).getTime()));
  params.set("limit", String(Math.min(outputsize, 1000)));
  try {
    const res = await fetch(`${BN_BASE}/klines?${params.toString()}`);
    if (res.status === 429 || res.status === 418) return { bars: [], error: "rate_limited", rateLimited: true };
    const data = (await res.json().catch(() => null)) as unknown[] | { code?: number } | null;
    if (!Array.isArray(data) || data.length === 0) return { bars: [], error: "no data" };
    return {
      bars: (data as Array<Array<number | string>>).map((k) => ({
        time: new Date(Number(k[0])).toISOString(), open: num(k[1]), high: num(k[2]), low: num(k[3]), close: num(k[4]),
        volume: k[5] != null ? num(k[5]) : undefined,
      })),
    };
  } catch {
    return { bars: [], error: "upstream error" };
  }
}

async function freeQuote(_apiKey: string, symbol: string): Promise<Quote> {
  if (isCryptoSymbol(symbol)) {
    const bin = await binanceQuote("", symbol);
    if (!bin.error && bin.price != null) return bin;
  }
  return yahooQuote("", symbol);
}

async function freeTimeSeries(
  _apiKey: string, symbol: string, interval: string, outputsize: number,
  startDate?: string, endDate?: string,
): Promise<{ bars: Bar[]; error?: string; rateLimited?: boolean }> {
  if (isCryptoSymbol(symbol)) {
    const bin = await binanceTimeSeries("", symbol, interval, outputsize, startDate, endDate);
    if (!bin.error && bin.bars.length > 0) return bin;
  }
  return yahooTimeSeries("", symbol, interval, outputsize, startDate, endDate);
}

// --- OANDA (broker-derived) -----------------------------------------------------------
async function oandaSource(): Promise<{ base: string; account: string } | null> {
  if (!admin) return null;
  const { data } = await admin.from("app_secrets").select("key,value").in("key", ["market_data_oanda_account", "market_data_oanda_env"]);
  const map = new Map<string, string>((data ?? []).map((r) => [String(r.key), String(r.value ?? "")]));
  const account = map.get("market_data_oanda_account") ?? "";
  const env = map.get("market_data_oanda_env") ?? "practice";
  if (!account) return null;
  return { base: env === "live" ? OANDA_LIVE : OANDA_PRACTICE, account };
}

function oandaInstrument(symbol: string): string {
  return symbol.trim().toUpperCase().replace("/", "_");
}

async function oandaQuote(apiKey: string, symbol: string): Promise<Quote> {
  const base: Quote = {
    symbol, price: null, change: null, percent_change: null, open: null, high: null, low: null,
    previous_close: null, is_market_open: isMarketOpen(symbol), datetime: null, error: null,
  };
  const src = await oandaSource();
  if (!src) return { ...base, error: "broker source not configured" };
  try {
    const res = await fetch(`${src.base}/v3/accounts/${src.account}/pricing?instruments=${encodeURIComponent(oandaInstrument(symbol))}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const data = (await res.json().catch(() => null)) as { prices?: Array<{ bids?: Array<{ price: string }>; asks?: Array<{ price: string }>; time?: string }> };
    const p = data?.prices?.[0];
    const bid = optNum(p?.bids?.[0]?.price);
    const ask = optNum(p?.asks?.[0]?.price);
    if (bid == null || ask == null) return { ...base, error: "no data" };
    return { ...base, price: (bid + ask) / 2, datetime: p?.time ?? null };
  } catch {
    return { ...base, error: "upstream error" };
  }
}

const OANDA_GRANULARITY: Record<string, string> = {
  "1min": "M1", "5min": "M5", "15min": "M15", "30min": "M30", "1h": "H1", "4h": "H4", "1day": "D",
};

async function oandaTimeSeries(
  apiKey: string, symbol: string, interval: string, outputsize: number,
  _startDate?: string, _endDate?: string,
): Promise<{ bars: Bar[]; error?: string; rateLimited?: boolean }> {
  const src = await oandaSource();
  if (!src) return { bars: [], error: "broker source not configured" };
  try {
    const res = await fetch(
      `${src.base}/v3/instruments/${encodeURIComponent(oandaInstrument(symbol))}/candles?granularity=${OANDA_GRANULARITY[interval] ?? "M5"}&count=${Math.min(outputsize, 5000)}&price=M`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
    );
    const data = (await res.json().catch(() => null)) as { candles?: Array<{ time?: string; mid?: { o?: string; h?: string; l?: string; c?: string }; volume?: number }> };
    const candles = data?.candles ?? [];
    if (candles.length === 0) return { bars: [], error: "no data" };
    let bars: Bar[] = candles.filter((c) => c.mid?.o != null).map((c) => ({
      time: c.time ?? "", open: num(c.mid?.o), high: num(c.mid?.h), low: num(c.mid?.l), close: num(c.mid?.c),
      volume: c.volume != null ? num(c.volume) : undefined,
    }));
    bars = bars.slice(-outputsize);
    return { bars };
  } catch {
    return { bars: [], error: "upstream error" };
  }
}

// --- Provider registry ---------------------------------------------------------------
const PROVIDERS: Record<string, MarketProvider> = {
  twelvedata: {
    id: "twelvedata", label: "Twelve Data", signupUrl: "https://twelvedata.com", envKey: "TWELVE_DATA_API_KEY",
    validate: async () => null, fetchQuote: twelveDataQuote, fetchTimeSeries: twelveDataTimeSeries,
  },
  finnhub: {
    id: "finnhub", label: "Finnhub", signupUrl: "https://finnhub.io", envKey: "FINNHUB_API_KEY",
    validate: async () => null, fetchQuote: finnhubQuote, fetchTimeSeries: finnhubTimeSeries,
  },
  alphavantage: {
    id: "alphavantage", label: "Alpha Vantage", signupUrl: "https://www.alphavantage.co", envKey: "ALPHA_VANTAGE_API_KEY",
    validate: async () => null, fetchQuote: alphaVantageQuote, fetchTimeSeries: alphaVantageTimeSeries,
  },
  polygon: {
    id: "polygon", label: "Polygon.io", signupUrl: "https://polygon.io", envKey: "POLYGON_API_KEY",
    validate: async () => null, fetchQuote: polygonQuote, fetchTimeSeries: polygonTimeSeries,
  },
  yahoo: {
    id: "yahoo", label: "Free market data", signupUrl: "https://www.binance.com", envKey: "", keyless: true, source: "keyless",
    validate: async () => null, fetchQuote: freeQuote, fetchTimeSeries: freeTimeSeries,
  },
  oanda: {
    id: "oanda", label: "OANDA (broker trader account)", signupUrl: "https://www.oanda.com", envKey: "OANDA_API_KEY", source: "broker",
    validate: async () => "OANDA market data is generated from your broker trader account — not a pasted key.",
    fetchQuote: oandaQuote, fetchTimeSeries: oandaTimeSeries,
  },
};

// --- Market config / free activation / broker source ----------------------------------
async function handleMarketConfig(): Promise<Response> {
  return json(await configSummary());
}

async function handleActivateFree(): Promise<Response> {
  if (!admin) return json({ error: "internal", message: "Market data service is not configured." }, 500);
  for (const id of Object.keys(PROVIDERS)) {
    const p = PROVIDERS[id];
    if (p.keyless) continue;
    if (await resolveApiKey(id)) {
      return json({
        error: "already_configured",
        message: `Your platform is already on ${p.label} — free market data stays available as its automatic fallback.`,
      });
    }
  }
  await admin.from("app_secrets").upsert({ key: "market_data_provider", value: "yahoo" }, { onConflict: "key" });
  apiKeyCache = null;
  return json({
    ok: true,
    message: "Free market data is now the main source — quotes, charts and the robot use it automatically.",
    ...(await configSummary()),
  });
}

async function handleReconfigure(): Promise<Response> {
  if (!admin) return json({ error: "internal", message: "Market data service is not configured." }, 500);
  try {
    const q = await yahooQuote("", "EUR/USD");
    if (q?.error || q?.price == null) {
      return json({ error: "upstream", message: "The free feeds (Yahoo / Binance) are unreachable right now — reconfigure failed." }, 502);
    }
  } catch {
    return json({ error: "upstream", message: "The free feeds (Yahoo / Binance) are unreachable right now — reconfigure failed." }, 502);
  }
  for (const id of Object.keys(PROVIDERS)) {
    const p = PROVIDERS[id];
    if (p.keyless) continue;
    if (await resolveApiKey(id)) {
      return json({
        ok: true,
        message: `Config verified — quotes are live. Your keyed provider (${p.label}) stays the main source; the free feed remains its automatic fallback.`,
        fetched: 1,
        ...(await configSummary()),
      });
    }
  }
  await admin.from("app_secrets").upsert({ key: "market_data_provider", value: "yahoo" }, { onConflict: "key" });
  apiKeyCache = null;
  return json({
    ok: true,
    message: "API settings reconfigured in one click — free market data (Binance + Yahoo) is now the active source and quotes are live.",
    fetched: 1,
    injected: true,
    ...(await configSummary()),
  });
}

async function handleSetApiKey(body: Record<string, unknown>): Promise<Response> {
  const providerId = String(body.provider ?? "twelvedata");
  const provider = PROVIDERS[providerId];
  if (!provider) return json({ error: "bad_request", message: "Unknown market data provider." }, 400);
  if (provider.keyless) {
    return json({ error: "bad_request", message: `${provider.label} needs no API key — it's a free, keyless source.` }, 400);
  }
  if (provider.source === "broker") {
    return json({ error: "bad_request", message: "This source is generated from your broker trader account — no key to paste here." }, 400);
  }
  const value = String(body.api_key ?? "").trim();
  if (!value) return json({ error: "bad_request", message: "Enter the API key." }, 400);
  if (value.length < 8) {
    return json({ error: "bad_request", message: `That doesn't look like a valid ${provider.label} API key.` }, 400);
  }
  const validationError = await provider.validate(value);
  if (validationError) return json({ error: "invalid_key", message: validationError }, 400);
  if (!admin) return json({ error: "internal", message: "Market data service is not configured." }, 500);
  const { error } = await admin.from("app_secrets").upsert({ key: `market_data_${providerId}`, value }, { onConflict: "key" });
  if (error) return json({ error: "internal", message: "Could not save the API key." }, 500);
  await admin.from("app_secrets").upsert({ key: "market_data_provider", value: providerId }, { onConflict: "key" });
  apiKeyCache = { provider: providerId, key: value, at: Date.now() };
  return json({ ok: true, configured: true, provider: providerId, provider_label: provider.label });
}

async function handleDisconnect(providerId: string): Promise<Response> {
  const provider = PROVIDERS[providerId];
  if (!provider) return json({ error: "bad_request", message: "Unknown market data provider." }, 400);
  if (!admin) return json({ error: "internal", message: "Market data service is not configured." }, 500);
  const { error: delErr } = await admin.from("app_secrets").delete().eq("key", `market_data_${providerId}`);
  if (delErr) return json({ error: "internal", message: "Could not disconnect the provider." }, 500);
  if ((await resolveSelectedProvider()) === providerId) {
    await admin.from("app_secrets").delete().eq("key", "market_data_provider");
  }
  apiKeyCache = null;
  return json({ ok: true, configured: false, provider: providerId, provider_label: provider.label });
}

async function handleSetBrokerSource(req: Request): Promise<Response> {
  if (!admin) return json({ error: "internal", message: "Market data service is not configured." }, 500);
  const authHeader = req.headers.get("Authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  const payload = decodeJwtPayload(token);
  const userId = typeof payload?.sub === "string" ? payload.sub : "";
  if (!userId) return json({ error: "unauthorized" }, 401);

  const { data: broker } = await admin.from("brokers").select("id, slug, live_url, practice_url").eq("slug", "oanda").maybeSingle();
  if (!broker) return json({ error: "bad_request", message: "OANDA is not in the broker catalog." }, 400);

  const { data: conn } = await admin
    .from("broker_connections")
    .select("api_key, account_id, account_type")
    .eq("user_id", userId)
    .eq("broker_id", broker.id)
    .maybeSingle();
  if (!conn?.api_key) {
    return json({ error: "bad_request", message: "Connect your OANDA broker trader account on the Brokers page first." }, 400);
  }
  const { data: decrypted, error: decryptErr } = await admin.rpc("decrypt_broker_cred", { p_enc: conn.api_key });
  if (decryptErr || !decrypted) return json({ error: "internal", message: "Could not read your broker credentials." }, 500);
  const apiKey = String(decrypted);
  const accountId = String(conn.account_id ?? "");
  if (!accountId) return json({ error: "bad_request", message: "Add an OANDA account id on the Brokers page so market data can be generated." }, 400);
  const base = conn.account_type === "live" ? broker.live_url : broker.practice_url;

  const probe = await fetch(`${base}/v3/accounts/${encodeURIComponent(accountId)}/pricing?instruments=EUR_USD`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!probe.ok) {
    return json({ error: "bad_request", message: "OANDA rejected this account — check the API token and account id." }, 400);
  }

  await admin.from("app_secrets").upsert({ key: "market_data_oanda", value: apiKey }, { onConflict: "key" });
  await admin.from("app_secrets").upsert({ key: "market_data_oanda_account", value: accountId }, { onConflict: "key" });
  await admin.from("app_secrets").upsert(
    { key: "market_data_oanda_env", value: conn.account_type === "live" ? "live" : "practice" },
    { onConflict: "key" },
  );
  const selected = await resolveSelectedProvider();
  const selectedKey = await resolveApiKey(selected);
  let activated = false;
  if (selected === "oanda" || !selectedKey) {
    await admin.from("app_secrets").upsert({ key: "market_data_provider", value: "oanda" }, { onConflict: "key" });
    activated = true;
  }
  apiKeyCache = null;
  return json({ ok: true, provider: "oanda", provider_label: "OANDA", activated, market_data_ready: true });
}

// --- Quotes & time-series core ----------------------------------------------------
async function broadcastQuotes(quotes: Quote[], anyStale: boolean): Promise<void> {
  if (!SUPABASE_URL || !ADMIN_KEY || !Array.isArray(quotes) || quotes.length === 0) return;
  try {
    await fetch(`${SUPABASE_URL}/realtime/v1/api/broadcast`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: ADMIN_KEY },
      body: JSON.stringify({ messages: [{ topic: "market-quotes", event: "quotes", payload: { quotes, anyStale, at: Date.now() } }] }),
    });
  } catch {
    // non-fatal
  }
}

async function handleQuotes(providerId: string, apiKey: string, priority: string[] = []): Promise<Response> {
  const provider = PROVIDERS[providerId];
  const cacheKeys = WATCHLIST.map((s) => `quote:${providerId}:${s}`);
  const cache = await cacheGetMany(cacheKeys);

  const now = Date.now();
  const keyless = !!provider.keyless;
  const freshMs = keyless ? QUOTES_FRESH_FREE_MS : QUOTES_FRESH_MS;
  const quotes: Quote[] = [];
  let served = 0;
  let anyStale = false;

  const toRefresh: { symbol: string; age: number }[] = [];
  for (const symbol of WATCHLIST) {
    const row = cache.get(`quote:${providerId}:${symbol}`);
    const payload = (row?.payload ?? memoryCache.get(`quote:${providerId}:${symbol}`)?.value) as Quote | undefined;
    const updatedAt = row ? new Date(row.updated_at).getTime() : (memoryCache.get(`quote:${providerId}:${symbol}`)?.at ?? 0);
    if (payload && payload.symbol) {
      const age = now - updatedAt;
      const fresh = age <= freshMs;
      quotes.push({ ...payload, stale: fresh ? payload.stale : true });
      if (!fresh) anyStale = true;
      served++;
      if (!fresh) toRefresh.push({ symbol, age });
    } else {
      toRefresh.push({ symbol, age: Number.MAX_SAFE_INTEGER });
      quotes.push({
        symbol, price: null, change: null, percent_change: null, open: null, high: null, low: null,
        previous_close: null, is_market_open: isMarketOpen(symbol), datetime: null, stale: true, error: "no data yet",
      });
    }
  }

  const prioritySet = new Set(priority.map((s) => s.toUpperCase()));
  toRefresh.sort((a, b) => {
    const ap = prioritySet.has(a.symbol) ? 0 : 1;
    const bp = prioritySet.has(b.symbol) ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return b.age - a.age;
  });
  let refreshed = 0;
  let upstreamBlocked = false;

  const applyQuote = async (symbol: string, q: Quote) => {
    if (q.error) return false;
    await cacheSet(`quote:${providerId}:${symbol}`, { ...q, stale: false });
    const idx = quotes.findIndex((x) => x.symbol === symbol);
    if (idx >= 0) quotes[idx] = { ...q, stale: false };
    return true;
  };

  if (keyless) {
    const cryptoStale = toRefresh.filter(({ symbol }) => isCryptoSymbol(symbol));
    const fxStale = toRefresh.filter(({ symbol }) => !isCryptoSymbol(symbol));
    let fxRefreshed = 0;

    const priorityFx = fxStale.filter((s) => prioritySet.has(s.symbol)).slice(0, FREE_FX_BUDGET);
    if (priorityFx.length > 0) {
      const credits = priorityFx.filter(() => canUseCredit());
      const settled = await Promise.allSettled(credits.map((s) => provider.fetchQuote("", s.symbol)));
      for (let i = 0; i < credits.length; i++) {
        const q = settled[i]?.status === "fulfilled" ? settled[i].value : null;
        if (q && (await applyQuote(credits[i].symbol, q))) {
          refreshed++;
          fxRefreshed++;
        }
      }
    }

    if (cryptoStale.length > 0 && canUseFreeBatch()) {
      const batch = await binanceBatchQuote(cryptoStale.map((x) => x.symbol));
      if (batch.size > 0) {
        for (const [symbol, q] of batch) {
          if (await applyQuote(symbol, q)) refreshed++;
        }
        anyStale = false;
      }
      const missing = cryptoStale.filter((x) => !batch.has(x.symbol));
      for (const { symbol } of missing) {
        if (!canUseCredit()) break;
        const q = await yahooQuote("", symbol);
        if (await applyQuote(symbol, q)) refreshed++;
      }
    }

    const remainingFx = fxStale.filter((s) => !prioritySet.has(s.symbol) && fxRefreshed + 1 <= FREE_FX_BUDGET);
    if (remainingFx.length > 0) {
      const budget = remainingFx.slice(0, Math.max(0, FREE_FX_BUDGET - fxRefreshed));
      const credits = budget.filter(() => canUseCredit());
      const settled = await Promise.allSettled(credits.map((s) => provider.fetchQuote("", s.symbol)));
      for (let i = 0; i < credits.length; i++) {
        const q = settled[i]?.status === "fulfilled" ? settled[i].value : null;
        if (q && (await applyQuote(credits[i].symbol, q))) {
          refreshed++;
          fxRefreshed++;
        }
      }
    }
  } else {
    const budget = toRefresh.slice(0, QUOTES_REFRESH_BUDGET);
    for (const { symbol } of budget) {
      if (!canUseCredit() || !(await claimUpstreamSlot())) {
        upstreamBlocked = true;
        break;
      }
      try {
        const q = await provider.fetchQuote(apiKey, symbol);
        if (!q.error) {
          await applyQuote(symbol, q);
          anyStale = false;
          refreshed++;
        } else if (q.error === "rate_limited") {
          upstreamBlocked = true;
          break;
        } else {
          const idx = quotes.findIndex((x) => x.symbol === symbol);
          if (idx >= 0) quotes[idx] = { ...quotes[idx], error: q.error };
        }
      } catch {
        upstreamBlocked = true;
        break;
      }
    }
  }

  if (refreshed === 0 && served === 0 && upstreamBlocked) return json({ error: "rate_limited" });
  if (refreshed === 0 && served === 0) return json({ error: "upstream", message: "Market data is unavailable right now." });

  if (refreshed > 0) await broadcastQuotes(quotes, anyStale);
  return json({ quotes, anyStale });
}

async function handleTimeSeries(providerId: string, apiKey: string, body: Record<string, unknown>): Promise<Response> {
  const provider = PROVIDERS[providerId];
  const symbol = String(body.symbol ?? "").toUpperCase();
  const interval = VALID_INTERVALS.includes(String(body.interval)) ? String(body.interval) : "1day";
  const outputsize = Math.min(Math.max(Number(body.outputsize) || 500, 1), MAX_OUTPUTSIZE);
  const start_date = body.start_date ? String(body.start_date) : undefined;
  const end_date = body.end_date ? String(body.end_date) : undefined;
  if (!symbol) return json({ error: "bad_request", message: "Missing symbol." }, 400);

  const cacheKey = `ts:${providerId}:${symbol}:${interval}:${outputsize}:${start_date ?? ""}:${end_date ?? ""}`;
  const ttl = TTL_MS[interval] ?? 5 * 60_000;
  const row = (await cacheGetMany([cacheKey])).get(cacheKey);
  const payload = (row?.payload ?? memoryCache.get(cacheKey)?.value) as Bar[] | undefined;
  const updatedAt = row ? new Date(row.updated_at).getTime() : (memoryCache.get(cacheKey)?.at ?? 0);

  if (payload && Array.isArray(payload) && Date.now() - updatedAt <= ttl) {
    return json({ bars: normalizeBars(payload, outputsize) });
  }
  if (!canUseCredit() || !(await claimUpstreamSlot())) {
    if (payload && Array.isArray(payload)) return json({ bars: normalizeBars(payload, outputsize), stale: true });
    return json({ error: "rate_limited" });
  }
  const res = await provider.fetchTimeSeries(apiKey, symbol, interval, outputsize, start_date, end_date);
  if (res.rateLimited) {
    if (payload && Array.isArray(payload)) return json({ bars: normalizeBars(payload, outputsize), stale: true });
    return json({ error: "rate_limited" });
  }
  if (res.error) {
    if (payload && Array.isArray(payload)) return json({ bars: normalizeBars(payload, outputsize), stale: true });
    return json({ error: "upstream", message: res.error ?? "Upstream error." });
  }
  const bars = normalizeBars(res.bars, outputsize);
  await cacheSet(cacheKey, bars);
  return json({ bars });
}

async function handleQuotesWithFallback(chain: string[], priority: string[]): Promise<Response> {
  let lastError: { error: string; message?: string } | null = null;
  for (const providerId of chain) {
    const provider = PROVIDERS[providerId];
    const apiKey = provider.keyless ? "" : (await resolveApiKey(providerId)) ?? "";
    if (!provider.keyless && !apiKey) {
      lastError = { error: "no_api_key" };
      continue;
    }
    const res = await handleQuotes(providerId, apiKey, priority);
    const body = (await res.json().catch(() => ({ error: "upstream" }))) as {
      error?: string; message?: string; quotes?: Quote[]; anyStale?: boolean;
    };
    if (!body.error && Array.isArray(body.quotes) && body.quotes.length > 0) {
      if (providerId !== chain[0]) await maybePromoteProvider(providerId);
      return json({
        quotes: body.quotes,
        anyStale: body.anyStale ?? false,
        provider: providerId,
        provider_label: provider.label,
        source: provider.source ?? "keyed",
      });
    }
    lastError = { error: body.error ?? "upstream", message: body.message };
  }
  return json(lastError ?? { error: "upstream", message: "Market data is unavailable right now." });
}

async function handleTimeSeriesWithFallback(chain: string[], body: Record<string, unknown>): Promise<Response> {
  let lastError: { error: string; message?: string } | null = null;
  for (const providerId of chain) {
    const provider = PROVIDERS[providerId];
    const apiKey = provider.keyless ? "" : (await resolveApiKey(providerId)) ?? "";
    if (!provider.keyless && !apiKey) {
      lastError = { error: "no_api_key" };
      continue;
    }
    const res = await handleTimeSeries(providerId, apiKey, body);
    const parsed = (await res.json().catch(() => ({ error: "upstream" }))) as {
      error?: string; message?: string; bars?: Bar[]; stale?: boolean;
    };
    if (!parsed.error && Array.isArray(parsed.bars)) {
      if (providerId !== chain[0]) await maybePromoteProvider(providerId);
      return json({
        bars: parsed.bars,
        stale: parsed.stale ?? false,
        provider: providerId,
        provider_label: provider.label,
        source: provider.keyless ? "keyless" : "keyed",
      });
    }
    lastError = { error: parsed.error ?? "upstream", message: parsed.message };
  }
  return json(lastError ?? { error: "upstream", message: "Market data is unavailable right now." });
}

// --- Handler ---
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const authorized = await isAuthorized(req);
    if (!authorized) return json({ error: "unauthorized" }, 401);
    let body: Record<string, unknown> = {};
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return json({ error: "bad_request", message: "Invalid JSON body." }, 400);
    }

    if (body.action === "market_config") return await handleMarketConfig();
    if (body.action === "activate_free") {
      if (!(await hasSession(req))) return json({ error: "unauthorized" }, 401);
      return await handleActivateFree();
    }
    if (body.action === "reconfigure") {
      if (!(await hasSession(req))) return json({ error: "unauthorized" }, 401);
      return await handleReconfigure();
    }
    if (body.action === "set_api_key" || body.action === "disconnect" || body.action === "set_broker_source") {
      if (!(await isAdminUser(req))) return json({ error: "unauthorized" }, 401);
      if (body.action === "disconnect") return await handleDisconnect(String(body.provider ?? "twelvedata"));
      if (body.action === "set_broker_source") return await handleSetBrokerSource(req);
      return await handleSetApiKey(body);
    }

    const chain = await resolveProviderChain();
    if (chain.length === 0) return json({ error: "no_api_key" });
    if (body.action === "quotes") {
      const priority = Array.isArray(body.priority) ? body.priority.map(String) : [];
      return await handleQuotesWithFallback(chain, priority);
    }
    if (body.action === "time_series") return await handleTimeSeriesWithFallback(chain, body);
    return json({ error: "unknown_action", message: `Unknown action: ${body.action}` }, 400);
  } catch (err) {
    console.error("market-data error", err);
    return json({ error: "internal", message: "Market data is unavailable right now." }, 500);
  }
});