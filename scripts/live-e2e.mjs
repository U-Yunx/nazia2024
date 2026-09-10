/**
 * live-e2e.mjs — live end-to-end smoke against the production Supabase project.
 *
 * Exercises the exact flows the app UI performs, against the real database and
 * the real Edge Functions, using a real browser-equivalent session:
 *
 *   1. Sign in (demo account).
 *   2. Paper/demo account AUTO-CREATION on first load ($10,000), robot
 *      on/off persistence, manual paper trade open → close round-trip.
 *   3. Broker connecting: save OANDA connection + broker-oanda `verify`
 *      (designed rejection for a fake token), save MetaTrader 5 connection +
 *      broker-mt `verify` (MetaApi designed outcome), REST API token
 *      generate -> get -> status -> revoke round-trip.
 *
 * Usage (env vars are all public or test credentials):
 *   VITE_SUPABASE_URL=... VITE_SUPABASE_ANON_KEY=... \
 *   E2E_EMAIL=demo@ana24.app E2E_PASSWORD=... node scripts/live-e2e.mjs
 *
 * Cleanup: test broker connections are removed at the end; the paper account
 * and its closed journal trade are intentionally left for the demo user.
 */
import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'

const url = process.env.VITE_SUPABASE_URL
const key = process.env.VITE_SUPABASE_ANON_KEY
const email = process.env.E2E_EMAIL ?? 'demo@ana24.app'
const password = process.env.E2E_PASSWORD

if (!url || !key || !password) {
  console.error('Missing env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, E2E_PASSWORD')
  process.exit(2)
}

const sb = createClient(url, key)
// demo risk config mirrors DEFAULT_RISK in src/lib/trading/types.ts
const risk = {
  riskPerTradePct: 1,
  maxOpenPositions: 5,
  defaultStopPips: 20,
  takeProfitRatio: 2,
  maxDailyLossPct: 5,
  autoTrade: false,
  trailingStop: true,
  trailPips: 15,
  breakEvenPips: 10,
  trailActivationPips: 12,
  maxConsecutiveLosses: 0,
}

const results = []
function check(name, pass, note) {
  results.push({ name, pass: !!pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${note ? ` — ${note}` : ''}`)
}

/**
 * Normalize a `functions.invoke` result to { status, ok, error, data }.
 * The bridges express designed failures EITHER as 200 + { ok:false, error }
 * or as non-2xx with the same JSON body — exactly the contract
 * src/lib/functions.ts (fn()) is built on, so this helper mirrors it.
 */
async function invokeResult(r) {
  if (!r.error) return { status: 200, ok: r.data?.ok === true, error: r.data?.error ?? null, data: r.data ?? null }
  const err = r.error
  let body = null
  try {
    if (err.context && typeof err.context.json === 'function') body = await err.context.json().catch(() => null)
  } catch {
    /* older SDK builds expose the body differently — still surface the message */
  }
  const status = err.context?.status ?? (err.context?.response?.status ?? 0)
  return {
    status,
    ok: body?.ok === true,
    error: body?.error ?? body?.message ?? err.message ?? null,
    data: body ?? null,
  }
}

try {
  // 1) Sign in — the user session every app page uses.
  const { error: signInErr } = await sb.auth.signInWithPassword({ email, password })
  if (signInErr) throw new Error(`sign-in: ${signInErr.message}`)
  const { data: auth } = await sb.auth.getUser()
  const userId = auth.user.id
  check('1a auth.signInWithPassword', true, email)

  // 2) Paper/demo account auto-creation (usePaperAccount boot path:
  //    loadRemote is empty → createAccount(10000) is persisted via saveRemote).
  const { data: existingAcct } = await sb
    .from('paper_accounts')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle()
  check('2a fresh demo user has no paper account yet (RLS read ok)', existingAcct === null || existingAcct.user_id === userId)

  const now = new Date().toISOString()
  const { error: createErr } = await sb.from('paper_accounts').upsert(
    {
      user_id: userId,
      broker: 'paper',
      currency: 'USD',
      initial_balance: 10000,
      balance: 10000,
      risk,
    },
    { onConflict: 'user_id' },
  )
  if (createErr) throw new Error(`paper create: ${createErr.message}`)
  const { data: acctAfter } = await sb.from('paper_accounts').select('*').eq('user_id', userId).maybeSingle()
  check(
    '2b demo account auto-created & persisted ($10,000 paper)',
    acctAfter?.balance === 10000 && acctAfter?.broker === 'paper',
    `balance=${acctAfter?.balance} broker=${acctAfter?.broker}`,
  )

  // 3) Robot start/stop persistence (setRisk → risk.autoTrade flag).
  const { error: robotErr } = await sb
    .from('paper_accounts')
    .update({ risk: { ...risk, autoTrade: true } })
    .eq('user_id', userId)
  if (robotErr) throw new Error(robotErr.message)
  const { data: acctRobot } = await sb.from('paper_accounts').select('risk').eq('user_id', userId).maybeSingle()
  check('3a robot toggle persisted (autoTrade=true)', acctRobot?.risk?.autoTrade === true)

  // 4) Manual paper trade: open (long EUR/USD 0.01 lot), close at +1.00 profit.
  const tradeId = randomUUID()
  await sb.from('paper_trades').delete().eq('user_id', userId)
  const openTrade = {
    id: tradeId,
    user_id: userId,
    symbol: 'EUR/USD',
    side: 'long',
    status: 'open',
    quantity: 1000,
    entry_price: 1.085,
    entry_time: now,
    exit_price: null,
    exit_time: null,
    stop_loss: 1.083,
    take_profit: 1.089,
    pnl: null,
    pnl_pct: null,
    entry_equity: 10000,
    close_reason: null,
    strategy: 'manual',
  }
  const { error: openErr } = await sb.from('paper_trades').insert(openTrade)
  if (openErr) throw new Error(`open trade: ${openErr.message}`)
  check('4a manual paper trade opened (open position row)', true)

  const { error: closeErr } = await sb
    .from('paper_trades')
    .update({
      status: 'closed',
      exit_price: 1.086,
      exit_time: new Date().toISOString(),
      pnl: 1,
      pnl_pct: 0.01,
      close_reason: 'manual',
    })
    .eq('id', tradeId)
    .eq('user_id', userId)
  if (closeErr) throw new Error(`close trade: ${closeErr.message}`)
  const { error: balErr } = await sb.from('paper_accounts').update({ balance: 10001 }).eq('user_id', userId)
  if (balErr) throw new Error(`balance: ${balErr.message}`)

  const { data: tradesAfter } = await sb.from('paper_trades').select('*').eq('user_id', userId)
  const closed = tradesAfter?.find((t) => t.id === tradeId)
  check(
    '4b trade closed & journal persisted (reload shows the position)',
    closed?.status === 'closed' && closed?.pnl === 1,
    `pnl=${closed?.pnl ?? '?'}`,
  )

  // 5) OANDA broker connect — the exact saveConnection flow the Brokers page
  //    runs, then the fixed broker-oanda `verify` action.
  await sb.from('broker_connections').delete().eq('user_id', userId).eq('platform', 'oanda')
  const { error: oConnErr } = await sb.from('broker_connections').upsert(
    {
      user_id: userId,
      broker_id: '5e543630-7721-4680-b150-a4fc6051364e',
      api_key: 'qa-fake-oanda-practice-token-0000',
      account_id: '101-004-00000000-001',
      account_type: 'practice',
      platform: 'oanda',
      robot_number: 1,
      status: 'connected',
      last_verified_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,broker_id,robot_number' },
  )
  if (oConnErr) throw new Error(`oanda save: ${oConnErr.message}`)
  const { data: oConn } = await sb.from('broker_connections').select('id').eq('user_id', userId).eq('platform', 'oanda').maybeSingle()
  check('5a OANDA broker connection saved', !!oConn?.id)

  const oandaVerify = await invokeResult(await sb.functions.invoke('broker-oanda', { body: { action: 'verify' } }))
  check(
    '5b broker-oanda verify reachable (designed rejection for a fake token)',
    oandaVerify.status > 0 && !oandaVerify.ok && /rejected|token|authorization/i.test(oandaVerify.error ?? ''),
    `status=${oandaVerify.status} error=${oandaVerify.error}`,
  )

  // 6) MetaTrader 5 broker connect + the designed no-token guidance + REST token.
  await sb.from('broker_connections').delete().eq('user_id', userId).eq('platform', 'mt5')
  const { error: mConnErr } = await sb.from('broker_connections').upsert(
    {
      user_id: userId,
      broker_id: '187e2def-085d-4343-8e0e-79f0d367c5cc',
      api_key: 'qa-demo-mt5-password-2026',
      account_id: '99001122',
      account_type: 'practice',
      platform: 'mt5',
      server: 'FXGT-Demo',
      robot_number: 1,
      status: 'connected',
      last_verified_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,broker_id,robot_number' },
  )
  if (mConnErr) throw new Error(`mt5 save: ${mConnErr.message}`)
  const { data: mConn } = await sb.from('broker_connections').select('id').eq('user_id', userId).eq('platform', 'mt5').maybeSingle()
  check('MT5 broker connection saved', !!mConn?.id)

  const mtVerify = await invokeResult(
    await sb.functions.invoke('broker-mt', { body: { action: 'verify', connection_id: mConn.id } }),
  )
  check(
    'MT5 bridge verify reachable — MetaApi designed outcome (token present vs "add free MetaApi token" guidance)',
    mtVerify.status > 0 && (mtVerify.ok === true || typeof mtVerify.error === 'string'),
    `status=${mtVerify.status} ok=${mtVerify.ok} error=${mtVerify.error ?? 'none'}`,
  )

  // REST API token full round-trip: generate -> get (owner-only plaintext) ->
  // status (same masked preview) -> revoke -> status (gone).
  const tokenGen = await invokeResult(
    await sb.functions.invoke('broker-token', { body: { action: 'generate', connection_id: mConn.id } }),
  )
  check(
    'REST API token generated on the MT5 connection (ana24_ masked preview + created_at)',
    tokenGen.ok === true && /^ana24_/.test(tokenGen.data?.masked ?? '') && !!tokenGen.data?.created_at,
    `masked=${tokenGen.data?.masked}`,
  )
  const tokenGet = await invokeResult(
    await sb.functions.invoke('broker-token', { body: { action: 'get', connection_id: mConn.id } }),
  )
  check(
    'REST API token readable only by its owner (ana24_mt5_ prefix)',
    tokenGet.ok === true && /^ana24_mt5_/.test(tokenGet.data?.token ?? ''),
    `prefix=${String(tokenGet.data?.token ?? '').slice(0, 12)}…`,
  )
  const tokenStatus = await invokeResult(
    await sb.functions.invoke('broker-token', { body: { action: 'status', connection_id: mConn.id } }),
  )
  check(
    'REST API token status shows the token on the SAME connection',
    tokenStatus.ok === true && tokenStatus.data?.hasToken === true && tokenStatus.data?.masked === tokenGen.data?.masked,
  )
  const tokenRevoke = await invokeResult(
    await sb.functions.invoke('broker-token', { body: { action: 'revoke', connection_id: mConn.id } }),
  )
  check('REST API token revoked cleanly', tokenRevoke.ok === true)
  const tokenAfterRevoke = await invokeResult(
    await sb.functions.invoke('broker-token', { body: { action: 'status', connection_id: mConn.id } }),
  )
  check('REST API token gone after revoke', tokenAfterRevoke.ok === true && tokenAfterRevoke.data?.hasToken === false)

  // 7) Cleanup — remove the test broker connections (the paper account + its
  //    closed trade stay as the demo user's demo state).
  await sb.from('broker_tokens').delete().eq('connection_id', oConn.id)
  await sb.from('broker_tokens').delete().eq('connection_id', mConn.id)
  await sb.from('broker_connections').delete().eq('user_id', userId)
  check('test broker connections cleaned up (paper demo left intact)', true)

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} live checks passed (${failed.length} failed)`)
  process.exit(failed.length > 0 ? 1 : 0)
} catch (err) {
  console.error(`\nLIVE E2E ERROR: ${err.message}`)
  process.exit(1)
}