/**
 * Thin wrapper over `supabase.functions.invoke` used by the trading pages and
 * the platform layer. Normalizes the many edge-function response shapes into a
 * single `{ data, error }` result and guards against an unconfigured client so
 * callers never need to know whether Supabase is connected.
 *
 * Error handling is deliberately strict: the user-facing `error` is ALWAYS
 * either (a) a real reason the edge function wrote for humans (its `message`
 * or a broker's own rejection text), (b) the caller's contextual `fallback`,
 * or (c) generic transport copy — never the client library's raw text
 * ("Failed to send a request to the Edge Function") and never a runtime
 * signature like "ReadTimeout: " (see lib/transportErrors.ts).
 */
import {
  FunctionsFetchError,
  FunctionsHttpError,
  FunctionsRelayError,
  type FunctionsError,
} from '@supabase/supabase-js'
import { isSupabaseConfigured, supabase } from './supabase'
import { TRANSPORT_MESSAGES, humanizeTransportError } from './transportErrors'

interface InvokeOptions {
  body?: unknown
  /** User-friendly message shown when the call itself fails. */
  fallback?: string
  /**
   * Client-side cap in ms — the request is aborted when the function takes
   * longer, so a stalled bridge surfaces as a clear timeout instead of hanging.
   * Defaults to the platform client default (60s); raise it per-call for
   * genuinely slow operations (e.g. MetaApi deployment).
   */
  timeout?: number
}

/** Matches the supabase-js functions-client default; overridable per call. */
const DEFAULT_INVOKE_TIMEOUT_MS = 60_000

interface EdgeErrorShape {
  error?: string
  message?: string
  /** Stable machine-readable failure code (e.g. 'auth_rejected'). */
  code?: string
  /** Raw broker/MetaApi detail kept for diagnostics. */
  details?: string
}

/**
 * Pick the reason an edge function wrote for HUMANS. The functions use `error`
 * for a machine code ("upstream", "internal", "unauthorized") and `message`
 * for the copy meant to be shown; broker-mt is the exception — it puts the
 * broker's own rejection text in `error` with no `message`. A single token
 * (no whitespace, short) is treated as a machine code, never user copy.
 */
function pickHumanReason(o: EdgeErrorShape): string | null {
  const message = typeof o.message === 'string' ? o.message.trim() : ''
  const error = typeof o.error === 'string' ? o.error.trim() : ''
  const isMachineCode = (s: string): boolean => s.length > 0 && s.length <= 24 && !/\s/.test(s)
  if (message && !isMachineCode(message)) return message
  if (error && !isMachineCode(error)) return error
  return message || error || null
}

/**
 * Best-effort extraction of a human-readable reason from an error body.
 * Transport/runtime signatures are never trusted — they return null so the
 * caller's friendly copy wins.
 */
async function reasonFromBody(body: unknown): Promise<string | null> {
  if (!body) return null
  if (typeof body === 'string') {
    const t = body.trim()
    if (t.length === 0 || t.length > 400) return null
    return humanizeTransportError(t) ?? t
  }
  if (typeof body === 'object') {
    const picked = pickHumanReason(body as EdgeErrorShape & { ok?: boolean })
    if (!picked) return null
    return humanizeTransportError(picked) ?? picked
  }
  return null
}

function extractMeta(body: unknown): { code?: string | null; details?: string | null } | null {
  if (!body || typeof body !== 'object') return null
  const o = body as { code?: unknown; details?: unknown }
  if (o.code === undefined && o.details === undefined) return null
  return {
    code: typeof o.code === 'string' ? o.code : null,
    details: typeof o.details === 'string' ? o.details : null,
  }
}

export interface FnResult<T> {
  data: T | null
  error: string | null
  /** Stable machine-readable failure code returned by the edge function, when present. */
  code?: string | null
  /** Raw broker/MetaApi detail for diagnostics, when the edge function included it. */
  details?: string | null
}

export async function fn<T>(
  name: string,
  options: InvokeOptions = {},
): Promise<FnResult<T>> {
  if (!isSupabaseConfigured) {
    return { data: null, error: options.fallback ?? 'Service not configured.' }
  }
  try {
    const { data, error } = await supabase.functions.invoke(name, {
      body: options.body as string | Record<string, unknown> | undefined,
      timeout: options.timeout ?? DEFAULT_INVOKE_TIMEOUT_MS,
    })
    if (error) {
      const err = error as FunctionsError
      // Non-2xx responses: the edge functions return `{ ok: false, error: "…" }`,
      // so the response body carries the REAL reason (e.g. the broker's own
      // rejection message, like an account the broker has blocked). Prefer it
      // over the generic fallback — otherwise a failed live-account load only
      // ever says "Could not load your MetaTrader account." and hides why.
      if (err instanceof FunctionsHttpError) {
        const body = await err.context?.json().catch(() => null)
        const meta = extractMeta(body)
        const real = await reasonFromBody(body)
        if (real) return { data: null, error: real, code: meta?.code ?? null, details: meta?.details ?? null }
        const status = err.context?.status
        return {
          data: null,
          error: status
            ? `The ${name} service returned an error (HTTP ${status}). Try again shortly.`
            : (options.fallback ?? TRANSPORT_MESSAGES.bad_gateway),
          code: meta?.code ?? null,
          details: meta?.details ?? null,
        }
      }
      // The relay couldn't reach the function, or the network request itself
      // failed (offline, blocked, timed out). The client library and the
      // runtime only ever give us mechanical text here ("Failed to send a
      // request to the Edge Function", "ReadTimeout: ") — never surface it.
      if (err instanceof FunctionsRelayError || err instanceof FunctionsFetchError) {
        const transport = humanizeTransportError(err.context ?? err.message)
        return {
          data: null,
          error: transport ?? options.fallback ?? TRANSPORT_MESSAGES.unreachable,
        }
      }
      return {
        data: null,
        error: options.fallback ?? humanizeTransportError(error) ?? TRANSPORT_MESSAGES.unreachable,
      }
    }
    if (data && typeof data === 'object' && 'error' in (data as object)) {
      const o = data as EdgeErrorShape
      const reason = pickHumanReason(o)
      if (reason) {
        return { data: null, error: reason, code: o.code ?? null, details: o.details ?? null }
      }
    }
    return { data: data as T, error: null }
  } catch (err) {
    // Last line of defence: never leak an unexpected runtime error either.
    return {
      data: null,
      error: options.fallback ?? humanizeTransportError(err) ?? TRANSPORT_MESSAGES.unreachable,
    }
  }
}