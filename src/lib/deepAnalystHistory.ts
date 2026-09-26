/**
 * Deep Analyst run history.
 *
 * Every analysis a signed-in user runs is stored server-side by the
 * `deep-analyst` Edge Function (deep_analyst_runs table, RLS-scoped to the
 * owner). This module reads that history back for the panel and converts a
 * stored row back into a renderable response, so a trader can reopen a past
 * verdict and its exact levels. Anonymous callers are never persisted.
 */

import type { AnalystStrategy, DeepAnalystResponse } from './deepAnalyst'

export interface AnalystRun {
  id: string
  symbol: string
  side: 'long' | 'short'
  entry_price: number | null
  mark: number | null
  engine: string
  ai_used: boolean
  model: string | null
  strategy: AnalystStrategy
  created_at: string
}

const ENGINE_LABEL: Record<string, string> = {
  gemini: 'Gemini',
  openai: 'OpenAI',
}

export function engineLabel(engine: string): string {
  return ENGINE_LABEL[engine] ?? 'Built-in engine'
}

/**
 * Structural subset of the supabase-js query builder (plus the offline no-op
 * stub), enough for `from().select().order().limit()` to resolve to
 * `{ data, error }`. Kept explicit so tests can drive it without a client.
 */
export interface HistoryQueryClient {
  from: (table: string) => {
    select: (columns?: string) => {
      order: (column: string, opts?: { ascending?: boolean }) => {
        limit: (count: number) => Promise<{ data: unknown[] | null; error: { message: string } | null }>
      }
    }
  }
}

const toRun = (r: unknown): AnalystRun => {
  const o = (r ?? {}) as Record<string, unknown>
  return {
    id: typeof o.id === 'string' ? o.id : String(o.id ?? ''),
    symbol: typeof o.symbol === 'string' ? o.symbol : '',
    side: o.side === 'short' ? 'short' : 'long',
    entry_price: typeof o.entry_price === 'number' ? o.entry_price : null,
    mark: typeof o.mark === 'number' ? o.mark : null,
    engine: typeof o.engine === 'string' ? o.engine : 'deterministic',
    ai_used: o.ai_used === true,
    model: typeof o.model === 'string' ? o.model : null,
    strategy: (o.strategy ?? {}) as AnalystStrategy,
    created_at: typeof o.created_at === 'string' ? o.created_at : '',
  }
}

/** Loads the caller's most recent analyses, newest first. Never throws. */
export async function fetchAnalystHistory(client: unknown, limit = 8): Promise<AnalystRun[]> {
  const q = client as HistoryQueryClient | null | undefined
  if (!q || typeof q.from !== 'function') return []
  try {
    const { data, error } = await q
      .from('deep_analyst_runs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit)
    if (error || !Array.isArray(data)) return []
    return data.map(toRun).filter((r) => r.id && r.created_at)
  } catch {
    return []
  }
}

/** Wraps a stored run back into the response shape the panel renders. */
export function runToResponse(run: AnalystRun): DeepAnalystResponse {
  const engine: DeepAnalystResponse['engine'] =
    run.engine === 'gemini' || run.engine === 'openai' ? run.engine : 'deterministic'
  return {
    ok: true,
    engine,
    ai_available: true,
    ai_requires_login: false,
    model: run.model ?? undefined,
    note: run.ai_used ? undefined : 'Past analysis from the built-in strategy engine.',
    strategy: run.strategy,
  }
}
