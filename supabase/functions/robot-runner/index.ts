import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import {
  type AccountState,
  type Bar,
  type Interval,
  type RatesMap,
  type RobotConfig,
  type RobotCycleInput,
  type StrategyType,
  DEFAULT_RISK,
  atr,
  bestStrategyFor,
  closeRobotPositions,
  equity,
  intervalForMethod,
  manualTargets,
  markToMarket,
  pipValueUsd,
  rankPairs,
  runRobotCycle,
  sma,
  rsi,
  sizingUnits,
  stopDistanceFromAtr,
  STRATEGY_LABELS,
} from "./engine.ts";

// ---------------------------------------------------------------------------
// Background robot runner.
//
// The browser mirrors its running robot into `robot_runs` and heartbeats while
// the page is open. This function is invoked by pg_cron every minute; it takes
// over any run whose client heartbeat has gone stale (page closed or refreshed)
// and keeps trading server-side with the exact same engine rules as the browser
// — same indicators, same signals, same risk math, same per-pair caps. It also
// enforces the auto-run duration, the session max-profit / max-loss guard, the
// user's subscription/trial access and the starter-tier market-open limits (6
// pairs, 1 position per pair for free users and subscribers under 30 days), so
// a robot never trades past its schedule, without access or beyond its tier
// while the owner is away.
//
// Only ledger-backed accounts (paper + managed live) are ever run here — live
// OANDA / MetaTrader mirrors are never persisted and keep running in the
// browser only. No broker keys are read; the runner never touches the broker
// bridges.
// ---------------------------------------------------------------------------

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-robot-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Same 18-symbol watchlist as src/lib/watchlist.ts / market-data (kept in sync).
const WATCHLIST = [
  "EUR/USD", "GBP/USD", "USD/JPY", "USD/CHF", "AUD/USD", "NZD/USD", "USD/CAD",
  "EUR/GBP", "EUR/JPY", "GBP/JPY", "BTC/USD", "ETH/USD", "BNB/USD", "SOL/USD",
  "XRP/USD", "ADA/USD", "DOGE/USD", "LTC/USD",
];

// Contract size of one standard lot — mirrors src/lib/trading/lots.ts.
const LOT_UNITS = 100_000;

// A client heartbeat fresher than this means the browser is trading right now —
// the server stands down so the two never trade the same account at once.
const CLIENT_ALIVE_MS = 90_000;
// Minimum gap between two server ticks of the same run (pg_cron fires every
// minute; this also guards against two overlapping invocations of this
// function double-trading one run).
const TICK_COOLDOWN_MS = 45_000;

// Starter-tier market-open limits — mirrors src/lib/trading/tierLimits.ts.
// Free users and subscribers under 30 days may open positions on at most 6
// pairs with 1 position per pair; 30+ days of subscription (or admin) lifts it.
const STARTER_MAX_PAIRS = 6;
const STARTER_MAX_PER_PAIR = 1;
const UNLOCK_SUBSCRIPTION_DAYS = 30;
const DAY_MS = 86_400_000;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

// Deno's jsr build of @supabase/supabase-js resolves `ReturnType<typeof
// createClient>` to a never-schema overload that poisons every `.from(...)`
// chain. Helpers accept the same concrete client type the handler infers.
type AdminClient = SupabaseClient<any, "public", "public", any, any>;

// ---------------------------------------------------------------------------
// Auth — the cron job sends the `x-robot-token` it read from app_secrets;
// admins/ops may trigger manually with the service role key.
// ---------------------------------------------------------------------------
async function authorized(req: Request, admin: AdminClient): Promise<boolean> {
  const token = req.headers.get("x-robot-token");
  if (token) {
    const { data } = await admin
      .from("app_secrets")
      .select("value")
      .eq("key", "robot_runner_cron_token")
      .maybeSingle();
    if (data?.value && String(data.value) === token) return true;
  }
  const auth = req.headers.get("Authorization");
  if (auth === `Bearer ${SERVICE_ROLE}`) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Market data — reuses the existing market-data Edge Function (server-side
// proxy + cache + rate gate), authenticated with the project's anon key.
// ---------------------------------------------------------------------------
interface Quote {
  symbol: string;
  price: number | null;
  stale?: boolean;
}

async function fetchQuotes(priority: string[]): Promise<Quote[]> {
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/market-data`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: ANON_KEY,
        Authorization: `Bearer ${ANON_KEY}`,
      },
      body: JSON.stringify({ action: "quotes", priority }),
    });
    const data = (await res.json().catch(() => ({}))) as { quotes?: Quote[] };
    return Array.isArray(data.quotes) ? data.quotes : [];
  } catch {
    return [];
  }
}

async function fetchBars(symbol: string, interval: Interval): Promise<Bar[]> {
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/market-data`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: ANON_KEY,
        Authorization: `Bearer ${ANON_KEY}`,
      },
      body: JSON.stringify({ action: "time_series", symbol, interval, outputsize: 200 }),
    });
    const data = (await res.json().catch(() => ({}))) as { bars?: Bar[] };
    return Array.isArray(data.bars) ? data.bars : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Account persistence — mirrors src/lib/trading/persistence.ts (fromRows /
// toRow + saveRemote) so the server and the browser read/write the same shape.
// ---------------------------------------------------------------------------
interface PaperAccountRow {
  id: string;
  user_id: string;
  /** Robot slot this ledger belongs to (1 = first/default robot). */
  robot_number: number;
  broker: string;
  currency: string;
  initial_balance: number;
  balance: number;
  risk: AccountState["risk"] | null;
  created_at: string | null;
  updated_at: string | null;
}

interface PaperTradeRow {
  id: string;
  user_id: string;
  /** Robot slot this trade belongs to (mirrors the owning account row). */
  robot_number: number;
  symbol: string;
  side: "long" | "short";
  status: "open" | "closed";
  quantity: number;
  entry_price: number;
  entry_time: string;
  exit_price: number | null;
  exit_time: string | null;
  stop_loss: number | null;
  take_profit: number | null;
  pnl: number | null;
  pnl_pct: number | null;
  entry_equity: number | null;
  close_reason: string | null;
  strategy: string | null;
  target_profit_usd: number | null;
  target_loss_usd: number | null;
  /** Best unrealized PnL (USD) the position reached — profit-pullback lock. */
  peak_profit_usd: number | null;
  /** Scale-out first-target price (open-time stamp) — partial take-profit. */
  tp1_price: number | null;
  /** Whether the position already banked its partial take-profit. */
  partial_taken: boolean | null;
  /** Optional — `created_at` is deliberately omitted on insert (DB default applies). */
  created_at?: string | null;
}

function fromRows(row: PaperAccountRow, trades: PaperTradeRow[]): AccountState {
  const positions: AccountState["positions"] = [];
  const closed: AccountState["trades"] = [];
  for (const t of trades) {
    if (t.status === "open") {
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
        status: "open",
      });
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
        closeReason: (t.close_reason as AccountState["trades"][number]["closeReason"]) ?? "manual",
        strategy: t.strategy ?? undefined,
        status: "closed",
      });
    }
  }
  return {
    id: row.id,
    broker: (row.broker as AccountState["broker"]) ?? "paper",
    currency: "USD",
    initialBalance: Number(row.initial_balance ?? 0),
    balance: Number(row.balance ?? 0),
    risk: { ...DEFAULT_RISK, ...(row.risk ?? {}) },
    positions,
    trades: closed,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRows(account: AccountState, userId: string, robotNumber = 1): {
  account: Omit<PaperAccountRow, "id" | "created_at" | "updated_at">;
  trades: PaperTradeRow[];
} {
  const trades: PaperTradeRow[] = [
    ...account.positions.map<PaperTradeRow>((p) => ({
      id: p.id,
      user_id: userId,
      robot_number: robotNumber,
      symbol: p.symbol,
      side: p.side,
      status: "open",
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
    })),
    ...account.trades.map<PaperTradeRow>((t) => ({
      id: t.id,
      user_id: userId,
      robot_number: robotNumber,
      symbol: t.symbol,
      side: t.side,
      status: "closed",
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
    })),
  ];
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
  };
}

async function loadAccount(
  admin: AdminClient,
  run: RobotRunRow,
): Promise<{ account: AccountState; robotNumber: number } | null> {
  const { data: acct } = await admin
    .from("paper_accounts")
    .select("*")
    .eq("id", run.account_id)
    .maybeSingle();
  if (!acct) return null;
  if (acct.broker !== "paper" && acct.broker !== "managed") return null; // ledger-backed only
  const robotNumber = Number(acct.robot_number ?? 1);
  const { data: trades } = await admin
    .from("paper_trades")
    .select("*")
    .eq("user_id", run.user_id)
    .eq("robot_number", robotNumber)
    .order("created_at", { ascending: true });
  return {
    account: fromRows(acct as unknown as PaperAccountRow, (trades as unknown as PaperTradeRow[]) ?? []),
    robotNumber,
  };
}

async function saveAccount(
  admin: AdminClient,
  userId: string,
  account: AccountState,
  robotNumber = 1,
): Promise<void> {
  const { account: accRow, trades } = toRows(account, userId, robotNumber);
  await admin.from("paper_accounts").upsert(accRow, { onConflict: "user_id,robot_number" });
  if (trades.length > 0) {
    // Upsert by primary key instead of delete-all + re-insert. Every row
    // carries its own id, so a single bad row can never wipe the journal,
    // and `created_at` is omitted so the column default applies (explicit
    // nulls would violate the NOT NULL constraint and lose every trade).
    await admin.from("paper_trades").upsert(trades, { onConflict: "id" });
    // Drop only the rows that are no longer part of the account (e.g. a
    // position the browser closed locally while the server stood down).
    const ids = trades.map((t) => t.id);
    const idList = `(${ids.map((id) => `"${id}"`).join(",")})`;
    await admin
      .from("paper_trades")
      .delete()
      .eq("user_id", userId)
      .eq("robot_number", robotNumber)
      .not("id", "in", idList);
  } else {
    await admin.from("paper_trades").delete().eq("user_id", userId).eq("robot_number", robotNumber);
  }
}

// ---------------------------------------------------------------------------
// Robot run row + session helpers.
// ---------------------------------------------------------------------------
interface RobotRunRow {
  id: string;
  user_id: string;
  account_id: string;
  status: "running" | "stopped" | "finished";
  method: "scalping" | "longterm";
  strategy_mode: "auto" | "manual";
  manual_strategy: StrategyType | null;
  pairs: string[];
  auto_pick_pairs: boolean;
  pair_count: number;
  trade_mode: "sequential" | "concurrent";
  max_per_pair: number;
  max_open_trades: number;
  max_pairs_per_trade: number;
  per_trade_take_profit_pips: number;
  per_trade_stop_loss_pips: number;
  overall_max_profit_usd: number;
  overall_max_loss_usd: number;
  /** 'risk' (default, % of equity per trade) or 'fixed' (the picked lot). */
  sizing_mode: "risk" | "fixed";
  /** % of equity risked per trade when sizing_mode is 'risk'. */
  risk_per_trade_pct: number;
  /** Units per 1.00 lot of the mirrored paper account (e.g. 100,000 Standard). */
  contract_size: number;
  /**
   * Decimal lot (0.01-step micro lots of the account's contract; e.g. 0.05 =
   * 5,000 units on a Standard account) opened at EVERY trade in 'fixed'
   * sizing. 0 = not picked yet (fixed mode refuses to start).
   */
  lot: number;
  size_multiplier: number;
  profit_pullback_pct: number;
  duration_minutes: number | null;
  ends_at: string | null;
  session_start_equity: number | null;
  client_heartbeat_at: string | null;
  last_tick_at: string | null;
  last_error: string | null;
}

/** Latest still-running robot session for the account, or null. */
async function latestRunningSession(
  admin: AdminClient,
  run: RobotRunRow,
): Promise<string | null> {
  const { data } = await admin
    .from("robot_sessions")
    .select("id")
    .eq("account_id", run.account_id)
    .eq("status", "running")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.id ?? null;
}

async function ensureSession(admin: AdminClient, run: RobotRunRow, initialBalance: number): Promise<string | null> {
  const existing = await latestRunningSession(admin, run);
  if (existing) return existing;
  const { data } = await admin
    .from("robot_sessions")
    .insert({
      user_id: run.user_id,
      account_id: run.account_id,
      method: run.method,
      strategy: `Robot · ${(run.pairs ?? []).join(", ")}`,
      initial_balance: initialBalance,
      status: "running",
    })
    .select("id")
    .maybeSingle();
  return data?.id ?? null;
}

async function recordHistory(
  admin: AdminClient,
  run: RobotRunRow,
  sessionId: string | null,
  account: AccountState,
  rates: RatesMap,
): Promise<void> {
  const unrealized = equity(account, rates) - account.balance;
  await admin.from("robot_history").insert({
    user_id: run.user_id,
    account_id: run.account_id,
    session_id: sessionId,
    balance: account.balance,
    equity: equity(account, rates),
    unrealized,
  });
}

/** Close every running session for the account with final figures. */
async function closeSessions(
  admin: AdminClient,
  run: RobotRunRow,
  account: AccountState,
): Promise<void> {
  await admin
    .from("robot_sessions")
    .update({
      ended_at: new Date().toISOString(),
      status: "finished",
      final_balance: account.balance,
      pnl: account.balance - account.initialBalance,
      trade_count: account.trades.length,
    })
    .eq("account_id", run.account_id)
    .eq("status", "running");
}

// ---------------------------------------------------------------------------
// Access — mirrors useAccess() from src/hooks/usePlatform.ts.
// ---------------------------------------------------------------------------
async function hasAccess(admin: AdminClient, userId: string): Promise<boolean> {
  const { data: profile } = await admin
    .from("profiles")
    .select("role, trial_ends_at")
    .eq("id", userId)
    .maybeSingle();
  if (profile?.role === "admin" || profile?.role === "superadmin") return true;
  const now = Date.now();
  if (profile?.trial_ends_at && new Date(profile.trial_ends_at).getTime() > now) return true;
  const { data: subs } = await admin
    .from("subscriptions")
    .select("status, ends_at")
    .eq("user_id", userId)
    .eq("status", "active");
  return (subs ?? []).some((s: { ends_at?: string | null }) => !s.ends_at || new Date(s.ends_at).getTime() > now);
}

/**
 * The robot's market-open tier — the server-side mirror of robotTier() in
 * src/lib/trading/tierLimits.ts. Free users and subscribers who have held an
 * active subscription for fewer than 30 days are LIMITED to 6 pairs and 1
 * position per pair; 30+ days (or admin) unlocks the full watchlist.
 */
async function robotTierFor(
  admin: AdminClient,
  userId: string,
): Promise<{ limited: boolean; maxPairs: number; maxPerPair: number }> {
  const { data: profile } = await admin
    .from("profiles")
    .select("role")
    .eq("id", userId)
    .maybeSingle();
  if (profile?.role === "admin" || profile?.role === "superadmin") return { limited: false, maxPairs: Infinity, maxPerPair: Infinity };

  const now = Date.now();
  const { data: subs } = await admin
    .from("subscriptions")
    .select("status, starts_at, activated_at, created_at, ends_at")
    .eq("user_id", userId)
    .eq("status", "active");
  const starts = ((subs as
    | Array<{ starts_at?: string | null; activated_at?: string | null; created_at?: string | null; ends_at?: string | null }>
    | null) ?? [])
    .filter((s) => !s.ends_at || new Date(s.ends_at).getTime() > now)
    .map((s) => s.starts_at ?? s.activated_at ?? s.created_at)
    .filter((t): t is string => Boolean(t));
  if (starts.length === 0) return { limited: true, maxPairs: STARTER_MAX_PAIRS, maxPerPair: STARTER_MAX_PER_PAIR };

  const earliest = Math.min(...starts.map((t) => new Date(t).getTime()));
  const days = Math.max(0, Math.floor((now - earliest) / DAY_MS));
  const unlocked = days >= UNLOCK_SUBSCRIPTION_DAYS;
  return {
    limited: !unlocked,
    maxPairs: unlocked ? Infinity : STARTER_MAX_PAIRS,
    maxPerPair: unlocked ? Infinity : STARTER_MAX_PER_PAIR,
  };
}

// ---------------------------------------------------------------------------
// One tick for one run — the server-side equivalent of the browser loop in
// src/pages/Trading.tsx.
// ---------------------------------------------------------------------------
async function tickRun(
  admin: AdminClient,
  run: RobotRunRow,
): Promise<{ action: string; reason?: string }> {
  const nowMs = Date.now();

  // 1) The browser is trading right now — stand down (never double-trade).
  const hb = run.client_heartbeat_at ? new Date(run.client_heartbeat_at).getTime() : 0;
  if (hb && nowMs - hb < CLIENT_ALIVE_MS) return { action: "standby" };

  // 2) Atomic claim — only one invocation may tick this run per cooldown, and
  //    only while the heartbeat is still stale. If the page came back online
  //    between the initial read and this update, the claim misses (0 rows) and
  //    the browser keeps trading.
  const cooldownIso = new Date(nowMs - TICK_COOLDOWN_MS).toISOString();
  const staleHBIso = new Date(nowMs - CLIENT_ALIVE_MS).toISOString();
  const claimed = await admin
    .from("robot_runs")
    .update({ last_tick_at: new Date().toISOString(), last_error: null })
    .eq("id", run.id)
    .eq("status", "running")
    .or(
      `and(last_tick_at.is.null,last_tick_at.lt.${cooldownIso}),` +
        `and(client_heartbeat_at.is.null,client_heartbeat_at.lt.${staleHBIso})`,
    )
    .select("id");
  if (!claimed.data || claimed.data.length === 0) return { action: "standby" };

  // 3) Auto-run duration elapsed while the page was closed → stop + flatten.
  if (run.ends_at && nowMs >= new Date(run.ends_at).getTime()) {
    await finishRun(admin, run, "duration_elapsed");
    return { action: "finished", reason: "duration_elapsed" };
  }

  // 4) Access lost while away → stop the run and close its robot positions so
  //    a stopped robot never leaves its own trades open on the book.
  if (!(await hasAccess(admin, run.user_id))) {
    await finishRun(admin, run, "access_lost");
    return { action: "finished", reason: "access_lost" };
  }

  // 4b) Market-open tier: free users and subscribers under 30 days may open on
  //     at most 6 pairs with 1 position per pair (grabbed AFTER the access
  //     check so a lapsed user is stopped rather than capped).
  const tier = await robotTierFor(admin, run.user_id);

  // 5) Load the authoritative account state.
  const loaded = await loadAccount(admin, run);
  if (!loaded) {
    await admin.from("robot_runs").update({ last_error: "Account not found." }).eq("id", run.id);
    return { action: "error" };
  }
  const account = loaded.account;
  const robotNumber = loaded.robotNumber;

  // 5b) Profit-pullback lock mirrored from the browser — the server enforces
  //     the same give-back rule while the page is closed.
  if (typeof run.profit_pullback_pct === "number" && run.profit_pullback_pct > 0) {
    account.risk.profitPullbackPct = run.profit_pullback_pct;
  }

  // 6) Fresh quotes for the run's pairs + bars for signal computation.
  const scanSymbols = run.auto_pick_pairs ? WATCHLIST : (run.pairs ?? []).length > 0 ? run.pairs : WATCHLIST.slice(0, 2);
  const quotes = await fetchQuotes(scanSymbols);
  const rates: RatesMap = {};
  const staleSymbols = new Set<string>();
  for (const q of quotes) {
    if (q.price != null) rates[q.symbol] = q.price;
    if (q.stale) staleSymbols.add(q.symbol);
  }

  const interval = intervalForMethod(run.method);
  const barsBySymbol: Record<string, Bar[]> = {};
  await Promise.all(
    scanSymbols.map(async (symbol) => {
      const bars = await fetchBars(symbol, interval);
      if (bars.length >= 2) barsBySymbol[symbol] = bars;
    }),
  );

  // 7) Session max-profit / max-loss guard (mirrors the client session guard).
  if (run.session_start_equity != null) {
    const sessionPnl = equity(account, rates) - run.session_start_equity;
    const maxLoss = run.overall_max_loss_usd > 0 && sessionPnl <= -run.overall_max_loss_usd;
    const maxProfit = run.overall_max_profit_usd > 0 && sessionPnl >= run.overall_max_profit_usd;
    if (maxLoss || maxProfit) {
      await finishRun(admin, run, maxLoss ? "session_loss" : "session_profit");
      return { action: "finished", reason: maxLoss ? "session_loss" : "session_profit" };
    }
  }

  // 8) Rank pairs + build cycle inputs — identical rules to the browser.
  const ranked = rankPairs(barsBySymbol, interval, run.method);
  const rankedTargets =
    run.strategy_mode === "manual"
      ? manualTargets(barsBySymbol, run.manual_strategy ?? "MA", interval, run.method)
      : run.auto_pick_pairs
        ? ranked.slice(0, Math.max(1, run.pair_count))
        : ranked;
  // Starter tier: open on at most 6 distinct pairs — trade the strongest
  // setups within the cap. Subscribers 30+ days get every ranked pair.
  const tierCap = Number.isFinite(tier.maxPairs) ? STARTER_MAX_PAIRS : rankedTargets.length;
  // The user's optional "max pairs per trade" limit (0 = no cap) may shrink
  // that further — never grows it beyond the tier allowance.
  const pairCap =
    typeof run.max_pairs_per_trade === "number" && run.max_pairs_per_trade > 0
      ? Math.min(tierCap, Math.floor(run.max_pairs_per_trade))
      : tierCap;
  const targets = rankedTargets.slice(0, pairCap);

  const cycleInputs: RobotCycleInput[] = [];
  for (const target of targets) {
    if (!target.best) continue
    const price = rates[target.symbol]
    if (price == null) continue
    const bars = barsBySymbol[target.symbol]
    if (!bars) continue

    // Never ENTER on a stale price (market closed / feed stalled) — the
    // robot only opens when it has a live quote to open at. Stale prices are
    // still fine for closing and flattening at the last known price.
    if (staleSymbols.has(target.symbol)) continue

    // Volatility stand-down (off by default).
    if (account.risk.volatilityFilter && bars.length >= 30) {
      const atrSeries = atr(bars, 14)
      const lastAtr = atrSeries[atrSeries.length - 1] ?? 0
      const prevAtr = atrSeries[Math.max(0, atrSeries.length - 20)] ?? 0
      if (prevAtr > 0 && lastAtr > prevAtr * 1.5) continue
    }

    const atrStop = stopDistanceFromAtr(bars, target.symbol)
    const stopPips =
      run.per_trade_stop_loss_pips > 0
        ? run.per_trade_stop_loss_pips
        : atrStop > 0
          ? Math.max(account.risk.defaultStopPips, atrStop)
          : account.risk.defaultStopPips
    const takeProfitPips =
      run.per_trade_take_profit_pips > 0
        ? run.per_trade_take_profit_pips
        : Math.round(stopPips * account.risk.takeProfitRatio)
    const pipValue = pipValueUsd(target.symbol, rates)
    if (pipValue == null) continue
    // Same per-trade sizing as the browser: 'risk' (default) sizes every trade
    // from % of current equity and the trade's own stop distance; 'fixed' opens
    // every trade at the picked fraction of the account's contract (e.g. 0.05 ×
    // 100,000 = 5,000 units on a Standard account). Legacy runs written before
    // sizing modes existed are 'fixed' with their integer lot, so behaviour
    // doesn't change. Whole `units` are what the engine trades.
    const sizing = sizingUnits({
      mode: run.sizing_mode === "risk" ? "risk" : "fixed",
      lot: Number(run.lot ?? 0),
      riskPct: Number(run.risk_per_trade_pct) > 0 ? Number(run.risk_per_trade_pct) : 1,
      equityUsd: equity(account, rates),
      stopPips,
      pipValuePerUnit: pipValue,
      contractSize: Number(run.contract_size) > 0 ? Number(run.contract_size) : LOT_UNITS,
    })
    if (sizing <= 0) continue
    const scaledUnits = Math.round(sizing * Math.max(0.1, run.size_multiplier || 1))
    if (scaledUnits <= 0) continue

    // Probability-of-profit ingredients: the pair's setup score plus the
    // live signal-strength reads from its bars. The engine only OPENS when
    // the blended estimate is above the 50% threshold.
    const closes = bars.map((b) => b.close)
    const last = bars.length - 1
    const sma20 = sma(closes, 20)[last]
    const rsiVal = rsi(closes, 14)[last]
    const atrVal = atr(bars, 14)[last] ?? 0
    const closesLast = closes[last] ?? 0
    const windowBars = bars.slice(-20)
    const range = Math.max(...windowBars.map((b) => b.high)) - Math.min(...windowBars.map((b) => b.low))
    const momentum = range > 0 && bars.length >= 2 ? Math.abs(closes[last] - closes[last - 1]) / range : 0
    const trendAlign = sma20 != null ? (closesLast > sma20 ? 1 : -1) : 0

    cycleInputs.push({
      symbol: target.symbol,
      signal: target.best.signal,
      price,
      rates,
      strategy: `${STRATEGY_LABELS[target.best.type]} · ${interval}`,
      stopPips,
      takeProfitPips,
      units: scaledUnits,
      score: target.best.score,
      momentum: Math.min(1, momentum),
      rsi: rsiVal ?? undefined,
      trend: trendAlign,
      volatilityPct: closesLast > 0 ? (atrVal / closesLast) * 100 : undefined,
    })
  }

  // 9) Run the engine: SL/TP closes first, then new entries per caps.
  let next = account
  const m2m = markToMarket(next, rates)
  next = m2m.state

  const config: RobotConfig = {
    pairs: scanSymbols,
    tradeMode: tier.limited ? "sequential" : run.trade_mode,
    maxPerPair: tier.limited ? STARTER_MAX_PER_PAIR : run.max_per_pair,
    maxOpenTrades: tier.limited
      ? Math.min(STARTER_MAX_PAIRS, run.max_open_trades > 0 ? run.max_open_trades : STARTER_MAX_PAIRS)
      : run.max_open_trades,
  }
  const cyc = runRobotCycle(next, cycleInputs, config)
  next = cyc.state

  // 10) Persist the account only when something changed; record an equity
  //     history point every tick either way so the Performance curve stays
  //     complete while the page is closed.
  if (next !== account) {
    await saveAccount(admin, run.user_id, next, robotNumber)
  }
  const sessionId = await ensureSession(admin, run, next.initialBalance)
  await recordHistory(admin, run, sessionId, next, rates)

  return { action: "tick" }
}

/** Stop a run server-side: disable auto-trade, close robot positions, close
 * the session and mark the run finished. Rates may be empty (weekend / data
 * outage) — the engine then closes at the last known price. */
async function finishRun(
  admin: AdminClient,
  run: RobotRunRow,
  reason: string,
): Promise<void> {
  try {
    const loaded = await loadAccount(admin, run)
    if (loaded) {
      const { account, robotNumber } = loaded
      const stopped = { ...account, risk: { ...account.risk, autoTrade: false } }
      const quotes = await fetchQuotes(run.pairs ?? [])
      const rates: RatesMap = {}
      for (const q of quotes) if (q.price != null) rates[q.symbol] = q.price
      const { state } = closeRobotPositions(stopped, rates)
      await saveAccount(admin, run.user_id, state, robotNumber)
      await closeSessions(admin, run, state)
    }
  } catch (err) {
    console.error("robot-runner finishRun error", err)
  }
  await admin
    .from("robot_runs")
    .update({ status: "finished", last_error: null, last_tick_at: new Date().toISOString() })
    .eq("id", run.id)
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return json({ ok: true })

  try {
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } })
    if (!(await authorized(req, admin))) return json({ error: "unauthorized" }, 401)

    const { data: runs, error } = await admin
      .from("robot_runs")
      .select("*")
      .eq("status", "running")
    if (error) return json({ error: "db_error", message: error.message }, 500)

    const results: { id: string; action: string; reason?: string }[] = []
    for (const run of (runs as unknown as RobotRunRow[]) ?? []) {
      try {
        results.push({ id: run.id, ...(await tickRun(admin, run)) })
      } catch (err) {
        console.error("robot-runner tick error", run.id, err)
        await admin
          .from("robot_runs")
          .update({ last_error: err instanceof Error ? err.message.slice(0, 300) : "tick failed" })
          .eq("id", run.id)
        results.push({ id: run.id, action: "error" })
      }
    }

    return json({ ok: true, processed: results.length, results })
  } catch (err) {
    console.error("robot-runner error", err)
    return json({ error: "internal", message: "Robot runner unavailable." }, 500)
  }
})