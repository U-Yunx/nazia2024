/**
 * Thin wrapper over `supabase.functions.invoke` used by the trading pages and
 * the platform layer. Normalizes the many edge-function response shapes into a
 * single `{ data, error }` result and guards against an unconfigured client so
 * callers never need to know whether Supabase is connected.
 */
import {
  FunctionsFetchError,
  FunctionsHttpError,
  FunctionsRelayError,
  type FunctionsError,
} from '@supabase/supabase-js'
import { isSupabaseConfigured, supabase } from './supabase'

interface InvokeOptions {
  body?: unknown
  /** User-friendly message shown when the call itself fails. */
  fallback?: string
}

interface EdgeErrorShape {
  error?: string
  message?: string
  /** Stable machine-readable failure code (e.g. 'auth_rejected'). */
  code?: string
  /** Raw broker/MetaApi detail kept for diagnostics. */
  details?: string
}

/** Best-effort extraction of a human-readable reason from an error body. */
async function reasonFromBody(body: unknown): Promise<string | null> {
  if (!body) return null
  if (typeof body === 'string') {
    const t = body.trim()
    return t.length > 0 && t.length <= 400 ? t : null
  }
  if (typeof body === 'object') {
    const o = body as EdgeErrorShape & { ok?: boolean }
    // Edge functions return `{ ok: false, error: "…" }` — prefer the real
    // broker/gateway reason over the generic fallback so a failed live-account
    // load never just says "Could not load your MetaTrader account."
    if (typeof o.error === 'string' && o.error.trim()) return o.error.trim()
    if (typeof o.message === 'string' && o.message.trim()) return o.message.trim()
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
            : (options.fallback ?? error.message),
          code: meta?.code ?? null,
          details: meta?.details ?? null,
        }
      }
      // The relay couldn't reach the function, or the network request itself
      // failed (offline, blocked, timed out). Surface the underlying reason
      // when it's short and useful; otherwise keep the caller's fallback.
      if (err instanceof FunctionsRelayError || err instanceof FunctionsFetchError) {
        const real = await reasonFromBody(err.context ?? err.message)
        return { data: null, error: real ?? options.fallback ?? error.message }
      }
      return { data: null, error: options.fallback ?? error.message }
    }
    if (data && typeof data === 'object' && 'error' in (data as object)) {
      const o = data as EdgeErrorShape
      if (o.error) {
        return { data: null, error: o.message ?? o.error, code: o.code ?? null, details: o.details ?? null }
      }
    }
    return { data: data as T, error: null }
  } catch {
    return { data: null, error: options.fallback ?? 'Could not reach the service.' }
  }
}