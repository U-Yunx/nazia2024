import { describe, expect, it } from 'vitest'
import { isSupabaseConfigured, supabase } from './supabase'

/**
 * These tests pin the offline no-op client behaviour: with no Supabase env vars
 * configured (as in CI and fresh previews), every direct query must resolve to
 * `{ data: null, error: null }` instead of throwing "Cannot read properties of
 * null". This is what keeps the landing page and the data hooks from crashing
 * before a Supabase project is linked.
 */
describe('offline supabase client', () => {
  it('is disabled when no env vars are set', () => {
    expect(isSupabaseConfigured).toBe(false)
  })

  it('resolves full select() chains without throwing', async () => {
    const res = await supabase
      .from('packages')
      .select('*')
      .eq('active', true)
      .order('created_at', { ascending: false })
      .limit(10)
      .maybeSingle()
    expect(res).toEqual({ data: null, error: null })
  })

  it('resolves simpler select() chains used by page hooks', async () => {
    const res = await supabase.from('profiles').select('*').is('read_at', null).limit(50)
    expect(res).toEqual({ data: null, error: null })
  })

  it('resolves rpc() calls without throwing', async () => {
    const res = await supabase.rpc('public_user_stats')
    expect(res).toEqual({ data: null, error: null })
  })

  it('resolves insert / update / upsert / delete chains', async () => {
    const queries = [
      supabase.from('packages').insert({ name: 'x' }),
      supabase.from('packages').update({ name: 'x' }).eq('id', '1'),
      supabase.from('packages').upsert({ name: 'x' }),
      supabase.from('packages').delete().eq('id', '1'),
    ]
    for (const q of queries) {
      expect(await q).toEqual({ data: null, error: null })
    }
  })

  it('resolves edge-function invocations without throwing', async () => {
    const res = await supabase.functions.invoke('market-data', { body: { action: 'market_config' } })
    expect(res).toEqual({ data: null, error: null })
  })
})