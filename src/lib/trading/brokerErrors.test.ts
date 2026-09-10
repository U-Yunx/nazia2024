/**
 * Unit tests for broker / MetaApi error normalization.
 *
 * The logic lives in `supabase/functions/broker-mt/brokerErrors.ts` — it has no
 * Deno/runtime dependencies so the exact same file the edge function uses can
 * be exercised here (the same arrangement as tokenFallback.test.ts). These
 * tests pin the contract that fixes the "ValidationError: …" report on the
 * Brokers page: raw MetaApi strings become short, actionable, human-safe
 * messages with a stable `code` the UI can branch on.
 */
import { describe, expect, it } from "vitest";
import {
  BROKER_ERROR_MESSAGES,
  humanizeBrokerError,
  isTerminalConnectionStatus,
  terminalStatus,
} from "../../../supabase/functions/broker-mt/brokerErrors.ts";

describe("humanizeBrokerError", () => {
  it("maps the classic MetaApi ValidationError to an actionable auth-rejected message", () => {
    // The exact shape users reported seeing on the Brokers page.
    const r = humanizeBrokerError(
      "ValidationError: Account with such credentials does not exist, credentials are invalid or the account has been blocked while trying to connect to the broker.",
    );
    expect(r.code).toBe("auth_rejected");
    expect(r.message).toContain("server name");
    expect(r.message).toContain("login");
    expect(r.message).toContain("password");
    expect(r.message).not.toContain("ValidationError");
    expect(r.raw).toContain("ValidationError");
  });

  it("keeps the raw text available as diagnostic detail", () => {
    const r = humanizeBrokerError("ValidationError: bad server");
    expect(r.raw).toBe("ValidationError: bad server");
  });

  it("points the user at the exact server name when the server is the problem", () => {
    const r = humanizeBrokerError("ValidationError: The account server 'Exness-Realzz' does not exist");
    expect(r.code).toBe("server_not_found");
    expect(r.message).toContain("MT terminal");
  });

  it("reports blocked/deactivated accounts as account_blocked", () => {
    for (const text of [
      "ValidationError: The account has been blocked by the broker",
      "The account is frozen due to broker policy",
      "deactivated by the broker",
    ]) {
      expect(humanizeBrokerError(text).code).toBe("account_blocked");
    }
  });

  it("detects insufficient funds and margin calls", () => {
    const r = humanizeBrokerError("not enough money to open a position");
    expect(r.code).toBe("insufficient_funds");
  });

  it("detects rate limiting and 429s", () => {
    expect(humanizeBrokerError("Too many requests, rate limit exceeded").code).toBe("rate_limited");
    expect(humanizeBrokerError("HTTP 429 Throttled").code).toBe("rate_limited");
  });

  it("detects invalid / unauthorized tokens and 401s", () => {
    expect(humanizeBrokerError("Invalid API token provided").code).toBe("invalid_token");
    expect(humanizeBrokerError("Unauthorized").code).toBe("invalid_token");
    expect(humanizeBrokerError("401: unauth").code).toBe("invalid_token");
  });

  it("detects deploy failures", () => {
    const r = humanizeBrokerError("Deployment of the account failed: timeout while connecting");
    expect(r.code).toBe("deploy_failed");
  });

  it("maps an opaque generic ValidationError to auth-rejected by default", () => {
    const r = humanizeBrokerError("ValidationError: something the user cannot parse");
    expect(r.code).toBe("auth_rejected");
    expect(r.message).toContain("server");
  });

  it("keeps a short sanitized copy for unknown errors instead of the raw string", () => {
    const r = humanizeBrokerError("Connection refused <script>alert(1)</script>  with a very long tail ".repeat(20));
    expect(r.code).toBe("unknown");
    expect(r.message).not.toContain("<script>");
    expect(r.message.length).toBeLessThanOrEqual(240);
    expect(r.message.length).toBeGreaterThan(0);
  });

  it("falls back to a generic message when there is no error text", () => {
    const r = humanizeBrokerError(null);
    expect(r.code).toBe("unknown");
    expect(r.message).toBe(BROKER_ERROR_MESSAGES.unknown);
    expect(r.raw).toBeNull();
  });

  it("accepts { message } / { error } objects like edge-function response bodies", () => {
    expect(humanizeBrokerError({ message: "invalid login or password" }).code).toBe("auth_rejected");
    expect(humanizeBrokerError({ error: "Not enough money" }).code).toBe("insufficient_funds");
  });
});

describe("terminalStatus / isTerminalConnectionStatus", () => {
  it("classifies broker auth failures as terminal auth_rejected", () => {
    const t = terminalStatus("BROKER_AUTHORIZATION_ERROR", "DEPLOYED");
    expect(t.terminal).toBe(true);
    expect(t.code).toBe("auth_rejected");
    expect(t.message).toContain("server name");
  });

  it("classifies offline brokers as terminal broker_offline", () => {
    for (const cs of ["BROKER_OFFLINE", "BROKER_ERROR", "ERROR", "CONNECTION_ERROR"]) {
      expect(terminalStatus(cs, "DEPLOYED").code).toBe("broker_offline");
    }
  });

  it("classifies disabled accounts as account_blocked", () => {
    expect(terminalStatus("DISABLED", "DEPLOYED").code).toBe("account_blocked");
  });

  it("classifies a FAILED provisioning state as deploy_failed", () => {
    const t = terminalStatus("CONNECTING", "FAILED");
    expect(t.terminal).toBe(true);
    expect(t.code).toBe("deploy_failed");
  });

  it("treats healthy connecting states as non-terminal", () => {
    expect(terminalStatus("CONNECTING", "DEPLOYING").terminal).toBe(false);
    expect(terminalStatus("AUTHENTICATING", "DEPLOYED").terminal).toBe(false);
    expect(terminalStatus("CONNECTED", "DEPLOYED").terminal).toBe(false);
    expect(terminalStatus(null, null).terminal).toBe(false);
  });

  it("isTerminalConnectionStatus is case-insensitive and only true for terminal codes", () => {
    expect(isTerminalConnectionStatus("auth_error")).toBe(true);
    expect(isTerminalConnectionStatus("Broker_Offline")).toBe(true);
    expect(isTerminalConnectionStatus("CONNECTED")).toBe(false);
    expect(isTerminalConnectionStatus(null)).toBe(false);
    expect(isTerminalConnectionStatus(undefined)).toBe(false);
  });
});