import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders } from "jsr:@supabase/supabase-js@2/cors";

// ---------------------------------------------------------------------------
// Deep Analyst — AI position-management strategy for an OPEN trade.
//
// The browser never talks to an LLM provider directly. This function:
//   1. Verifies the caller (real signed-in user → AI allowed; anon key only →
//      deterministic analysis).
//   2. Reads the LLM key from server secrets (GEMINI_API_KEY, else
//      OPENAI_API_KEY) — never from the browser.
//   3. Builds a disciplined prompt from the position + market context the
//      client already computed, asks for STRICT JSON matching our schema, and
//      normalizes the response before returning it.
//   4. Falls back to a built-in deterministic strategy engine when no key is
//      configured, so the feature works immediately and degrades gracefully.
//
// Every response is analysis, not execution: this function never places,
// modifies or closes a trade.
// ---------------------------------------------------------------------------

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const OPENAI_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";

const GEMINI_MODEL = Deno.env.get("GEMINI_MODEL") ?? "gemini-2.5-flash-lite";
const OPENAI_MODEL = Deno.env.get("OPENAI_MODEL") ?? "gpt-4o-mini";
const LLM_TIMEOUT_MS = 45_000;

// --- Types (mirror of the client's shape) -----------------------------------
type Side = "long" | "short";
type BrokerMode = "paper" | "managed" | "oanda" | "mt";

type AnalystVerdict =
  | "hold"
  | "take_profit"
  | "partial_take_profit"
  | "trail"
  | "cut_loss"
  | "reduce_risk"
  | "stand_pat";

const VERDICTS: AnalystVerdict[] = [
  "hold", "take_profit", "partial_take_profit", "trail", "cut_loss", "reduce_risk", "stand_pat",
];

interface AnalystLevel {
  label: string;
  price: number | null;
  note: string;
}

interface AnalystStrategy {
  verdict: AnalystVerdict;
  action: string;
  confidence: number;
  targets: AnalystLevel[];
  stop: { price: number | null; note: string };
  reasoning: string[];
  risks: string[];
  timeframe: string;
}

interface DeepAnalystRequest {
  position?: {
    id?: string;
    symbol?: string;
    side?: Side;
    units?: number;
    entryPrice?: number;
    entryTime?: string;
    stopPrice?: number;
    takeProfitPrice?: number;
    targetProfitUsd?: number;
    targetLossUsd?: number;
    peakProfitUsd?: number;
    partialTaken?: boolean;
    strategy?: string;
    entryProbability?: number;
  };
  market?: {
    mark?: number;
    pnlUsd?: number;
    pnlPct?: number;
    stopDistancePct?: number;
    targetDistancePct?: number;
    remainingRiskPips?: number | null;
    remainingRewardPips?: number | null;
    riskRewardRemaining?: number | null;
    timeOpenH?: number;
    pullbackFromPeakPct?: number | null;
    atrPct?: number | null;
    trendPct?: number | null;
    swingHigh?: number | null;
    swingLow?: number | null;
    marketOpen?: boolean;
    series?: { t: string; c: number }[];
  };
  account?: {
    mode?: BrokerMode;
    balance?: number;
    equity?: number;
    riskPerTradePct?: number;
    trailingStop?: boolean;
    trailPips?: number;
    breakEvenPips?: number;
    profitPullbackPct?: number;
    partialTakeProfit?: boolean;
    partialClosePct?: number;
    partialTpRatio?: number;
  };
  strategyLabel?: string;
}

// --- Helpers -----------------------------------------------------------------
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function strArray(v: unknown, max = 6): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => str(x))
    .filter((x) => x.length > 0)
    .slice(0, max);
}

function clampConfidence(v: unknown): number {
  const n = num(v);
  if (n == null) return 60;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function round2(v: unknown): number | null {
  const n = num(v);
  return n == null ? null : Math.round(n * 100) / 100;
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

function isProjectKeyJwt(token: string): boolean {
  if (!PROJECT_REF) return false;
  const payload = decodeJwtPayload(token);
  return !!payload && typeof payload.ref === "string" && payload.ref === PROJECT_REF;
}

/** Resolves the caller's user id, or null for anon/publishable-key callers. */
async function resolveUserId(req: Request): Promise<string | null> {
  const authHeader = req.headers.get("Authorization");
  const apikey = req.headers.get("apikey");
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice("Bearer ".length).trim();
    const payload = decodeJwtPayload(token);
    if (typeof payload?.sub === "string" && payload.sub.length > 0) {
      if (ANON_KEY && token === ANON_KEY) return null;
      if (isProjectKeyJwt(token)) return null;
      try {
        const supabase = createClient(SUPABASE_URL, ANON_KEY, {
          global: { headers: { Authorization: authHeader } },
        });
        const { data, error } = await supabase.auth.getUser(token);
        if (!error && data?.user) return data.user.id;
      } catch {
        // fall through
      }
    }
  }
  // Publishable-key callers (apikey header) are authorized but anonymous.
  if (apikey) return null;
  return null;
}

/** True when the caller is allowed to use the (billable) AI path. */
async function isAiAuthorized(req: Request): Promise<boolean> {
  return (await resolveUserId(req)) !== null;
}

// --- Strategy normalization ---------------------------------------------------
function normalizeStrategy(raw: unknown): AnalystStrategy {
  const r = (raw ?? {}) as Record<string, unknown>;
  const verdict = VERDICTS.includes(str(r.verdict) as AnalystVerdict)
    ? (str(r.verdict) as AnalystVerdict)
    : "stand_pat";
  const targetsRaw = Array.isArray(r.targets) ? r.targets : [];
  const targets: AnalystLevel[] = targetsRaw
    .map((t) => {
      const o = (t ?? {}) as Record<string, unknown>;
      return { label: str(o.label) || "Level", price: round2(o.price), note: str(o.note) };
    })
    .slice(0, 4);
  const stopRaw = (r.stop ?? {}) as Record<string, unknown>;
  return {
    verdict,
    action: str(r.action) || "Hold the position and manage the stop.",
    confidence: clampConfidence(r.confidence),
    targets,
    stop: { price: round2(stopRaw.price), note: str(stopRaw.note) },
    reasoning: strArray(r.reasoning),
    risks: strArray(r.risks, 4),
    timeframe: str(r.timeframe) || "next few hours",
  };
}

// --- LLM calls ----------------------------------------------------------------
interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  error?: { message?: string; code?: number };
}

interface OpenAiResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
}

async function callGemini(prompt: string): Promise<string> {
  const schema = {
    type: "OBJECT",
    properties: {
      verdict: { type: "STRING" },
      action: { type: "STRING" },
      confidence: { type: "NUMBER" },
      targets: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            label: { type: "STRING" },
            price: { type: "NUMBER" },
            note: { type: "STRING" },
          },
        },
      },
      stop: {
        type: "OBJECT",
        properties: { price: { type: "NUMBER" }, note: { type: "STRING" } },
      },
      reasoning: { type: "ARRAY", items: { type: "STRING" } },
      risks: { type: "ARRAY", items: { type: "STRING" } },
      timeframe: { type: "STRING" },
    },
    required: ["verdict", "action", "confidence", "targets", "stop", "reasoning", "risks", "timeframe"],
  };
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": GEMINI_KEY,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.4,
          maxOutputTokens: 1200,
          responseMimeType: "application/json",
          responseSchema: schema,
        },
      }),
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    },
  );
  const data = (await res.json().catch(() => null)) as GeminiResponse | null;
  if (!res.ok || !data) {
    throw new Error(data?.error?.message ? `Gemini: ${data.error.message}` : "Gemini request failed");
  }
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  if (!text.trim()) throw new Error("Gemini returned an empty response");
  return text;
}

async function callOpenAi(prompt: string): Promise<string> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0.4,
      max_tokens: 1200,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: prompt },
        {
          role: "user",
          content:
            'Analyze the open position and reply ONLY with the JSON schema described in the system prompt. No markdown, no commentary outside the JSON.',
        },
      ],
    }),
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  });
  const data = (await res.json().catch(() => null)) as OpenAiResponse | null;
  if (!res.ok || !data) {
    throw new Error(data?.error?.message ? `OpenAI: ${data.error.message}` : "OpenAI request failed");
  }
  const text = data.choices?.[0]?.message?.content ?? "";
  if (!text.trim()) throw new Error("OpenAI returned an empty response");
  return text;
}

async function callLlm(prompt: string): Promise<{ engine: string; model: string; strategy: AnalystStrategy }> {
  let rawText: string;
  let engine: string;
  let model: string;
  if (GEMINI_KEY) {
    rawText = await callGemini(prompt);
    engine = "gemini";
    model = GEMINI_MODEL;
  } else if (OPENAI_KEY) {
    rawText = await callOpenAi(prompt);
    engine = "openai";
    model = OPENAI_MODEL;
  } else {
    throw new Error("No LLM key configured");
  }
  const parsed = JSON.parse(rawText) as unknown;
  return { engine, model, strategy: normalizeStrategy(parsed) };
}

function buildPrompt(ctx: DeepAnalystRequest): string {
  const pos = ctx.position ?? {};
  const mkt = ctx.market ?? {};
  const acc = ctx.account ?? {};
  const facts: string[] = [
    `Instrument: ${pos.symbol ?? "?"} — ${pos.side === "short" ? "SHORT" : "LONG"} ${pos.units ?? 0} units, opened ${pos.entryTime ?? "?"} (${mkt.timeOpenH != null ? Math.round(mkt.timeOpenH) + "h ago" : "recently"})`,
    `Entry ${pos.entryPrice ?? "?"} · mark ${mkt.mark ?? "?"} · stop ${pos.stopPrice ?? "?"} · take-profit ${pos.takeProfitPrice ?? "?"}`,
    `Unrealized P&L ${mkt.pnlUsd ?? 0} USD (${mkt.pnlPct ?? 0}% of equity)`,
    `Remaining risk ${mkt.remainingRiskPips ?? "?"} pips · reward ${mkt.remainingRewardPips ?? "?"} pips · R:R ${mkt.riskRewardRemaining ?? "?"}`,
  ];
  if (pos.peakProfitUsd != null && pos.peakProfitUsd > 0) {
    facts.push(`Best unrealized profit was ${pos.peakProfitUsd} USD` + (mkt.pullbackFromPeakPct != null ? ` — now ${mkt.pullbackFromPeakPct}% below that peak` : ""));
  }
  if (pos.partialTaken) facts.push("A partial take-profit has ALREADY banked part of this position; the stop sits at break-even.");
  if (pos.entryProbability != null) facts.push(`Estimated probability of profit at entry: ${Math.round(pos.entryProbability * 100)}%`);
  if (pos.strategy) facts.push(`Opened by strategy: ${pos.strategy}`);
  if (pos.targetProfitUsd) facts.push(`Per-trade profit target: ${pos.targetProfitUsd} USD`);
  if (pos.targetLossUsd) facts.push(`Per-trade loss cap: ${pos.targetLossUsd} USD`);
  if (mkt.atrPct != null) facts.push(`Recent volatility (ATR): ${mkt.atrPct.toFixed(2)}% per bar`);
  if (mkt.trendPct != null) facts.push(`Price vs 20-bar average: ${mkt.trendPct >= 0 ? "+" : ""}${mkt.trendPct.toFixed(2)}% (${mkt.trendPct >= 0 ? "uptrend" : "downtrend"})`);
  if (mkt.swingHigh != null && mkt.swingLow != null) {
    facts.push(`Recent swing levels: high ${mkt.swingHigh} · low ${mkt.swingLow}`);
  }
  facts.push(`Market ${mkt.marketOpen ? "open" : "closed"} · account mode ${acc.mode ?? "paper"}`);
  if (acc.equity != null) facts.push(`Account equity ${acc.equity} USD, risking ${acc.riskPerTradePct ?? 1}% per trade`);
  const exitTools: string[] = [];
  if (acc.trailingStop) exitTools.push(`trailing stop (${acc.trailPips ?? 0} pips) available`);
  if (acc.breakEvenPips) exitTools.push(`break-even move after ${acc.breakEvenPips} pips`);
  if (acc.partialTakeProfit) exitTools.push(`partial take-profit (${acc.partialClosePct ?? 50}% at ${acc.partialTpRatio ?? 1}R)`);
  if (acc.profitPullbackPct) exitTools.push(`profit pull-back lock (${acc.profitPullbackPct}% give-back)`);
  if (exitTools.length > 0) facts.push(`Exit tools this account has enabled: ${exitTools.join("; ")}`);
  if (mkt.series && mkt.series.length > 0) {
    facts.push("Recent closes: " + mkt.series.map((s) => s.c).join(", "));
  }
  if (ctx.strategyLabel) facts.push(`Trader's strategy profile: ${ctx.strategyLabel}`);

  return [
    "You are the Deep Analyst for a retail trading platform (FX, metals and crypto). A trader has an OPEN position and needs a disciplined management strategy. You only analyze; you never execute.",
    "",
    "FACTS:",
    ...facts.map((f) => `- ${f}`),
    "",
    "DECISION RULES:",
    "1. PROFITABLE position → protect gains first: prefer partial take-profit at 1R with stop to break-even, or a trailing/technical stop under the recent swing, UNLESS remaining R:R is clearly favourable (>= 1.5) and the trend supports holding to the full target.",
    "2. LOSING position → never widen the stop. Choose between cutting now (small loss) and holding a tight technical stop (swing low/high or the current stop) — base it on remaining R:R and volatility. If the loss is approaching the stop or the trade thesis broke, say cut_loss.",
    "3. Use remaining R:R and ATR to judge whether the take-profit is realistically reachable; if not, take partial profit and re-level.",
    "4. Give EXACT price levels (entry, stop, take-profit, swing high/low) — never vague advice like 'watch the market'.",
    "5. Confidence = how clearly the data supports THIS call (0-100), not certainty about direction.",
    "",
    'Respond ONLY with JSON matching this schema: {"verdict":"hold"|"take_profit"|"partial_take_profit"|"trail"|"cut_loss"|"reduce_risk"|"stand_pat","action":"one imperative headline sentence","confidence":0-100,"targets":[{"label":"string","price":number|null,"note":"string"}],"stop":{"price":number|null,"note":"string"},"reasoning":["3-6 short bullets"],"risks":["1-3 bullets"],"timeframe":"e.g. next 4h / next session"}. No markdown, no text outside the JSON object.',
  ].join("\n");
}

// --- Deterministic fallback (no LLM key, or anonymous caller) ------------------
function deterministicStrategy(ctx: DeepAnalystRequest): AnalystStrategy {
  const pos = ctx.position ?? {};
  const mkt = ctx.market ?? {};
  const acc = ctx.account ?? {};
  const side = pos.side === "short" ? -1 : 1;
  const mark = mkt.mark ?? pos.entryPrice ?? 0;
  const entry = pos.entryPrice ?? mark;
  const stop = pos.stopPrice ?? null;
  const tp = pos.takeProfitPrice ?? null;
  const pnl = mkt.pnlUsd ?? 0;
  const rr = mkt.riskRewardRemaining;
  const trend = mkt.trendPct;
  const atr = mkt.atrPct;
  const swingHigh = mkt.swingHigh;
  const swingLow = mkt.swingLow;
  const profitable = pnl >= 0;
  const trendingWith = trend != null && ((side > 0 && trend > 0) || (side < 0 && trend < 0));

  const targets: AnalystLevel[] = [];
  const reasoning: string[] = [];
  const risks: string[] = [];

  let verdict: AnalystVerdict = "hold";
  let action = "";
  let stopPrice: number | null = stop;
  let stopNote = "Keep the current stop-loss in place.";

  if (profitable) {
    const pullback = mkt.pullbackFromPeakPct;
    // Protect gains once the position is meaningfully green.
    if (pullback != null && pullback >= 40) {
      verdict = "trail";
      action = "Protect the gains — tighten the stop under the recent swing and let the position run.";
      stopPrice = side > 0 ? swingLow ?? entry : swingHigh ?? entry;
      stopNote = `Move the stop to the recent swing ${side > 0 ? "low" : "high"} to lock in the profit.`;
      reasoning.push(`The position has given back ${pullback.toFixed(0)}% from its best profit — banked gains are at risk.`);
    } else if (rr != null && rr < 0.8) {
      verdict = "partial_take_profit";
      action = "Bank part of the profit now and move the stop to break-even.";
      stopPrice = entry;
      stopNote = "Move the stop to break-even after closing part of the position.";
      if (tp != null) targets.push({ label: "Full target", price: tp, note: "Remaining units ride toward the original take-profit." });
      reasoning.push(`Remaining reward is ${rr.toFixed(2)}R against the risk — the upside left does not justify full exposure.`);
    } else if (rr != null && rr >= 1.5 && trendingWith) {
      verdict = "hold";
      action = "Let it run — the remaining reward/risk and trend still favour the full target.";
      stopPrice = stop ?? entry;
      stopNote = "Hold the current stop; raise it to break-even only if the trade turns.";
      reasoning.push(`Remaining R:R is ${rr.toFixed(2)} and the trend still supports the position.`);
    } else if (rr != null && rr >= 1.5) {
      verdict = "hold";
      action = "Let it run toward the target, but keep the stop tight.";
      stopPrice = stop ?? entry;
      reasoning.push(`Remaining R:R of ${rr.toFixed(2)} justifies holding for the full target.`);
    } else {
      verdict = "hold";
      action = "Hold the position and manage the stop as planned.";
      reasoning.push("The trade is in profit with a balanced remaining setup.");
    }
    targets.unshift({ label: "Break-even", price: entry, note: "Protection level once profit is banked or the trade turns." });
    if (tp != null && !targets.some((t) => t.price === tp)) targets.push({ label: "Take-profit", price: tp, note: "Original target." });
    risks.push("Price can reverse sharply — keep the stop where the analysis places it.");
  } else {
    // Losing position — damage control.
    const lossPct = mkt.pnlPct ?? 0;
    if (rr != null && rr >= 2 && (trendingWith || atr == null || atr < 1.5)) {
      verdict = "reduce_risk";
      action = "Trim the risk — tighten the stop below the swing and keep a smaller position for the recovery.";
      stopPrice = side > 0 ? Math.max(stop ?? 0, swingLow ?? 0) : swingHigh ?? stop;
      if (side > 0 && swingLow != null) stopPrice = Math.max(stop ?? 0, swingLow);
      if (side < 0 && swingHigh != null) stopPrice = swingHigh;
      stopNote = "Tighten the stop to the recent swing level — the thesis is not dead yet.";
      reasoning.push(`Remaining R:R is ${rr.toFixed(2)} — cutting everything now forfeits a reasonable recovery.`);
    } else {
      verdict = "cut_loss";
      action = "Cut the loss now — the setup no longer justifies the risk.";
      stopPrice = stop ?? entry;
      stopNote = "Exit at market; the stop is the maximum you should lose here.";
      reasoning.push(`The position is down ${lossPct.toFixed(1)}% with ${rr != null ? rr.toFixed(2) + "R" : "no"} remaining reward against the risk.`);
      risks.push("Waiting for a bounce can turn a small loss into a large one.");
    }
    targets.push({ label: "Break-even", price: entry, note: "Exit level if price recovers before the stop triggers." });
    risks.push("Markets can gap through stops in fast news — size stays the real protection.");
  }

  if (atr != null) reasoning.push(`Recent volatility is ${atr.toFixed(2)}% per bar — ${atr >= 1.5 ? "wider moves make precise targets harder; keep stops technical" : "moves are orderly; targets are realistic"}.`);
  if (acc.trailingStop) reasoning.push("Your account has a trailing stop available — it can automate the protection suggested here.");
  if (acc.profitPullbackPct) reasoning.push(`Your profit pull-back lock (${acc.profitPullbackPct}% give-back) also guards the peak automatically.`);

  return {
    verdict,
    action,
    confidence: profitable ? 70 : 75,
    targets,
    stop: { price: stopPrice != null && stopPrice > 0 ? stopPrice : null, note: stopNote },
    reasoning: reasoning.slice(0, 6),
    risks: risks.slice(0, 3),
    timeframe: "next few hours",
  };
}

// --- Request plumbing ----------------------------------------------------------
function readContext(body: Record<string, unknown>): DeepAnalystRequest {
  return {
    position: (body.position ?? {}) as DeepAnalystRequest["position"],
    market: (body.market ?? {}) as DeepAnalystRequest["market"],
    account: (body.account ?? {}) as DeepAnalystRequest["account"],
    strategyLabel: typeof body.strategyLabel === "string" ? body.strategyLabel : undefined,
  };
}

function validateContext(ctx: DeepAnalystRequest): string | null {
  const pos = ctx.position ?? {};
  if (!str(pos.symbol)) return "Missing position.symbol.";
  if (pos.side !== "long" && pos.side !== "short") return "Missing or invalid position.side.";
  if (num(pos.entryPrice) == null) return "Missing position.entryPrice.";
  if (num(ctx.market?.mark) == null) return "Missing market.mark.";
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    // Anyone with a valid project key may use the (free) deterministic engine;
    // only real signed-in users unlock the (billable) AI path.
    const aiAllowed = await isAiAuthorized(req);
    let body: Record<string, unknown> = {};
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return json({ error: "bad_request", message: "Invalid JSON body." }, 400);
    }
    const ctx = readContext(body);
    const invalid = validateContext(ctx);
    if (invalid) return json({ error: "bad_request", message: invalid }, 400);

    const keyConfigured = Boolean(GEMINI_KEY || OPENAI_KEY);

    // No key configured (or anonymous caller): deterministic engine, always.
    if (!keyConfigured || !aiAllowed) {
      const strategy = deterministicStrategy(ctx);
      return json({
        ok: true,
        engine: "deterministic",
        ai_available: keyConfigured && aiAllowed,
        ai_requires_login: keyConfigured && !aiAllowed,
        note: keyConfigured
          ? "Sign in to unlock AI analysis."
          : "AI analysis is not configured — this is the built-in strategy engine. Add a Gemini or OpenAI key to enable deep narrative analysis.",
        strategy,
      });
    }

    try {
      const { engine, model, strategy } = await callLlm(buildPrompt(ctx));
      return json({ ok: true, engine, model, strategy });
    } catch (err) {
      console.error("deep-analyst LLM error", err);
      // LLM down → serve the deterministic engine rather than a dead button.
      const strategy = deterministicStrategy(ctx);
      return json({
        ok: true,
        engine: "deterministic",
        degraded: true,
        note: "The AI service was unreachable — showing the built-in analysis instead.",
        strategy,
      });
    }
  } catch (err) {
    console.error("deep-analyst error", err);
    return json({ error: "internal", message: "Deep Analyst is unavailable right now — please try again." }, 500);
  }
});
