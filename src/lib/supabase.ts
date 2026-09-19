import { createClient } from '@supabase/supabase-js'

/**
 * Supabase client for the ANA24 platform.
 *
 * The URL + anon key are public (safe to ship to the browser) and are wired via
 * `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`. All privileged work — broker
 * bridges, payments, market data — happens inside Edge Functions that read real
 * secrets server-side, never here.
 */
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const isSupabaseConfigured = Boolean(url && anonKey)

/* ----------------------------- offline no-op client -------------------------
 * When the env vars are missing (local/demo run before a project is linked),
 * the exported client below is a null-safe no-op stub instead of `null`.
 *
 * Every direct query in the app — `platform.ts` (profiles, packages, brokers,
 * notifications…), trading persistence, watchlist, tokens — calls
 * `supabase.from(...).select(...)`, `supabase.rpc(...)` or
 * `supabase.functions.invoke(...)` WITHOUT checking `isSupabaseConfigured`.
 * If the client were `null`, those calls would throw "Cannot read properties
 * of null (reading 'rpc')" and crash every data-driven page on mount.
 *
 * The stub resolves every chain/await to `{ data: null, error: null }`, so
 * callers fall through to their existing empty-state defaults (empty arrays,
 * zeroed counters) and the app runs in demo mode instead of crashing.
 * Guarded consumers — useAuth, the edge-function wrapper in lib/functions.ts,
 * realtime in useMarketData — already check `isSupabaseConfigured` and skip
 * their work entirely, so the stub only ever serves the unguarded reads.
 * -------------------------------------------------------------------------- */

const NOOP_RESULT = Object.freeze({ data: null, error: null }) as { data: null; error: null }

/** Query-builder methods exercised across the codebase (plus common aliases). */
const CHAIN_METHODS = [
  'select',
  'insert',
  'update',
  'upsert',
  'delete',
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'is',
  'in',
  'match',
  'order',
  'limit',
  'range',
  'single',
  'maybeSingle',
  'or',
  'filter',
  'not',
  'returns',
]

/**
 * Chainable no-op query builder: `from('t').select('*').eq('a', 1).maybeSingle()`
 * (or any insert/update/upsert/delete variant) resolves to NOOP_RESULT no matter
 * where in the chain it is awaited. `then`/`catch` stay native because they are
 * never overwritten.
 */
function noopChain(): unknown {
  const chain = Promise.resolve(NOOP_RESULT) as Promise<{ data: null; error: null }> & Record<string, () => unknown>
  for (const method of CHAIN_METHODS) chain[method] = () => chain
  return chain
}

/** No-op client used when `isSupabaseConfigured` is false. */
const offlineClient: Record<string, unknown> = {
  from: noopChain,
  rpc: () => Promise.resolve(NOOP_RESULT),
  functions: { invoke: () => Promise.resolve(NOOP_RESULT) },
  auth: {
    getSession: () => Promise.resolve({ data: { session: null }, error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    signInWithPassword: () => Promise.resolve({ data: { user: null, session: null }, error: null }),
    signUp: () => Promise.resolve({ data: { user: null, session: null }, error: null }),
    signOut: () => Promise.resolve({ error: null }),
    updateUser: () => Promise.resolve({ data: { user: null }, error: null }),
    resetPasswordForEmail: () => Promise.resolve({ data: {}, error: null }),
  },
  /** Realtime channel stub — reached only if a caller skips the configured guard. */
  channel: () => {
    const channel: Record<string, unknown> = {
      on: () => channel,
      subscribe: () => channel,
      unsubscribe: () => undefined,
    }
    return channel
  },
  removeChannel: () => undefined,
}

export const supabase = isSupabaseConfigured
  ? createClient(url as string, anonKey as string, {
      auth: {
        // Implicit flow (not PKCE) keeps sign-in working inside the managed
        // preview iframe; the session persists in localStorage like before.
        persistSession: true,
        flowType: 'implicit',
        autoRefreshToken: true,
      },
    })
  : (offlineClient as unknown as ReturnType<typeof createClient>)