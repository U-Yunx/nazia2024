/**
 * Transport-level error normalisation.
 *
 * When an edge-function call fails at the transport layer, the message the
 * runtime hands back is mechanical, not human: the Supabase functions client
 * reports "Failed to send a request to the Edge Function", and the fetch
 * implementation underneath it (Deno / workerd / undici / the browser) reports
 * bare signatures like `ReadTimeout: `, `HeadersTimeout: `, `fetch failed` or
 * an `AbortError`.
 *
 * Those strings used to reach the UI verbatim, because:
 *   * `lib/functions.ts` prefers any short "real reason" over its friendly
 *     fallback copy, and fed the raw transport error into that path, and
 *   * `lib/platform.ts` returned `error.message` directly.
 *
 * The result was a literal `Error: ReadTimeout: ` on screen — no page, no
 * service, no action for the user to take.
 *
 * This module is the one place that decides:
 *   1. is this text a TRANSPORT failure rather than a business error?
 *      → `classifyTransportError`
 *   2. what should the user actually read about it? → `TRANSPORT_MESSAGES`
 *   3. what is the single human-facing message for a failed call?
 *      → `edgeErrorMessage`
 *
 * A broker/business message is never rewritten: the patterns below are anchored
 * on real runtime signatures (ReadTimeout, ETIMEDOUT, a 502/504 status…), not
 * on the bare word "timeout".
 *
 * Dependency-free, so it is unit-tested directly (transportErrors.test.ts).
 */

export type TransportFailure = 'timeout' | 'bad_gateway' | 'unreachable'

/** User-facing copy for each transport failure — never mentions the runtime. */
export const TRANSPORT_MESSAGES: Record<TransportFailure, string> = {
  timeout:
    'The request timed out before the service answered. Please try again — this usually clears up within a minute.',
  bad_gateway: 'The service is briefly unavailable. Please try again in a few seconds.',
  unreachable:
    "We couldn't reach the service. Check your internet connection and try again.",
}

/**
 * Ordered most-specific-first: the first pattern that matches wins, so the
 * timeout registry is checked before the generic network ones.
 */
const FAILURE_PATTERNS: ReadonlyArray<readonly [TransportFailure, RegExp]> = [
  // --- timed out -----------------------------------------------------------
  ['timeout', /read[\s_-]?timeout/i],
  ['timeout', /write[\s_-]?timeout/i],
  ['timeout', /headers?[\s_-]?timeout/i],
  ['timeout', /body[\s_-]?timeout/i],
  ['timeout', /connect[\s_-]?timeout/i],
  ['timeout', /gateway[\s_-]?timeout/i],
  ['timeout', /idle[\s_-]?timeout/i],
  ['timeout', /\btimed? ?out\b/i],
  ['timeout', /time[\s_-]?out (?:error|exceeded|of \d)/i],
  ['timeout', /\btimeouterror\b/i],
  ['timeout', /\betimedout\b/i],
  ['timeout', /\besockettimedout\b/i],
  ['timeout', /\bsignal timed out\b/i],
  ['timeout', /\b504\b/],
  // A client-side abort is almost always our own request timeout firing.
  ['timeout', /\baborterror\b/i],
  ['timeout', /\baborted\b/i],
  // --- gateway / upstream refused to answer --------------------------------
  ['bad_gateway', /\b50[23]\b/],
  ['bad_gateway', /bad gateway/i],
  ['bad_gateway', /service (?:temporarily )?unavailable/i],
  // --- connection never established / dropped ------------------------------
  ['unreachable', /failed to fetch/i],
  ['unreachable', /fetch failed/i],
  ['unreachable', /network\s?error/i],
  ['unreachable', /load failed/i],
  ['unreachable', /socket hang up/i],
  ['unreachable', /\b(?:econnreset|econnrefused|econnaborted|ehostunreach|enetunreach|eai_again|enotfound|epipe)\b/i],
  ['unreachable', /connection (?:reset|closed|refused|aborted|lost)/i],
  ['unreachable', /other side closed/i],
  ['unreachable', /broken pipe/i],
  ['unreachable', /\bterminated\b/i],
  ['unreachable', /und_err_/i],
  ['unreachable', /functionsfetch(?:error)?/i],
  ['unreachable', /functionsrelay(?:error)?/i],
]

/**
 * Flatten any error-ish value into searchable text. Handles the shapes a
 * transport failure actually arrives in: a plain string, an `Error`/
 * `DOMException` (name + message), an edge-function response wrapper, or an
 * error whose real cause is nested.
 */
function errorText(raw: unknown): string {
  if (raw === null || raw === undefined) return ''
  if (typeof raw === 'string') return raw.trim()
  if (typeof raw === 'object') {
    const o = raw as { name?: unknown; message?: unknown; error?: unknown; cause?: unknown }
    const parts: string[] = []
    if (typeof o.name === 'string' && o.name) parts.push(o.name)
    if (typeof o.message === 'string' && o.message) parts.push(o.message)
    if (parts.length === 0 && typeof o.error === 'string' && o.error) parts.push(o.error)
    if (parts.length === 0 && o.cause !== undefined) return errorText(o.cause)
    return parts.join(': ')
  }
  return String(raw)
}

/** Classify a value as a transport failure, or `null` when it isn't one. */
export function classifyTransportError(raw: unknown): TransportFailure | null {
  const text = errorText(raw)
  if (!text) return null
  for (const [kind, pattern] of FAILURE_PATTERNS) {
    if (pattern.test(text)) return kind
  }
  return null
}

/**
 * The user-facing message for a transport failure, or `null` when the value is
 * a business error that should keep its own wording (e.g. a broker rejection).
 */
export function humanizeTransportError(raw: unknown): string | null {
  const kind = classifyTransportError(raw)
  return kind ? TRANSPORT_MESSAGES[kind] : null
}

/**
 * Single funnel for "an edge-function call failed" copy.
 *
 * Anything the runtime or the client library produced (Error, DOMException,
 * response object, bare string) becomes either the caller's contextual fallback
 * or a transport message — never raw library/runtime text.
 */
export function edgeErrorMessage(raw: unknown, fallback: string): string {
  return humanizeTransportError(raw) ?? fallback
}
