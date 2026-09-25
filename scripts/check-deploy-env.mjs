#!/usr/bin/env node
/**
 * Pre-deploy environment check for ANA24.
 *
 * Verifies that the variables the browser bundle needs at runtime are present
 * in the environment. This runs from `npm run deploy` (wired in package.json
 * before the production build). It exits non-zero if anything required is
 * missing so a broken deploy never ships.
 *
 * The two VITE_* values are PUBLIC (URL + publishable/anon key) — they are safe
 * to bake into the static bundle. No real secrets belong here.
 *
 * It also guards against a silent, easy-to-miss drift: `public/_headers` pins
 * the Supabase origin in its Content-Security-Policy `connect-src`. If that
 * project ref ever diverges from VITE_SUPABASE_URL, the app breaks in the
 * browser at runtime (Supabase calls blocked by CSP) while the build still
 * passes. We fail the deploy instead.
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const required = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY']

const missing = required.filter((key) => !process.env[key])

if (missing.length > 0) {
  console.error('[check-deploy-env] Missing required environment variables:')
  for (const key of missing) {
    console.error(`  - ${key}`)
  }
  console.error(
    '\nSet them in the platform Environment settings (Preview/Production) or a local .env.local, then retry.',
  )
  process.exit(1)
}

/**
 * Extract the project ref from a Supabase URL.
 * `https://abcdefghij.supabase.co` -> `abcdefghij`
 */
const supabaseRef = (() => {
  try {
    return new URL(process.env.VITE_SUPABASE_URL).hostname.split('.')[0] || null
  } catch {
    return null
  }
})()

if (!supabaseRef) {
  console.error(
    '[check-deploy-env] VITE_SUPABASE_URL is not a valid URL:',
    process.env.VITE_SUPABASE_URL,
  )
  console.error('Expected something like https://<project-ref>.supabase.co')
  process.exit(1)
}

const headersPath = resolve('public/_headers')

if (!existsSync(headersPath)) {
  console.error(`[check-deploy-env] public/_headers is missing (expected at ${headersPath}).`)
  console.error('public/_headers carries the CSP that must match the build-time Supabase project — do not ship without it.')
  process.exit(1)
}

const headers = readFileSync(headersPath, 'utf8')

// Scoped to the actual Content-Security-Policy header line (comments above it
// may legitimately mention "connect-src" — they must not be matched).
const cspLine = headers
  .split('\n')
  .find((line) => /^\s*Content-Security-Policy\s*:/i.test(line))

if (!cspLine) {
  console.error('[check-deploy-env] public/_headers has no Content-Security-Policy header.')
  console.error('Add one, including: connect-src \'self\' https://<ref>.supabase.co wss://<ref>.supabase.co')
  process.exit(1)
}

const connectSrcMatch = cspLine.match(/(?:^|;)\s*connect-src\s+([^;]+)/i)
const connectSrc = (connectSrcMatch && connectSrcMatch[1]?.trim()) || ''

if (!connectSrc) {
  console.error('[check-deploy-env] CSP header has no connect-src directive.')
  console.error('Add: connect-src \'self\' https://<ref>.supabase.co wss://<ref>.supabase.co')
  process.exit(1)
}

// The CSP connect-src must allow both the HTTPS API origin and the WSS
// realtime origin for the SAME Supabase project used at build time.
const expectedOrigins = [
  `https://${supabaseRef}.supabase.co`,
  `wss://${supabaseRef}.supabase.co`,
]

const missingOrigins = expectedOrigins.filter((origin) => !connectSrc.includes(origin))

if (missingOrigins.length > 0) {
  console.error(
    '[check-deploy-env] Supabase ref drift between VITE_SUPABASE_URL and public/_headers:',
  )
  console.error(`  VITE_SUPABASE_URL project ref: ${supabaseRef}`)
  console.error(`  connect-src: ${connectSrc.trim()}`)
  for (const origin of missingOrigins) {
    console.error(`  missing from connect-src: ${origin}`)
  }
  console.error(
    '\nUpdate the Content-Security-Policy connect-src in public/_headers to match,',
  )
  console.error('otherwise the browser will block all Supabase calls in production.')
  process.exit(1)
}

console.log('[check-deploy-env] All required variables present. Proceeding to deploy.')
process.exit(0)