#!/usr/bin/env node
/**
 * Smoke test for the Deep Analyst feature (the /analytics page + engine).
 *
 * 1. Runs the deep-analyst unit suites (vitest) — the same targets QA/CI use.
 * 2. When the deployed edge function is reachable, verifies its live contract:
 *    an anonymous request must come back with the deterministic engine and a
 *    valid verdict — the exact shape the position panel and the Analytics
 *    history section rely on. Unreachable network is a warning, not a failure;
 *    a wrong response IS a failure.
 *
 * Usage: node scripts/smoke-analytics.mjs
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const targets = [
  'src/lib/deepAnalyst.test.ts',
  'src/lib/trading/deepAnalysis.test.ts',
  'src/lib/deepAnalystHistory.test.ts',
  'src/lib/strategies/capComparison.test.ts',
]

console.log('🧪 Smoke: Deep Analyst suites')
const res = spawnSync('npx', ['vitest', 'run', ...targets], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
})

if (res.status !== 0) {
  console.error('❌ Smoke FAILED — Deep Analyst suites did not pass.')
  process.exit(res.status ?? 1)
}

// --- Live contract check (best-effort) -------------------------------------
const FN_URL = 'https://xopygzpepikerwqxzqzu.supabase.co/functions/v1/deep-analyst'
const VERDICTS = ['hold', 'take_profit', 'partial_take_profit', 'trail', 'cut_loss', 'reduce_risk', 'stand_pat']

async function liveCheck() {
  const body = {
    position: {
      symbol: 'XAU/USD',
      side: 'long',
      units: 10,
      entryPrice: 2650,
      entryTime: new Date().toISOString(),
    },
    market: { mark: 2652, pnlUsd: 20, pnlPct: 0.1 },
    account: { mode: 'paper' },
  }
  const r = await fetch(FN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  const d = await r.json()
  if (d?.ok !== true) throw new Error('missing ok flag')
  if (d.engine !== 'deterministic') throw new Error(`unexpected engine: ${d.engine}`)
  if (!d.strategy || !VERDICTS.includes(d.strategy.verdict)) throw new Error('missing/unknown verdict')
  if (!Array.isArray(d.strategy.reasoning)) throw new Error('missing reasoning array')
  return d
}

try {
  const d = await liveCheck()
  console.log(
    `✅ Live contract OK — ${d.engine} engine · verdict ${d.strategy.verdict} · ai_requires_login ${d.ai_requires_login}`,
  )
  console.log('✅ Smoke OK — Deep Analyst is healthy.')
  process.exit(0)
} catch (err) {
  const isNetwork =
    err instanceof TypeError ||
    (err && typeof err === 'object' && 'name' in err && err.name === 'TimeoutError') ||
    /fetch|network|abort/i.test(String(err?.message ?? err))
  if (isNetwork) {
    console.warn(`⚠️  Live check skipped (edge function unreachable: ${err?.message ?? err}) — unit suites passed.`)
    process.exit(0)
  }
  console.error(`❌ Live contract FAILED — ${err?.message ?? err}`)
  process.exit(1)
}
