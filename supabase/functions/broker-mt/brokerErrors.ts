/**
 * Broker / MetaApi error normalization.
 *
 * MetaApi (and OANDA) return raw API failure strings — most infamously
 * `"ValidationError: Account with such credentials does not exist, credentials
 * are invalid or the account has been blocked..."` — which used to surface
 * verbatim on the Brokers page. This module maps those raw strings (and the
 * account's `connectionStatus` / provisioning `state`) into short, actionable,
 * human-safe messages, and exposes the stable `code` the UI can branch on
 * (e.g. "your broker rejected the login" vs "the bridge isn't configured yet").
 *
 * It has NO Deno/runtime dependencies so the exact same file the edge function
 * imports can be exercised by Vitest (see src/lib/trading/brokerErrors.test.ts)
 * and re-exported to the client (src/lib/brokerErrors.ts).
 */

export type BrokerErrorCode =
  | "auth_rejected"
  | "server_not_found"
  | "account_blocked"
  | "insufficient_funds"
  | "rate_limited"
  | "invalid_token"
  | "deploy_failed"
  | "account_exists"
  | "account_deploying"
  | "broker_offline"
  | "network"
  | "unknown";

export interface BrokerErrorReason {
  code: BrokerErrorCode;
  /** Human-readable, actionable copy safe to show to any user. */
  message: string;
  /** The original raw text (kept for diagnostic `details`), or null. */
  raw: string | null;
}

export const BROKER_ERROR_MESSAGES: Record<BrokerErrorCode, string> = {
  auth_rejected:
    "Your broker rejected this login. Check that the server name matches your MT terminal exactly (it's case-sensitive, e.g. “Exness-Real1”), the account login is correct, and the password is the investor or master password — demo and live accounts have different logins.",
  server_not_found:
    "MetaTrader couldn't find the server you entered. Copy the exact server name from your MT terminal (it's case-sensitive, e.g. “Exness-Real1” or “ICMarketsSC-Demo”) and update it on the Brokers page.",
  account_blocked:
    "The broker reports this account as blocked or disabled. Contact the broker's support to confirm the account is active and allowed to trade automatically.",
  insufficient_funds:
    "The broker rejected this trade — the account doesn't have enough funds or free margin.",
  rate_limited:
    "The broker or MetaApi is rate-limiting requests right now. Wait about a minute and try again.",
  invalid_token:
    "The broker or MetaApi rejected this token. Double-check that it's valid, hasn't expired, and matches the account type (practice vs live), then try again.",
  deploy_failed:
    "The broker couldn't be reached while deploying your MetaTrader account. This is usually temporary — check that the server name is correct and try again in a few minutes.",
  account_exists:
    "This MetaTrader account already exists on the MetaApi cloud under a different token. Remove the duplicate from the Brokers page or your metaapi.cloud dashboard first.",
  account_deploying:
    "MetaTrader is still deploying your account on the cloud — the app reconnects automatically in about a minute.",
  broker_offline:
    "The broker's servers are unreachable right now (offline or maintenance). Your account is safe — the robot reconnects automatically when the broker is back.",
  network:
    "The broker's API couldn't be reached from the server. Check your connection and try again in a few minutes.",
  unknown:
    "The broker returned an unexpected error. Please wait a moment and try again — if it keeps happening, contact support.",
};

/** Normalize a raw broker/MetaApi error message into a safe, actionable one. */
export function humanizeBrokerError(raw: unknown): BrokerErrorReason {
  let text = "";
  if (typeof raw === "string") text = raw.trim();
  else if (raw && typeof raw === "object") {
    const o = raw as { error?: unknown; message?: unknown };
    const candidate = typeof o.error === "string" ? o.error : (o.message as unknown);
    if (typeof candidate === "string") text = candidate.trim();
    else if (candidate !== undefined && candidate !== null) text = String(candidate).trim();
  } else if (raw !== undefined && raw !== null) {
    text = String(raw).trim();
  }

  if (!text) {
    return { code: "unknown", message: BROKER_ERROR_MESSAGES.unknown, raw: null };
  }

  const lower = text.toLowerCase();
  // The bug report that started this: MetaApi wraps provisioning failures in a
  // generic "ValidationError: …" prefix — strip it before matching content.
  const body = lower.replace(/^validationerror:?\s*/i, "").replace(/^error:?\s*/i, "");

  // Priority-ordered rules. Later rules only run when nothing earlier matched,
  // so a message mentioning both "credentials" and "server" says the actionable
  // (credentials-first) thing.
  if (/insufficient (funds|margin)|not enough (money|funds|margin)|margin call|no money/i.test(body)) {
    return { code: "insufficient_funds", message: BROKER_ERROR_MESSAGES.insufficient_funds, raw: text };
  }
  if (/rate.?limit|too many requests|throttl|\b429\b/i.test(body)) {
    return { code: "rate_limited", message: BROKER_ERROR_MESSAGES.rate_limited, raw: text };
  }
  if (/invalid api token|invalid token|bad token|unauthorized|unauth\b|\b401\b|forbidden|\b403\b/i.test(body)) {
    return { code: "invalid_token", message: BROKER_ERROR_MESSAGES.invalid_token, raw: text };
  }
  if (/server.*(not found|does not exist|unknown|invalid|wrong|cannot be found)|(not found|does not exist|unknown|invalid|wrong).*server/i.test(body)) {
    return { code: "server_not_found", message: BROKER_ERROR_MESSAGES.server_not_found, raw: text };
  }
  if (
    /credential|login or password|password.*(incorrect|invalid|wrong|mismatch)|incorrect password|invalid password|auth(entication|orization)? (failed|error)|authoriz\w+ (failed|error)|rejected by the broker|account.*(does not exist|invalid)|invalid.*credentials|cannot connect to the broker/i.test(body)
  ) {
    return { code: "auth_rejected", message: BROKER_ERROR_MESSAGES.auth_rejected, raw: text };
  }
  if (/blocked|banned|suspended|frozen|deactivated/i.test(body)) {
    return { code: "account_blocked", message: BROKER_ERROR_MESSAGES.account_blocked, raw: text };
  }
  if (/already (exists|deployed|connected|in use|created)/i.test(body)) {
    return { code: "account_exists", message: BROKER_ERROR_MESSAGES.account_exists, raw: text };
  }
  if (
    /deploy\w*(\s+\w+){0,4}\s+(failed|error)|fail(ed|ure|s)?(\s+to)?\s+deploy\w*/i.test(body)
  ) {
    return { code: "deploy_failed", message: BROKER_ERROR_MESSAGES.deploy_failed, raw: text };
  }
  if (/deploying|deployment in progress|in the process of deployment|connecting for the first time/i.test(body)) {
    return { code: "account_deploying", message: BROKER_ERROR_MESSAGES.account_deploying, raw: text };
  }
  // A generic "ValidationError: …" with no further signal is, in practice, the
  // broker rejecting the login — surface the actionable credentials copy.
  if (/validationerror/i.test(lower)) {
    return { code: "auth_rejected", message: BROKER_ERROR_MESSAGES.auth_rejected, raw: text };
  }
  // Anything else: keep a short sanitized copy of the raw reason so the user
  // still sees what the broker said, without leaking stack traces or secrets.
  const sanitized = text
    .replace(/\s+/g, " ")
    .replace(/[<>]/g, "")
    .trim()
    .slice(0, 240);
  return {
    code: "unknown",
    message: sanitized || BROKER_ERROR_MESSAGES.unknown,
    raw: text,
  };
}

/**
 * MetaApi `connectionStatus` values that will never resolve on their own — the
 * broker rejected the login, the broker is offline, or deployment failed.
 * The UI stops its polling and shows the mapped reason the moment one appears.
 */
export const TERMINAL_CONNECTION_STATUS: readonly string[] = [
  "ERROR",
  "BROKER_ERROR",
  "CONNECTION_ERROR",
  "BROKER_OFFLINE",
  "BROKER_AUTHORIZATION_ERROR",
  "AUTHORIZATION_ERROR",
  "AUTH_ERROR",
  "AUTHENTICATION_ERROR",
  "AUTHENTICATION_FAILED",
  "UNAUTHORIZED",
  "UNAUTHORIZED_USER",
  "INVALID_CREDENTIALS",
  "BAD_CREDENTIALS",
  "DISABLED",
  "DEACTIVATED",
  "LOCKED",
  "SUSPENDED",
  "FORBIDDEN",
  "DEPLOY_FAILED",
  "FAILED",
  "UNDEPLOYED",
];

export function isTerminalConnectionStatus(status: string | null | undefined): boolean {
  if (!status) return false;
  return TERMINAL_CONNECTION_STATUS.includes(status.toUpperCase().trim());
}

export interface TerminalStatusResult {
  terminal: boolean;
  code: BrokerErrorCode | null;
  message: string | null;
}

/** Map a (connectionStatus, provisioningState) pair to a terminal outcome, if any. */
export function terminalStatus(
  connectionStatus?: string | null,
  provisioningState?: string | null,
): TerminalStatusResult {
  const cs = (connectionStatus ?? "").toUpperCase().trim();
  const ps = (provisioningState ?? "").toUpperCase().trim();

  if (ps === "FAILED") {
    return { terminal: true, code: "deploy_failed", message: BROKER_ERROR_MESSAGES.deploy_failed };
  }

  if (!cs) return { terminal: false, code: null, message: null };

  if (cs === "UNDEPLOYED") {
    return {
      terminal: true,
      code: "deploy_failed",
      message:
        "Your MetaTrader account isn't deployed on the broker bridge yet. Press Retry (auto-fix) and the app will create and deploy it for you.",
    };
  }
  if (/^(AUTH_?ERROR|AUTHENTICATION_ERROR|AUTHENTICATION_FAILED|UNAUTHORIZED(_USER)?|INVALID_CREDENTIALS|BAD_CREDENTIALS|BROKER_AUTHORIZATION_ERROR|AUTHORIZATION_ERROR)$/.test(cs)) {
    return { terminal: true, code: "auth_rejected", message: BROKER_ERROR_MESSAGES.auth_rejected };
  }
  if (/^(DISABLED|DEACTIVATED|LOCKED|SUSPENDED|FORBIDDEN)$/.test(cs)) {
    return { terminal: true, code: "account_blocked", message: BROKER_ERROR_MESSAGES.account_blocked };
  }
  if (/^(BROKER_OFFLINE|BROKER_ERROR|CONNECTION_ERROR|ERROR)$/.test(cs)) {
    return { terminal: true, code: "broker_offline", message: BROKER_ERROR_MESSAGES.broker_offline };
  }
  if (/^(DEPLOY_FAILED|FAILED)$/.test(cs)) {
    return { terminal: true, code: "deploy_failed", message: BROKER_ERROR_MESSAGES.deploy_failed };
  }

  return { terminal: false, code: null, message: null };
}