/**
 * broker-mt — cloud bridge to the user's MetaTrader 4/5 account via MetaApi.
 *
 * MT4/MT5 are desktop terminals with no public REST API, so this serverless
 * function proxies every request through MetaApi's cloud gateway
 * (https://metaapi.cloud). The MetaApi API token is resolved per connection:
 *
 *   1. the user's OWN token (saved on the Brokers page, stored encrypted at
 *      rest on broker_connections.metaapi_token), or
 *   2. the platform-wide `METAAPI_TOKEN` secret (general token).
 *
 * The mode is an ADMIN SETTING, `settings.metaapi_token_mode`:
 *   - 'user'    (default) — the user's token first, then the general token;
 *   - 'general'            — ONLY the general `METAAPI_TOKEN` secret.
 * The general token lives in `app_secrets` (RLS deny-all / service-role only)
 * and is optionally mirrored to Edge Function secrets via the Management API
 * when a PAT (SUPABASE_ACCESS_TOKEN) is configured. It never reaches the
 * browser.
 *
 * MT credentials (login / password / server) come from the user's saved
 * `broker_connections` row (platform = 'mt4' | 'mt5').
 *
 * The "add your MetaApi token" flow runs a SECURITY PASS before activation:
 * the token is validated live against MetaApi's provisioning API
 * (`GET /users/current`) and the connected MT account is looked up. Only after
 * the pass does `metaapi-activate` / `provision` create + deploy the account.
 *
 * Actions (`action`, in the JSON body or `?action=`):
 *   verify | metaapi-status | metaapi-save | metaapi-check | metaapi-activate |
 *   metaapi-remove | metaapi-config (admin) | metaapi-mode-set (admin) |
 *   metaapi-token-set (admin) | metaapi-token-clear (admin) | state |
 *   summary | open-trades | closed-trades | open-position | close-position
 */
import {
  humanizeBrokerError,
  terminalStatus,
  type BrokerErrorCode,
} from "./brokerErrors.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

// Deno's jsr build of @supabase/supabase-js resolves overloads to a
// never-schema client that poisons every `.from(...)` chain with
// `GenericStringError[]` row types. The service-role client is cast to the
// concrete generic form (same pattern as robot-runner) so all chains below
// keep the `any` row type they intend.
type AdminClient = SupabaseClient<any, "public", "public", any, any>;

const METAAPI_PROVISIONING_BASE = "https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai";
const METAAPI_BASE = "https://mt-client-api-v1.agiliumtrade.agiliumtrade.ai";
/** 1 standard lot = 100,000 base units (the engine's "units" semantics). */
const UNITS_PER_LOT = 100_000;
/** Hard server-side cap on any single order, in standard lots. */
const MAX_LOTS_PER_ORDER = 100;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

/** fetch with a hard timeout so a hung MetaApi call can never hang a user. */
async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = 15_000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`MetaApi did not respond within ${Math.round(timeoutMs / 1000)}s.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** App symbol "EUR/USD" -> MetaTrader symbol "EURUSD". */
function mtSymbol(symbol: string): string {
  return symbol.replace("/", "").toUpperCase();
}

function appSymbol(symbol: string): string {
  const s = symbol.toUpperCase();
  if (s.length === 6) return `${s.slice(0, 3)}/${s.slice(3)}`;
  return s;
}

function iso(ms: unknown): string {
  const n = Number(ms);
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : "";
}

function toNumber(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Read the platform's risk defaults from the DB — the client cannot override. */
async function loadRiskLimits(supabase: any) {
  const { data } = await supabase.from("settings").select("value").eq("key", "risk_defaults").maybeSingle();
  const v = (data?.value ?? {}) as Record<string, number>;
  return {
    maxOpenPositions: Number(v.maxOpenPositions) > 0 ? Number(v.maxOpenPositions) : 5,
    maxDailyLossPct: Number(v.maxDailyLossPct) > 0 ? Number(v.maxDailyLossPct) : 5,
  };
}

/** Whether the platform currently allows real-money execution. */
async function loadBrokerBridge(supabase: any) {
  const { data } = await supabase.from("settings").select("value").eq("key", "broker_bridge").maybeSingle();
  const v = (data?.value ?? {}) as Record<string, boolean | undefined>;
  return { liveExecutionEnabled: v.liveExecutionEnabled !== false };
}

/** Admin setting: which token role the bridge trades through. */
async function loadMetaApiTokenMode(supabase: any): Promise<"user" | "general"> {
  const { data } = await supabase.from("settings").select("value").eq("key", "metaapi_token_mode").maybeSingle();
  const v = (data?.value ?? {}) as Record<string, unknown>;
  return v.mode === "general" ? "general" : "user";
}

async function isAdmin(supabase: any, userId: string): Promise<boolean> {
  const { data } = await supabase.from("profiles").select("role").eq("id", userId).maybeSingle();
  return data?.role === "admin";
}

function startOfTodayMs(): number {
  const n = new Date();
  return Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate());
}

/** `masked` = first 6 chars + "…" + last 4 chars, or null when empty. */
function mask(token: string): string | null {
  if (!token) return null;
  if (token.length <= 12) return `${token.slice(0, 3)}…`;
  return `${token.slice(0, 6)}…${token.slice(-4)}`;
}

/** Secure token store access — `app_secrets` is RLS-locked (service-role only). */
async function storeGet(supabase: any, key: string): Promise<string | null> {
  const { data } = await supabase.from("app_secrets").select("value").eq("key", key).maybeSingle();
  const v = data?.value;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

async function storeSet(supabase: any, key: string, value: string): Promise<string | null> {
  const { error } = await supabase.from("app_secrets").upsert({ key, value }, { onConflict: "key" });
  return error?.message ?? null;
}

async function loadPlatformSecret(supabase: any): Promise<string> {
  const stored = await storeGet(supabase, "METAAPI_TOKEN");
  if (stored) return stored;
  return Deno.env.get("METAAPI_TOKEN")?.trim() ?? "";
}

const MANAGEMENT_API = "https://api.supabase.com/v1/projects";

function projectRefFromEnv(): string | null {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  try {
    const ref = new URL(url).hostname.split(".")[0];
    return /^[a-z0-9]{20}$/.test(ref) ? ref : null;
  } catch {
    return null;
  }
}

/** Optional mirror to the project's Edge Function secrets (best-effort). */
async function managementApiSecretWrite(
  method: "POST" | "DELETE",
  payload: unknown,
): Promise<{ ok: boolean; error: string | null }> {
  const pat = Deno.env.get("SUPABASE_ACCESS_TOKEN")?.trim() ?? "";
  if (!pat) return { ok: true, error: null };
  const ref = projectRefFromEnv();
  if (!ref) return { ok: false, error: "Could not determine the project ref from SUPABASE_URL." };
  let res: Response;
  try {
    res = await fetchWithTimeout(`${MANAGEMENT_API}/${ref}/secrets`, {
      method,
      headers: { Authorization: `Bearer ${pat}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }, 20_000);
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Could not reach the Supabase Management API: ${cause}` };
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
    return {
      ok: false,
      error: data.message ?? data.error ?? `The Management API rejected the request (HTTP ${res.status}). Check that the SUPABASE_ACCESS_TOKEN has “Edge Function Secrets” write permission.`,
    };
  }
  return { ok: true, error: null };
}

interface MetaApiUser {
  email?: string;
  name?: string;
  plan?: string;
  subscriptionType?: string;
  region?: string;
}

/** Validate a MetaApi token against the provisioning API. */
async function validateMetaApiToken(token: string): Promise<{
  ok: boolean;
  status: number;
  user: MetaApiUser | null;
  error: string | null;
}> {
  let res: Response;
  try {
    res = await fetchWithTimeout(`${METAAPI_PROVISIONING_BASE}/users/current`, {
      headers: { "auth-token": token },
    });
  } catch (err) {
    const cause = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return { ok: false, status: 0, user: null, error: `Could not reach MetaApi: ${cause}` };
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.status === 401) {
    return {
      ok: false,
      status: 401,
      user: null,
      error: "MetaApi rejected this API token. Double-check it in your metaapi.cloud dashboard and try again.",
    };
  }
  if (!res.ok) {
    const msg = String(data.error ?? data.message ?? `MetaApi request failed (HTTP ${res.status}).`);
    return { ok: false, status: res.status, user: null, error: msg };
  }
  const plan = (data.plan ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    status: 200,
    user: {
      email: String(data.email ?? ""),
      name: String(data.name ?? ""),
      plan: String(plan.name ?? ""),
      subscriptionType: String(plan.subscriptionType ?? ""),
      region: String(data.region ?? ""),
    },
    error: null,
  };
}

/** Fetch the account list under a token; never throws, decodes failures. */
async function fetchAccountsFor(token: string): Promise<{
  ok: boolean;
  status: number;
  list: Array<Record<string, unknown>>;
  error: string | null;
}> {
  let res: Response;
  try {
    res = await fetchWithTimeout(`${METAAPI_PROVISIONING_BASE}/users/current/accounts`, {
      headers: { "auth-token": token, "Content-Type": "application/json" },
    });
  } catch (err) {
    const cause = err instanceof Error ? `${err.name}: ${err.message}${err.cause ? ` (${String(err.cause)})` : ""}` : String(err);
    return { ok: false, status: 0, list: [], error: `Could not reach MetaApi (${METAAPI_PROVISIONING_BASE}): ${cause}` };
  }
  const data = (await res.json().catch(() => ({}))) as
    | Array<Record<string, unknown>>
    | { items?: Array<Record<string, unknown>>; error?: string; message?: string };
  const list = Array.isArray(data) ? data : (data.items ?? []);
  if (res.status === 401) {
    return { ok: false, status: res.status, list, error: "MetaApi rejected this API token. Check it in your metaapi.cloud dashboard." };
  }
  if (!res.ok) {
    const body = data as { error?: string; message?: string };
    return { ok: false, status: res.status, list, error: body.error ?? body.message ?? `MetaApi request failed (HTTP ${res.status}).` };
  }
  return { ok: true, status: res.status, list, error: null };
}

/** The MetaApi account matching this MT login + server + platform. */
function findMetaApiAccount(
  list: Array<Record<string, unknown>>,
  login: string,
  server: string,
  platform: string,
): { id: string; state?: string; connectionStatus?: string; name?: string; type?: string } | null {
  const match = list.find(
    (a) => String(a.login) === login && String(a.server).toLowerCase() === server.toLowerCase() &&
      String(a.platform).toLowerCase() === platform,
  );
  return match
    ? {
        id: String(match.id),
        state: String(match.state ?? ""),
        connectionStatus: String(match.connectionStatus ?? ""),
        name: String(match.name ?? ""),
        type: String(match.type ?? ""),
      }
    : null;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Connection pacing — read cache + token check cache.
// Refresh ticks + robot cycles would otherwise fire many MetaApi requests per
// minute per connection (throttling, broker-side flags). TTLs below mean ONE
// physical request per kind per TTL; writes invalidate readCache.
// ---------------------------------------------------------------------------
const READ_TTL_MS: Record<string, number> = {
  state: 8_000,
  summary: 4_000,
  "open-trades": 4_000,
  "closed-trades": 30_000,
  daypnl: 30_000,
};

const readCache = new Map<string, { at: number; data: unknown }>();

function readCacheHit<T>(connId: string, kind: string): T | null {
  const key = `${connId}|${kind}`;
  const hit = readCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at >= (READ_TTL_MS[kind] ?? 4_000)) {
    readCache.delete(key);
    return null;
  }
  return hit.data as T;
}

function readCachePut(connId: string, kind: string, data: unknown): void {
  readCache.set(`${connId}|${kind}`, { at: Date.now(), data });
}

function readCacheInvalidate(connId: string): void {
  const prefix = `${connId}|`;
  for (const key of [...readCache.keys()]) if (key.startsWith(prefix)) readCache.delete(key);
}

const tokenCheckCache = new Map<string, { ok: boolean; at: number }>();
/** Successful token verifications are reusable for 5 min; failures 90 s. */
const TOKEN_CHECK_OK_TTL_MS = 5 * 60 * 1000;
const TOKEN_CHECK_BAD_TTL_MS = 90 * 1000;

async function validateMetaApiTokenCached(token: string): Promise<{ ok: boolean; error: string | null }> {
  const hit = tokenCheckCache.get(token);
  if (hit) {
    const ttl = hit.ok ? TOKEN_CHECK_OK_TTL_MS : TOKEN_CHECK_BAD_TTL_MS;
    if (Date.now() - hit.at < ttl) return { ok: hit.ok, error: hit.ok ? null : "MetaApi rejected this API token (checked recently)." };
    tokenCheckCache.delete(token);
  }
  const validation = await validateMetaApiToken(token);
  tokenCheckCache.set(token, { ok: validation.ok, at: Date.now() });
  return { ok: validation.ok, error: validation.error };
}

/** In-flight provisioning lock: one create/deploy per connection at a time. */
type ProvisionResult = {
  ok: boolean;
  state: string | null;
  accountId: string | null;
  error: string | null;
  code?: BrokerErrorCode;
  details?: string | null;
};
const provisionLocks = new Map<string, Promise<ProvisionResult>>();

/**
 * AUTO-CONNECT engine: make sure `login@server` exists in MetaApi and deploy
 * it, creating it if missing. Returns DEPLOYED when ready, or the MetaApi
 * reason on failure. Polls a fresh deployment briefly (~20-60s typical).
 */
async function ensureMetaAccountDeployed(args: {
  metaHeaders: Record<string, string>;
  apiToken: string;
  conn: MtConnection;
  login: string;
  server: string;
  platform: "mt4" | "mt5";
  password: string;
  provisioningProfileId?: string;
  magic?: number;
}): Promise<ProvisionResult> {
  const { metaHeaders, apiToken, conn, login, server, platform, password } = args;
  const lockKey = conn.id;
  const inFlight = provisionLocks.get(lockKey);
  if (inFlight) return inFlight;

  const task = (async () => {
    const list = await fetchAccountsFor(apiToken);
    if (!list.ok) {
      return { ok: false, state: null, accountId: null, error: list.error ?? "MetaApi could not list the accounts for this token." };
    }
    let meta = findMetaApiAccount(list.list, login, server, platform);

    if (!meta) {
      const accountPayload: Record<string, unknown> = {
        name: `Forex Toolkit ${platform.toUpperCase()} ${login}`,
        type: conn.account_type === "live" ? "live" : "demo",
        login,
        password: String(password),
        server,
        platform,
        magic: toNumber(args.magic) || 0,
      };
      if (args.provisioningProfileId) accountPayload.provisioningProfileId = args.provisioningProfileId;
      const createRes = await fetchWithTimeout(`${METAAPI_PROVISIONING_BASE}/users/current/accounts`, {
        method: "POST",
        headers: metaHeaders,
        body: JSON.stringify(accountPayload),
      }, 20_000);
      const created = await createRes.json().catch(() => ({})) as { id?: string; error?: string; message?: string };
      if (!createRes.ok || !created.id) {
        const reason = humanizeBrokerError(created.error ?? created.message ?? `MetaApi could not provision this account (HTTP ${createRes.status}).`);
        return {
          ok: false,
          state: null,
          accountId: null,
          error: reason.message,
          code: reason.code,
          details: reason.raw,
        };
      }
      meta = { id: String(created.id), state: "UNDEFINED", connectionStatus: "", name: "", type: "" };
    }

    if (meta.state !== "DEPLOYED" && meta.state !== "DEPLOYING") {
      const deployRes = await fetchWithTimeout(`${METAAPI_PROVISIONING_BASE}/users/current/accounts/${meta.id}/deploy`, {
        method: "POST",
        headers: metaHeaders,
      }, 20_000);
      const deploy = await deployRes.json().catch(() => ({})) as { error?: string; message?: string };
      if (!deployRes.ok) {
        const msg = deploy.error ?? deploy.message ?? `MetaApi could not deploy this account (HTTP ${deployRes.status}).`;
        if (/already deployed|in the process of deployment|deploying/i.test(msg)) {
          return { ok: true, state: "DEPLOYING", accountId: meta.id, error: null };
        }
        const reason = humanizeBrokerError(msg);
        return { ok: false, state: null, accountId: meta.id, error: reason.message, code: reason.code, details: reason.raw };
      }
      meta = { ...meta, state: "DEPLOYING" };
    }

    let state = meta.state ?? "";
    const HEAD = /^DEPLOYED$/;
    if (!HEAD.test(state)) {
      for (let i = 0; i < 4; i++) {
        await sleep(3000);
        try {
          const stRes = await fetchWithTimeout(`${METAAPI_PROVISIONING_BASE}/users/current/accounts/${meta.id}`, {
            headers: metaHeaders,
          });
          const stData = (await stRes.json().catch(() => ({}))) as { state?: string; failureReason?: string; connectionStatus?: string };
          state = String(stData.state ?? "");
          // A FAILED/ERROR/UNDEPLOYED provisioning state will never become
          // DEPLOYED on its own — fail now with the mapped reason instead of
          // reporting "deploying" forever.
          if (/^(FAILED|ERROR|UNDEPLOYED)$/.test(state) || /FAILED|ERROR/i.test(String(stData.connectionStatus ?? ""))) {
            const reason = humanizeBrokerError(stData.failureReason ?? `MetaApi could not deploy this account (${state}).`);
            return { ok: false, state, accountId: meta.id, error: reason.message, code: reason.code, details: reason.raw };
          }
        } catch {
          /* keep polling */
        }
        if (HEAD.test(state)) break;
      }
    }

    return { ok: true, state: HEAD.test(state) ? "DEPLOYED" : "DEPLOYING", accountId: meta.id, error: null };
  })();

  provisionLocks.set(lockKey, task);
  try {
    return await task;
  } finally {
    if (provisionLocks.get(lockKey) === task) provisionLocks.delete(lockKey);
  }
}

interface MtConnection {
  id: string;
  api_key: string | null;
  account_id: string | null;
  account_type: string;
  platform: "mt4" | "mt5";
  server: string | null;
  robot_number: number;
  metaapi_token: string | null;
  metaapi_token_masked: string | null;
  metaapi_security: string | null;
  metaapi_security_note: string | null;
  metaapi_token_checked_at: string | null;
  metaapi_meta: Record<string, unknown> | null;
  metaapi_active: boolean | null;
  metaapi_active_at: string | null;
}

/** Notify admins (once per user per 24h) of an automatic token fallback. */
async function notifyMetaFallback(
  supabase: any,
  userId: string,
  email: string | undefined,
  reason: string,
): Promise<void> {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { count } = await supabase
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("user_id", null)
      .eq("type", "warning")
      .eq("title", "MetaApi token fallback")
      .ilike("body", `%${userId}%`)
      .gte("created_at", since);
    if (count && count > 0) return;
    await supabase.from("notifications").insert({
      user_id: null,
      type: "warning",
      title: "MetaApi token fallback",
      body: `User ${email || userId} (${userId}): ${reason} The robot is running on the platform's MetaApi token — no error was shown to the user.`,
      link: "/admin",
    });
  } catch {
    /* best-effort */
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (!["GET", "POST", "PUT"].includes(req.method)) {
    return json({ ok: false, error: "Method not allowed." }, 405);
  }

  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "").trim();
  if (!token) return json({ ok: false, error: "Missing authorization." }, 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const supabase: AdminClient = createClient(supabaseUrl, serviceKey);

  // Verify the caller's JWT so only signed-in users can reach their account.
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return json({ ok: false, error: "Invalid session." }, 401);
  const currentUser = user;

  const url = new URL(req.url);
  let action = url.searchParams.get("action") ?? "verify";
  let body: Record<string, unknown> = {};
  if (req.method === "POST" || req.method === "PUT") {
    try {
      body = (await req.json()) as Record<string, unknown>;
      if (body?.action) action = String(body.action);
    } catch {
      /* body optional for GET-style actions */
    }
  }

  // ---- Admin-only bridge configuration (no broker connection required) ----
  if (action === "metaapi-config" || action === "metaapi-mode-set" ||
      action === "metaapi-token-set" || action === "metaapi-token-clear") {
    const admin = await isAdmin(supabase, user.id);
    if (!admin) return json({ ok: false, error: "Admins only." }, 403);
    const tokenMode = await loadMetaApiTokenMode(supabase);
    const platformSecret = await loadPlatformSecret(supabase);
    if (action === "metaapi-config") {
      return json({ ok: true, mode: tokenMode, generalTokenConfigured: !!platformSecret, generalTokenMasked: mask(platformSecret) ?? null });
    }
    if (action === "metaapi-token-set") {
      const newToken = String(body.token ?? "").trim();
      if (newToken.length < 20) {
        return json({ ok: false, error: "That doesn't look like a MetaApi token (should be at least 20 characters)." }, 400);
      }
      const dbErr = await storeSet(supabase, "METAAPI_TOKEN", newToken);
      if (dbErr) return json({ ok: false, error: `Could not store the MetaApi token: ${dbErr}` }, 500);
      let mirrorNote = "";
      const mirror = await managementApiSecretWrite("POST", [{ name: "METAAPI_TOKEN", value: newToken }]);
      if (!mirror.ok) mirrorNote = ` (platform-secret mirror skipped: ${mirror.error})`;
      const validation = await validateMetaApiToken(newToken);
      return json({
        ok: true,
        mode: tokenMode,
        generalTokenConfigured: true,
        generalTokenMasked: mask(newToken) ?? null,
        valid: validation.ok,
        note: validation.ok
          ? `General MetaApi token saved — MetaApi accepted it${validation.user?.email ? ` (${validation.user.email})` : ""}. The bridge now trades through this token in general mode.${mirrorNote}`
          : `Token saved, but MetaApi rejected it: ${validation.error} — live trading with it will fail the security pass. Save the correct token or clear this one.${mirrorNote}`,
      });
    }
    if (action === "metaapi-token-clear") {
      await supabase.from("app_secrets").delete().eq("key", "METAAPI_TOKEN");
      await managementApiSecretWrite("DELETE", ["METAAPI_TOKEN"]);
      return json({ ok: true, mode: tokenMode, generalTokenConfigured: false, generalTokenMasked: null, note: "General MetaApi token removed — the platform token is cleared." });
    }
    const nextMode = String(body.mode ?? "").trim();
    if (nextMode !== "user" && nextMode !== "general") {
      return json({ ok: false, error: "metaapi_token_mode must be 'user' or 'general'." }, 400);
    }
    const { error: upsertErr } = await supabase
      .from("settings")
      .upsert(
        { key: "metaapi_token_mode", value: { mode: nextMode }, updated_at: new Date().toISOString() },
        { onConflict: "key" },
      );
    if (upsertErr) return json({ ok: false, error: `Could not save the MetaApi token mode: ${upsertErr.message}` }, 500);
    return json({ ok: true, mode: nextMode, generalTokenConfigured: !!platformSecret, generalTokenMasked: mask(platformSecret) ?? null });
  }

  // Load the user's MetaTrader connection (platform = mt4 | mt5), addressed by
  // connection_id → broker_id → robot_number (in priority order).
  const connectionId = String(body.connection_id ?? url.searchParams.get("connection_id") ?? "").trim();
  const brokerId = String(body.broker_id ?? url.searchParams.get("broker_id") ?? "").trim();
  const robotNumber = Number(body.robot_number ?? url.searchParams.get("robot_number") ?? 1);

  // The `any` annotation breaks the jsr build's chained-builder type quirk:
  // reassigning a `let` chained builder re-resolves its type to the base
  // `PostgrestBuilder<any, GenericStringError[]>` and breaks every `.eq()`.
  let connQuery: any = supabase
    .from("broker_connections")
    .select(
      "id, api_key, account_id, account_type, platform, server, robot_number, " +
        "metaapi_token, metaapi_token_masked, metaapi_security, metaapi_security_note, " +
        "metaapi_token_checked_at, metaapi_meta, metaapi_active, metaapi_active_at",
    )
    .eq("user_id", user.id)
    .in("platform", ["mt4", "mt5"]);
  if (connectionId) connQuery = connQuery.eq("id", connectionId).maybeSingle();
  else if (brokerId) connQuery = connQuery.eq("broker_id", brokerId).maybeSingle();
  else connQuery = connQuery.eq("robot_number", robotNumber).order("created_at", { ascending: true }).limit(1).maybeSingle();
  const { data: conn, error: connErr } = await connQuery;
  if (connErr) return json({ ok: false, error: "Could not load your broker connection." }, 500);
  if (!conn?.api_key || !conn.account_id || !conn.server) {
    return json({ ok: false, error: "No MetaTrader connection saved. Add your MT4/MT5 account login, password and server on the Brokers page first." }, 400);
  }

  const platform = conn.platform as "mt4" | "mt5";
  const login = String(conn.account_id);
  const server = String(conn.server);
  // api_key holds the MT password, encrypted at rest; decrypt server-side.
  const { data: password, error: decryptErr } = await supabase.rpc("decrypt_broker_cred", { p_enc: conn.api_key });
  if (decryptErr || !password) {
    return json({ ok: false, error: "Could not read your saved MetaTrader credentials." }, 500);
  }

  /**
   * Token resolution. The user's saved token is decrypted server-side here.
   * AUTOMATIC RUNTIME FALLBACK: trading/robot actions live-validate the user's
   * token and silently fall back to the platform token when MetaApi rejects
   * it (revoked/invalid/throttled/unreachable) so the robot keeps running —
   * admins get ONE notification per user per day instead. Diagnostics report
   * honestly; metaapi-save/remove never hard-fail on a broken saved token.
   */
  const tokenMode = await loadMetaApiTokenMode(supabase);
  const platformSecret = await loadPlatformSecret(supabase);
  let userToken: string | null = null;
  if (conn.metaapi_token) {
    const { data: dec, error: decErr2 } = await supabase.rpc("decrypt_broker_cred", { p_enc: conn.metaapi_token });
    if (decErr2) {
      return json({ ok: false, error: "Could not read your saved MetaApi token. Remove and re-add it on the Brokers page." }, 500);
    }
    userToken = dec ? String(dec).trim() : null;
  }

  const tokenDiagnosticAction = action === "metaapi-status" || action === "metaapi-check";
  const tokenFreeAction = action === "metaapi-save" || action === "metaapi-remove";

  let metaApiToken: string | null = null;
  let tokenSource: "user" | "general" | null;
  let tokenFallbackReason: string | null = null;

  if (tokenMode === "general") {
    metaApiToken = platformSecret || null;
    tokenSource = platformSecret ? "general" : null;
  } else if (tokenDiagnosticAction || !userToken || tokenFreeAction) {
    metaApiToken = userToken ?? (platformSecret || null);
    tokenSource = userToken ? "user" : platformSecret ? "general" : null;
  } else {
    // Robot/trading path with a user's own token: try it first, fall back.
    const candidates: Array<{ token: string; source: "user" | "general" }> =
      [{ token: userToken, source: "user" }, ...(platformSecret ? [{ token: platformSecret, source: "general" } as const] : [])];
    let firstFailure: string | null = null;
    for (const candidate of candidates) {
      const verdict = await validateMetaApiTokenCached(candidate.token);
      if (verdict.ok) {
        metaApiToken = candidate.token;
        tokenSource = candidate.source;
        tokenFallbackReason = firstFailure;
        break;
      }
      if (!firstFailure) firstFailure = `your saved MetaApi token: ${verdict.error ?? "rejected by MetaApi"}`;
      metaApiToken = null;
    }
    if (!metaApiToken && platformSecret) {
      metaApiToken = platformSecret;
      tokenSource = "general";
      tokenFallbackReason = firstFailure;
    }
  }

  if (!metaApiToken && !tokenFreeAction) {
    return json({
      ok: false,
      code: "no_metaapi_token",
      error: tokenMode === "general"
        ? "No general MetaApi token is configured. An admin needs to set the METAAPI_TOKEN secret before live trading can work."
        : "No MetaApi token available for live trading. Add your own free MetaApi token on the Brokers page (or ask the admin to set the METAAPI_TOKEN secret).",
    }, 503);
  }
  const metaHeaders = { "auth-token": metaApiToken as string, "Content-Type": "application/json" };

  if (tokenFallbackReason && userToken && !tokenFreeAction) {
    await notifyMetaFallback(supabase, user.id, (user as { email?: string }).email, tokenFallbackReason);
  }

  /**
   * SECURITY PASS: validate the token; report whether it controls the MT
   * account (and its deployment state).
   */
  async function securityPass(apiToken: string): Promise<{
    verdict: "passed" | "failed";
    accountFound: boolean;
    state: string | null;
    connectionStatus: string | null;
    user: MetaApiUser | null;
    note: string;
  }> {
    const validation = await validateMetaApiToken(apiToken);
    if (!validation.ok) {
      return { verdict: "failed", accountFound: false, state: null, connectionStatus: null, user: null, note: validation.error ?? "MetaApi could not validate this token." };
    }
    const accounts = await fetchAccountsFor(apiToken);
    if (!accounts.ok) {
      return { verdict: "failed", accountFound: false, state: null, connectionStatus: null, user: validation.user, note: accounts.error ?? "MetaApi could not list your accounts." };
    }
    const match = findMetaApiAccount(accounts.list, login, server, platform);
    const account = match
      ? `It controls MT account #${login} on ${server}.`
      : `MT account #${login} isn't in this MetaApi user's cloud yet — activating will auto-provision it there.`;
    return {
      verdict: "passed",
      accountFound: !!match,
      state: match?.state ?? null,
      connectionStatus: match?.connectionStatus ?? null,
      user: validation.user,
      note: `Token valid. ${account}`,
    };
  }

  /** Persist the security-pass result (and optional new token) on the row. */
  async function persistMetaApiState(fields: Record<string, unknown>): Promise<{ error: string | null }> {
    const { error } = await supabase
      .from("broker_connections")
      .update({ ...fields, updated_at: new Date().toISOString() })
      .eq("id", conn.id)
      .eq("user_id", currentUser.id);
    return { error: error?.message ?? null };
  }

  function statusPayload(extra: Record<string, unknown> = {}) {
    return {
      ok: true,
      hasUserToken: !!conn.metaapi_token,
      masked: conn.metaapi_token_masked,
      security: conn.metaapi_security ?? "none",
      securityNote: conn.metaapi_security_note,
      checkedAt: conn.metaapi_token_checked_at,
      active: !!conn.metaapi_active,
      activeAt: conn.metaapi_active_at,
      meta: conn.metaapi_meta,
      mode: tokenMode,
      tokenSource,
      platformTokenConfigured: !!platformSecret,
      ...extra,
    };
  }

  try {
    if (action === "verify") {
      const accounts = await fetchAccountsFor(metaApiToken as string);
      if (!accounts.ok) {
        return json({ ok: false, error: accounts.error ?? "Could not reach MetaApi. Check the network and try again." }, 502);
      }
      const meta = findMetaApiAccount(accounts.list, login, server, platform);
      return json({ ok: true, provisioned: !!meta, state: meta?.state ?? null, connectionStatus: meta?.connectionStatus ?? null, platform, login, server });
    }

    if (action === "metaapi-status") {
      let accountFound: boolean | null = null;
      let state: string | null = null;
      let connectionStatus: string | null = null;
      try {
        const accounts = await fetchAccountsFor(metaApiToken as string);
        if (accounts.ok) {
          const meta = findMetaApiAccount(accounts.list, login, server, platform);
          accountFound = !!meta;
          state = meta?.state ?? null;
          connectionStatus = meta?.connectionStatus ?? null;
        }
      } catch {
        /* keep the panel usable */
      }
      return json(statusPayload({ accountFound, state, connectionStatus }));
    }

    if (action === "metaapi-save") {
      if (tokenMode === "general") {
        return json({ ok: false, error: "The platform is set to use the general MetaApi token (admin setting) — per-user tokens are disabled. Ask an admin to switch back to per-user if you want to add your own." }, 400);
      }
      const newToken = String(body.token ?? "").trim();
      if (newToken.length < 20) {
        return json({ ok: false, error: "That doesn't look like a MetaApi API token (should be at least 20 characters)." }, 400);
      }
      await persistMetaApiState({ metaapi_security: "checking" });
      conn.metaapi_security = "checking";
      const pass = await securityPass(newToken);
      const checkedAt = new Date().toISOString();
      const saveErr = await persistMetaApiState({
        metaapi_token: newToken, // plaintext → guard trigger encrypts at rest
        metaapi_token_masked: mask(newToken),
        metaapi_security: pass.verdict,
        metaapi_security_note: pass.note,
        metaapi_token_checked_at: checkedAt,
        metaapi_meta: pass.user as unknown as Record<string, unknown> | null,
        metaapi_active: false,
        metaapi_active_at: null,
      });
      if (saveErr.error) return json({ ok: false, error: `Could not save the MetaApi token: ${saveErr.error}` }, 500);
      return json(statusPayload({ security: pass.verdict, securityNote: pass.note, checkedAt, accountFound: pass.accountFound, state: pass.state, connectionStatus: pass.connectionStatus }));
    }

    if (action === "metaapi-check") {
      await persistMetaApiState({ metaapi_security: "checking" });
      conn.metaapi_security = "checking";
      const pass = await securityPass(metaApiToken as string);
      const checkedAt = new Date().toISOString();
      const saveErr = await persistMetaApiState({
        metaapi_security: pass.verdict,
        metaapi_security_note: pass.note,
        metaapi_token_checked_at: checkedAt,
        metaapi_meta: pass.user as unknown as Record<string, unknown> | null,
      });
      if (saveErr.error) return json({ ok: false, error: `Could not save the check result: ${saveErr.error}` }, 500);
      return json(statusPayload({ security: pass.verdict, securityNote: pass.note, checkedAt, accountFound: pass.accountFound, state: pass.state, connectionStatus: pass.connectionStatus }));
    }

    if (action === "metaapi-activate") {
      const pass = await securityPass(metaApiToken as string);
      if (pass.verdict !== "passed") {
        return json({ ok: false, error: pass.note, security: "failed", securityNote: pass.note }, 400);
      }
      if (pass.accountFound && pass.state === "DEPLOYED") {
        const saveErr = await persistMetaApiState({
          metaapi_security: "passed",
          metaapi_security_note: pass.note,
          metaapi_token_checked_at: new Date().toISOString(),
          metaapi_meta: pass.user as unknown as Record<string, unknown> | null,
          metaapi_active: true,
          metaapi_active_at: new Date().toISOString(),
        });
        if (saveErr.error) return json({ ok: false, error: `Could not activate the connection: ${saveErr.error}` }, 500);
        return json({ ok: true, note: "MetaApi security pass complete — account already deployed and live trading is active." });
      }
      const provisioned = await ensureMetaAccountDeployed({
        metaHeaders,
        apiToken: metaApiToken as string,
        conn,
        login,
        server,
        platform,
        password: String(password ?? ""),
        provisioningProfileId: String(body.provisioningProfileId ?? "").trim() || undefined,
        magic: toNumber(body.magic),
      });
      if (!provisioned.ok) {
        return json({ ok: false, code: provisioned.code ?? "provision_failed", error: provisioned.error ?? "MetaApi could not provision this account.", details: provisioned.details ?? null }, 400);
      }
      const now = new Date().toISOString();
      const saveErr = await persistMetaApiState({
        metaapi_security: "passed",
        metaapi_security_note: pass.note,
        metaapi_token_checked_at: now,
        metaapi_meta: pass.user as unknown as Record<string, unknown> | null,
        metaapi_active: true,
        metaapi_active_at: now,
      });
      if (saveErr.error) return json({ ok: false, error: `Could not save the activation state: ${saveErr.error}` }, 500);
      return json({
        ok: true,
        code: provisioned.state === "DEPLOYED" ? "deployed" : "deploying",
        state: provisioned.state,
        note: provisioned.state === "DEPLOYED"
          ? "MetaApi security pass complete — account deployed and live trading is active."
          : "MetaApi security pass complete — account provisioned and deploying. Live trading activates in about a minute.",
      });
    }

    if (action === "metaapi-remove") {
      if (tokenMode === "general") {
        return json({ ok: false, error: "The platform is set to use the general MetaApi token — per-user tokens are disabled, so there is nothing to remove." }, 400);
      }
      const saveErr = await persistMetaApiState({
        metaapi_token: null,
        metaapi_token_masked: null,
        metaapi_security: "none",
        metaapi_security_note: null,
        metaapi_token_checked_at: null,
        metaapi_meta: null,
        metaapi_active: false,
        metaapi_active_at: null,
      });
      if (saveErr.error) return json({ ok: false, error: `Could not remove your MetaApi token: ${saveErr.error}` }, 500);
      return json({ ok: true });
    }

    if (action === "provision") {
      const provisioned = await ensureMetaAccountDeployed({
        metaHeaders,
        apiToken: metaApiToken as string,
        conn,
        login,
        server,
        platform,
        password: String(password ?? ""),
        provisioningProfileId: String(body.provisioningProfileId ?? "").trim() || undefined,
        magic: toNumber(body.magic),
      });
      if (!provisioned.ok) {
        return json({ ok: false, code: provisioned.code ?? "provision_failed", error: provisioned.error ?? "MetaApi could not provision this account.", details: provisioned.details ?? null }, 400);
      }
      return json({
        ok: true,
        metaapiAccountId: provisioned.accountId,
        code: provisioned.state === "DEPLOYED" ? "deployed" : "deploying",
        state: provisioned.state,
        note: provisioned.state === "DEPLOYED"
          ? "Account provisioned and deployed — ready to trade live."
          : "Account provisioned and deploying. Deployment takes about a minute — the app reconnects automatically.",
      });
    }

    // Every action below needs the provisioned + deployed MetaApi account.
    let accountsFor = await fetchAccountsFor(metaApiToken as string);
    if (!accountsFor.ok) {
      return json({ ok: false, error: accountsFor.error ?? "Could not reach MetaApi. Check the network and try again." }, 502);
    }
    let meta = findMetaApiAccount(accountsFor.list, login, server, platform);
    if (!meta) {
      // AUTO-CONNECT / AUTO-FIX: create + deploy on the fly so "save your MT
      // credentials and the app connects" works with no manual activation.
      console.info(`broker-mt: auto-connecting ${platform} account #${login} on ${server}`);
      const provisioned = await ensureMetaAccountDeployed({
        metaHeaders,
        apiToken: metaApiToken as string,
        conn,
        login,
        server,
        platform,
        password: String(password ?? ""),
      });
      if (!provisioned.ok) {
        return json({ ok: false, code: provisioned.code ?? "provision_failed", error: provisioned.error ?? "MetaApi could not provision this account.", details: provisioned.details ?? null }, 400);
      }
      if (provisioned.state !== "DEPLOYED") {
        return json({ ok: false, code: "account_deploying", state: provisioned.state, error: "MetaTrader account is connecting for the first time (deploying on the MetaApi cloud). The app reconnects automatically in a few seconds." }, 503);
      }
      accountsFor = await fetchAccountsFor(metaApiToken as string);
      if (!accountsFor.ok) {
        return json({ ok: false, error: accountsFor.error ?? "Could not reach MetaApi. Check the network and try again." }, 502);
      }
      meta = findMetaApiAccount(accountsFor.list, login, server, platform);
      if (!meta) {
        return json({ ok: false, code: "provision_failed", error: "MetaApi provisioned the account but it is not visible yet. The app retries automatically." }, 502);
      }
    }

    const accountUrl = `${METAAPI_BASE}/users/current/accounts/${meta.id}`;

    if (action === "state") {
      // The provisioning record is the authoritative source for the account's
      // connectionStatus / failureReason — read it fresh so a broker that
      // REJECTED the login surfaces as a terminal error instead of a
      // "deploying…" spinner that silently times out.
      let provState = meta.state ?? "";
      let provConnStatus = meta.connectionStatus ?? "";
      let provFailure = "";
      try {
        const provRes = await fetchWithTimeout(`${METAAPI_PROVISIONING_BASE}/users/current/accounts/${meta.id}`, {
          headers: metaHeaders,
        });
        const prov = (await provRes.json().catch(() => ({}))) as { state?: string; connectionStatus?: string; failureReason?: string };
        provState = String(prov.state ?? provState).toUpperCase();
        provConnStatus = String(prov.connectionStatus ?? provConnStatus).toUpperCase();
        provFailure = String(prov.failureReason ?? "").trim();
      } catch {
        /* the trading state fetch below stays the fallback */
      }

      const cachedState = readCacheHit<{ status?: string; connectedToBroker?: boolean }>(conn.id, "state");
      if (cachedState) {
        return json({
          ok: true,
          ...cachedState,
          state: provState || null,
          connectionStatus: provConnStatus || null,
          failureReason: provFailure || null,
          cached: true,
        });
      }

      // Terminal failure (broker rejected the login, broker offline, deploy
      // failed): stop the polling loop now with an actionable message.
      const terminal = terminalStatus(provConnStatus, provState);
      if (terminal.terminal) {
        const reason = provFailure
          ? humanizeBrokerError(provFailure)
          : { code: terminal.code ?? "deploy_failed", message: terminal.message ?? "The broker rejected this connection.", raw: null };
        return json({
          ok: false,
          code: reason.code,
          error: reason.message,
          details: reason.raw ?? null,
          state: provState || null,
          connectionStatus: provConnStatus || null,
          failureReason: provFailure || null,
          terminal: true,
        }, 400);
      }

      const res = await fetchWithTimeout(`${accountUrl}/state`, { headers: metaHeaders });
      const data = (await res.json().catch(() => ({}))) as { status?: string; connectedToBroker?: boolean; error?: string; message?: string };
      if (!res.ok) {
        const reason = humanizeBrokerError(data.error ?? data.message ?? `MetaApi could not read the account state (HTTP ${res.status}).`);
        return json({
          ok: false,
          code: reason.code,
          error: reason.message,
          details: reason.raw ?? null,
          state: provState || null,
          connectionStatus: provConnStatus || null,
          failureReason: provFailure || null,
        }, 502);
      }
      const payload = { status: data.status ?? "unknown", connectedToBroker: !!data.connectedToBroker };
      readCachePut(conn.id, "state", payload);
      return json({
        ok: true,
        ...payload,
        state: provState || null,
        connectionStatus: provConnStatus || null,
        failureReason: provFailure || null,
      });
    }

    if (action === "summary") {
      const cachedSummary = readCacheHit<{ account: Record<string, unknown> }>(conn.id, "summary");
      if (cachedSummary) return json({ ok: true, account: cachedSummary.account, cached: true });
      const res = await fetchWithTimeout(`${accountUrl}/account-information`, { headers: metaHeaders });
      const data = (await res.json().catch(() => ({}))) as {
        balance?: number; equity?: number; currency?: string;
        margin?: number; freeMargin?: number; error?: string; message?: string;
      };
      if (!res.ok) {
        const reason = humanizeBrokerError(data.error ?? data.message ?? "MetaApi could not load the account summary.");
        return json({ ok: false, code: reason.code, error: reason.message, details: reason.raw ?? null }, 502);
      }
      const balance = toNumber(data.balance);
      const payload = {
        ok: true,
        account: {
          balance,
          equity: toNumber(data.equity ?? balance),
          currency: String(data.currency ?? "USD").toUpperCase(),
          margin: toNumber(data.margin),
          freeMargin: toNumber(data.freeMargin),
          connectionStatus: meta.connectionStatus ?? null,
        },
      };
      readCachePut(conn.id, "summary", payload);
      return json(payload);
    }

    if (action === "open-trades") {
      const cachedPos = readCacheHit<{ positions: Array<Record<string, unknown>> }>(conn.id, "open-trades");
      if (cachedPos) return json({ ok: true, positions: cachedPos.positions, cached: true });
      const res = await fetchWithTimeout(`${accountUrl}/positions`, { headers: metaHeaders });
      const data = (await res.json().catch(() => ({}))) as { positions?: Array<Record<string, unknown>>; error?: string; message?: string };
      if (!res.ok || !data.positions) {
        const reason = humanizeBrokerError(data.error ?? data.message ?? "MetaApi could not load open positions.");
        return json({ ok: false, code: reason.code, error: reason.message, details: reason.raw ?? null }, 502);
      }
      const payload = { ok: true, positions: data.positions };
      readCachePut(conn.id, "open-trades", payload);
      return json(payload);
    }

    if (action === "closed-trades") {
      const cachedHistory = readCacheHit<{ trades: Array<Record<string, unknown>> }>(conn.id, "closed-trades");
      if (cachedHistory) return json({ ok: true, trades: cachedHistory.trades, cached: true });
      const days = Math.min(90, Math.max(1, Number(body.days ?? 14)));
      const end = Date.now();
      const start = end - days * 24 * 60 * 60 * 1000;
      const res = await fetchWithTimeout(
        `${accountUrl}/history-orders?startTime=${start}&endTime=${end}&limit=${Math.min(500, Math.max(1, Number(body.limit ?? 100)))}`,
        { headers: metaHeaders },
      );
      const data = (await res.json().catch(() => ({}))) as { historyOrders?: Array<Record<string, unknown>>; error?: string; message?: string };
      if (!res.ok || !data.historyOrders) {
        const reason = humanizeBrokerError(data.error ?? data.message ?? "MetaApi could not load trade history.");
        return json({ ok: false, code: reason.code, error: reason.message, details: reason.raw ?? null }, 502);
      }
      const filled = data.historyOrders.filter((o) => String(o.state) === "ORDER_STATE_FILLED");
      const payload = { ok: true, trades: filled };
      readCachePut(conn.id, "closed-trades", payload);
      return json(payload);
    }

    if (action === "open-position") {
      const symbol = mtSymbol(String(body.symbol ?? ""));
      if (!symbol) return json({ ok: false, error: "Missing symbol." }, 400);
      const units = Math.round(toNumber(body.units));
      if (!Number.isFinite(units) || units <= 0) return json({ ok: false, error: "Invalid order size (units)." }, 400);
      const side = String(body.side ?? "long");
      if (side !== "long" && side !== "short") return json({ ok: false, error: "Invalid side." }, 400);

      const volume = Math.max(0.01, Math.round((units / UNITS_PER_LOT) * 100) / 100);
      const order: Record<string, unknown> = {
        symbol,
        type: side === "long" ? "ORDER_TYPE_BUY" : "ORDER_TYPE_SELL",
        actionType: "ORDER_TYPE_MARKET",
        volume,
        comment: String(body.strategy ?? "").slice(0, 40),
      };
      const stopLoss = toNumber(body.stopLoss);
      const takeProfit = toNumber(body.takeProfit);
      if (stopLoss <= 0) {
        return json({ ok: false, error: "A stop loss is required on every order." }, 400);
      }
      if (takeProfit > 0) {
        const consistent = side === "long" ? takeProfit > stopLoss : takeProfit < stopLoss;
        if (!consistent) {
          return json({ ok: false, error: "Take-profit is on the wrong side of the stop loss." }, 400);
        }
      }
      // ---- Server-side risk enforcement (client cannot override) ----
      const risk = await loadRiskLimits(supabase);
      const maxUnits = MAX_LOTS_PER_ORDER * UNITS_PER_LOT;
      if (units > maxUnits) {
        return json({ ok: false, error: `Order size exceeds the server-side maximum of ${MAX_LOTS_PER_ORDER} lots.` }, 400);
      }
      const liveGate = await loadBrokerBridge(supabase);
      if (conn.account_type === "live" && liveGate.liveExecutionEnabled === false) {
        return json({ ok: false, error: "Live execution is currently disabled by the platform. Switch to a demo account." }, 400);
      }
      let openForSymbol: number;
      const cachedPositions = readCacheHit<{ positions: Array<{ symbol?: string }> }>(conn.id, "open-trades");
      if (cachedPositions) {
        openForSymbol = cachedPositions.positions.filter((p) => String(p.symbol).toUpperCase() === symbol).length;
      } else {
        const posRes = await fetchWithTimeout(`${accountUrl}/positions`, { headers: metaHeaders });
        const posData = (await posRes.json().catch(() => ({}))) as { positions?: Array<{ symbol?: string }> };
        readCachePut(conn.id, "open-trades", { positions: posData.positions ?? [] });
        openForSymbol = (posData.positions ?? []).filter((p) => String(p.symbol).toUpperCase() === symbol).length;
      }
      if (openForSymbol >= risk.maxOpenPositions) {
        return json({ ok: false, error: `Maximum ${risk.maxOpenPositions} open position(s) reached for ${symbol}. Close one first.` }, 400);
      }

      // Daily-loss backstop: block new orders once today's realized loss on the
      // broker's OWN filled history has hit `maxDailyLossPct` of current
      // equity (computed server-side, never from the client mirror).
      if (risk.maxDailyLossPct > 0) {
        const cachedDay = readCacheHit<{ realizedToday: number; equity: number }>(conn.id, "daypnl");
        let realizedToday: number;
        let equityNow: number;
        if (cachedDay) {
          realizedToday = cachedDay.realizedToday;
          equityNow = cachedDay.equity;
        } else {
          const hRes = await fetchWithTimeout(
            `${accountUrl}/history-orders?startTime=${startOfTodayMs()}&endTime=${Date.now()}&limit=500`,
            { headers: metaHeaders },
          );
          const hData = (await hRes.json().catch(() => ({}))) as { historyOrders?: Array<{ state?: string; profit?: number }> };
          realizedToday = (hData.historyOrders ?? [])
            .filter((o) => String(o.state) === "ORDER_STATE_FILLED")
            .reduce((sum, o) => sum + toNumber(o.profit), 0);
          const sRes = await fetchWithTimeout(`${accountUrl}/account-information`, { headers: metaHeaders });
          const sData = (await sRes.json().catch(() => ({}))) as { equity?: number; balance?: number };
          equityNow = toNumber(sData.equity ?? sData.balance);
          readCachePut(conn.id, "daypnl", { realizedToday, equity: equityNow });
        }
        const lossCap = equityNow > 0 ? (equityNow * risk.maxDailyLossPct) / 100 : 0;
        if (realizedToday <= -lossCap && lossCap > 0) {
          return json({ ok: false, code: "daily_loss_cap", error: `Daily loss cap reached — the platform blocks new live orders after losing ${risk.maxDailyLossPct}% of the account in a day. The robot will resume tomorrow or when you adjust the setting.` }, 400);
        }
      }

      const res = await fetchWithTimeout(`${accountUrl}/trading/orders`, {
        method: "POST",
        headers: metaHeaders,
        body: JSON.stringify(order),
      });
      const data = (await res.json().catch(() => ({}))) as { id?: string; error?: string; message?: string; numericCode?: number };
      if (!res.ok) {
        const reason = humanizeBrokerError(data.error ?? data.message ?? `MetaApi rejected the order (code ${data.numericCode ?? "?"}).`);
        return json({ ok: false, code: reason.code, error: reason.message, details: reason.raw ?? null }, 400);
      }
      readCacheInvalidate(conn.id);
      return json({ ok: true, orderId: data.id ?? null });
    }

    if (action === "close-position") {
      const positionId = String(body.positionId ?? "").trim();
      if (!positionId) return json({ ok: false, error: "Missing position id." }, 400);
      const res = await fetchWithTimeout(`${accountUrl}/trading/positions/${positionId}/close`, {
        method: "POST",
        headers: metaHeaders,
        body: JSON.stringify({}),
      });
      const data = (await res.json().catch(() => ({}))) as { id?: string; profit?: number; error?: string; message?: string; numericCode?: number };
      if (!res.ok) {
        const reason = humanizeBrokerError(data.error ?? data.message ?? `MetaApi could not close the position (code ${data.numericCode ?? "?"}).`);
        return json({ ok: false, code: reason.code, error: reason.message, details: reason.raw ?? null }, 400);
      }
      readCacheInvalidate(conn.id);
      return json({ ok: true, profit: toNumber(data.profit) || null });
    }

    return json({ ok: false, error: `Unknown action '${action}'.` }, 400);
  } catch (err) {
    const detail = err instanceof Error ? err.message.trim() : "";
    if (/invalid peer certificate|UnknownIssuer|certificate has expired|self[- ]signed/i.test(detail)) {
      return json({ ok: false, error: "MetaApi's trading API is temporarily unreachable from the server (its certificate could not be verified). Your account and settings are safe — please try again in a few minutes." }, 502);
    }
    const reason = humanizeBrokerError(detail || "Could not reach MetaApi. Check the network and try again.");
    return json({ ok: false, code: reason.code, error: reason.message, details: reason.raw ?? null }, 502);
  }
});