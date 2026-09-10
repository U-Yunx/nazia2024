import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders } from "jsr:@supabase/supabase-js@2/cors";

// ---------------------------------------------------------------------------
// OANDA v20 bridge.
//
// The browser NEVER talks to OANDA directly. This function authenticates the
// caller via their Supabase session, loads the user's saved OANDA API key from
// broker_connections (never exposed to the browser), and proxies every
// read/write to the OANDA v20 REST API. Order placement additionally requires
// the per-connection robot REST API token (see broker-token) so a leaked
// session alone can't fire orders.
//
// Actions (`action`, passed in the JSON body):
//   verify          -> list the accounts the token can reach (Brokers page
//                      "Verify & connect" — proves the credential works and
//                      reports how many accounts are reachable).
//   summary         -> account summary (balance, equity, currency).
//   open-trades     -> open positions (the robot's live positions).
//   closed-trades   -> recently closed trades (the live journal).
//   open-position   -> market order with stop loss (needs symbol/side/units and
//                      the robot REST API token).
//   close-position  -> close one open trade by OANDA trade id (needs the token).
// ---------------------------------------------------------------------------

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const OANDA_PRACTICE = "https://api-fxpractice.oanda.com";
const OANDA_LIVE = "https://api-fxtrade.oanda.com";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

/** Load the caller's OANDA connection (with broker base URLs) — or null. */
async function connectionFor(client: any, userId: string) {
  const { data } = await client
    .from("broker_connections")
    .select("id, account_id, account_type, api_key, brokers(live_url, practice_url)")
    .eq("user_id", userId)
    .eq("platform", "oanda")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  return data ?? null;
}

/** True when the request carries the stored robot REST API token for a connection. */
async function validToken(client: any, connectionId: string, token: unknown): Promise<boolean> {
  if (typeof token !== "string" || !token) return false;
  // The robot REST API token lives encrypted at rest on the connection itself
  // (see broker-token `generate` + the guard_broker_cred_encrypt trigger), so
  // validate against THAT column — the legacy broker_tokens table is no longer
  // written and would reject every valid token. Decrypt server-side with the
  // service-role-only RPC, then constant-time compare.
  const { data: row } = await client
    .from("broker_connections")
    .select("rest_api_token")
    .eq("id", connectionId)
    .maybeSingle();
  if (!row?.rest_api_token) return false;
  const { data: plain } = await client.rpc("decrypt_broker_cred", { p_enc: row.rest_api_token });
  const expected = typeof plain === "string" ? plain : "";
  if (!expected) return false;
  const a = new TextEncoder().encode(expected);
  const b = new TextEncoder().encode(token);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function toOandaSymbol(symbol: string): string {
  return symbol.includes("/") ? symbol.replace("/", "_") : symbol;
}

/**
 * Normalize OANDA's v20 error strings before they reach the UI. OANDA's
 * `errorMessage` is usually already human-readable, but auth failures and
 * the generic "Multiple errors were returned" wrapper are not actionable —
 * map those to friendly copy and keep the rest intact.
 */
function oandaReason(raw: string, fallback: string): string {
  const text = raw?.trim() ?? "";
  const lower = text.toLowerCase();
  if (/invalid token|unauthorized|authentication failed|\b401\b|\b403\b/i.test(lower)) {
    return "OANDA rejected this API token. Check that the token is valid, not expired, and matches this account type (practice vs live), then try again.";
  }
  if (/multiple errors were|one or more|the configuration for account/i.test(lower)) {
    return "OANDA rejected the request. Make sure the token and account id belong to the same OANDA account, then try again.";
  }
  if (/was not found|does not exist|invalid account/i.test(lower)) {
    return "OANDA couldn't find this account. Check the account id is correct for the token you're using (practice vs live), then try again.";
  }
  return text || fallback;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true });
  try {
    // Verify the caller's JWT the same way the other bridges do — never trust
    // an unvalidated token (the gateway may run with verify_jwt off).
    const auth = (req.headers.get("Authorization") ?? "").replace("Bearer ", "").trim();
    if (!auth) return json({ error: "unauthorized", message: "Missing authorization." }, 401);
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
    const {
      data: { user },
      error: authError,
    } = await admin.auth.getUser(auth);
    if (authError || !user) {
      return json({ error: "unauthorized", message: "Invalid session. Please sign in again." }, 401);
    }
    const userId = user.id;

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = String(body.action ?? "");
    if (!action) return json({ error: "bad_request", message: "Missing action." }, 400);

    const conn = await connectionFor(admin, userId);
    if (!conn?.account_id) {
      return json({ ok: false, error: "Connect your OANDA trader account on the Brokers page first." });
    }

    const apiKey = typeof conn.api_key === "string" ? conn.api_key : "";
    if (!apiKey) return json({ ok: false, error: "OANDA API key is missing — reconnect your account." });

    const base =
      conn.account_type === "live"
        ? String(conn.brokers?.live_url ?? OANDA_LIVE)
        : String(conn.brokers?.practice_url ?? OANDA_PRACTICE);
    const accountId = String(conn.account_id);
    const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };

    switch (action) {
      case "verify": {
        // "Verify & connect" on the Brokers page: list every account the API
        // token can reach on the account type's host — a successful listing
        // proves the credential works, and the account count drives the
        // success message ("Connected & verified — N account(s) reachable").
        const res = await fetch(`${base}/v3/accounts`, { headers });
        const data = (await res.json().catch(() => ({}))) as { accounts?: unknown[]; errorMessage?: string };
        if (!res.ok) {
          const reason = oandaReason(data.errorMessage ?? "", `OANDA rejected this API token (HTTP ${res.status}).`);
          return json({ ok: false, error: `${reason} Double-check your token (practice vs live) and try again.` }, 400);
        }
        const accounts = Array.isArray(data.accounts) ? data.accounts : [];
        return json({ ok: true, accounts, count: accounts.length });
      }

      case "summary": {
        const res = await fetch(`${base}/v3/accounts/${accountId}/summary`, { headers });
        const data = (await res.json().catch(() => ({}))) as { account?: Record<string, unknown>; errorMessage?: string };
        if (!res.ok || !data.account) {
          return json({ ok: false, error: oandaReason(data.errorMessage ?? "", "OANDA rejected the request.") });
        }
        return json({ ok: true, account: data.account });
      }

      case "open-trades": {
        const res = await fetch(`${base}/v3/accounts/${accountId}/openTrades`, { headers });
        const data = (await res.json().catch(() => ({}))) as { trades?: unknown[]; errorMessage?: string };
        if (!res.ok) return json({ ok: false, error: oandaReason(data.errorMessage ?? "", "Could not load open trades.") });
        return json({ ok: true, trades: data.trades ?? [] });
      }

      case "closed-trades": {
        const res = await fetch(`${base}/v3/accounts/${accountId}/trades?state=CLOSED&count=100`, { headers });
        const data = (await res.json().catch(() => ({}))) as { trades?: unknown[]; errorMessage?: string };
        if (!res.ok) return json({ ok: false, error: oandaReason(data.errorMessage ?? "", "Could not load trade history.") });
        return json({ ok: true, trades: data.trades ?? [] });
      }

      case "open-position": {
        if (!(await validToken(admin, conn.id, body.token))) {
          return json({ ok: false, error: "Invalid or missing robot REST API token. Regenerate it on the Brokers page." });
        }
        const symbol = toOandaSymbol(String(body.symbol ?? ""));
        const side = String(body.side ?? "");
        const units = Math.max(1, Math.round(Number(body.units ?? 0)));
        const stopDistance = Number(body.stopDistance ?? 0);
        const takeProfitDistance = Math.max(0, Number(body.takeProfitDistance ?? 0));
        if (!symbol || (side !== "long" && side !== "short")) {
          return json({ ok: false, error: "Invalid order parameters." });
        }
        if (!(stopDistance > 0)) return json({ ok: false, error: "A stop loss is required on every position." });
        const signedUnits = side === "long" ? units : -units;
        const order = {
          type: "MARKET",
          instrument: symbol,
          units: signedUnits,
          timeInForce: "FOK",
          stopLossOnFill: { distance: String(stopDistance) },
          ...(takeProfitDistance > 0 ? { takeProfitOnFill: { distance: String(takeProfitDistance) } } : {}),
          clientExtensions: {
            comment: typeof body.strategy === "string" && body.strategy ? body.strategy.slice(0, 24) : "robot",
          },
        };
        const res = await fetch(`${base}/v3/accounts/${accountId}/orders`, {
          method: "POST",
          headers,
          body: JSON.stringify({ order }),
        });
        const data = (await res.json().catch(() => ({}))) as {
          orderFillTransaction?: { tradeOpened?: { tradeID?: string } };
          errorMessage?: string;
        };
        if (!res.ok || !data.orderFillTransaction?.tradeOpened?.tradeID) {
          return json({ ok: false, error: oandaReason(data.errorMessage ?? "", "OANDA rejected the order.") });
        }
        return json({ ok: true });
      }

      case "close-position": {
        if (!(await validToken(admin, conn.id, body.token))) {
          return json({ ok: false, error: "Invalid or missing robot REST API token. Regenerate it on the Brokers page." });
        }
        const tradeId = String(body.tradeId ?? "");
        if (!tradeId) return json({ ok: false, error: "Missing trade id." });
        const res = await fetch(`${base}/v3/accounts/${accountId}/trades/${tradeId}/close`, {
          method: "PUT",
          headers,
          body: "{}",
        });
        const data = (await res.json().catch(() => ({}))) as { errorMessage?: string };
        if (!res.ok) return json({ ok: false, error: oandaReason(data.errorMessage ?? "", "OANDA could not close the position.") });
        return json({ ok: true });
      }

      default:
        return json({ error: "bad_request", message: `Unknown action: ${action}` }, 400);
    }
  } catch (err) {
    console.error("broker-oanda error", err);
    return json({ error: "internal", message: "Broker bridge unavailable." }, 500);
  }
});