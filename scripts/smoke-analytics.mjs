#!/usr/bin/env node
/**
 * Smoke test for the Deep Analyst feature (the /analytics page + engine).
 *
 * Runs the deep-analyst unit suites (vitest) — the same targets QA/CI use —
 * and fails the script if anything breaks, so it can be wired into
 * predeploy/CI for a quick "is the analyst still sound?" gate.
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

if (res.status === 0) {
  console.log('✅ Smoke OK — Deep Analyst is healthy.')
  process.exit(0)
}
console.error('❌ Smoke FAILED — Deep Analyst suites did not pass.')
process.exit(res.status ?? 1)
