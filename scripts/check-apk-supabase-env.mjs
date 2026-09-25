#!/usr/bin/env node
/**
 * Preflight + post-build verification that the APK ships with Supabase wired up.
 *
 * The Android app runs the same Vite web bundle inside a WebView, and
 * `src/lib/supabase.ts` reads `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`
 * through `import.meta.env` — so the values are baked into the bundle **only if
 * they are present when `vite build` runs**. Those two values are public by
 * design (URL + anon/publishable key, protected by RLS server-side), so baking
 * them into the APK is safe; no real secret belongs here.
 *
 * Modes:
 *   node scripts/check-apk-supabase-env.mjs            → preflight, run BEFORE
 *     `npm run build`. Fails fast with a readable message if the Supabase env
 *     vars are missing or malformed, so `npm run apk:publish` never produces a
 *     silent demo-mode APK.
 *   node scripts/check-apk-supabase-env.mjs --verify   → run AFTER `npm run
 *     build` (and after `cap sync android` copies dist/ into the native app).
 *     Greps the built JS bundle and asserts the injected values are really
 *     there — proving the injection happened end-to-end.
 *
 * Exit 0 = ready / verified. Exit 1 = not, with the fix spelled out.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const log = (message) => console.log(`[check-apk-supabase-env] ${message}`)
const fail = (message) => {
  console.error(`[check-apk-supabase-env] ${message}`)
  process.exit(1)
}

const REQUIRED = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY']

/* ------------------------------- Preflight ------------------------------- */

function preflight() {
  const missing = REQUIRED.filter((key) => !process.env[key])

  if (missing.length > 0) {
    console.error('[check-apk-supabase-env] Missing required environment variables:')
    for (const key of missing) console.error(`  - ${key}`)
    console.error(
      '\nWithout them the APK would ship with the offline no-op Supabase client — the app\n' +
        'would boot in demo mode and every data-driven page (login, robots, trades) would\n' +
        'silently not work. Add them to your environment (the platform Environment\n' +
        'settings, or a local .env.local) and re-run the same command.',
    )
    process.exit(1)
  }

  const url = process.env.VITE_SUPABASE_URL
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    fail(
      `VITE_SUPABASE_URL is not a valid URL: ${url}\n` +
        '  Expected something like https://<project-ref>.supabase.co',
    )
  }

  if (parsed.protocol !== 'https:') {
    fail(`VITE_SUPABASE_URL must be https:// (got ${parsed.protocol}//) — Supabase traffic is always HTTPS.`)
  }

  const anonKey = process.env.VITE_SUPABASE_ANON_KEY
  if (anonKey.trim().length < 20) {
    fail('VITE_SUPABASE_ANON_KEY looks too short to be a real key — double-check it in the platform Environment settings.')
  }

  // Anon keys are JWTs ("eyJ…"). Don't fail on it (custom auth configs exist),
  // but surface it loudly — a wrong key ships an APK that can't reach the API.
  if (!/^eyJ/.test(anonKey.trim())) {
    console.warn(
      '[check-apk-supabase-env] WARNING: VITE_SUPABASE_ANON_KEY does not look like a JWT (does not start with "eyJ").\n' +
        '  It may still be valid, but verify it is the *anon* key, not a secret/service key — a secret key in the\n' +
        '  bundle would be exposed to anyone who unpacks the APK.',
    )
  }

  log(`Supabase env present — ${parsed.host}`)
  return parsed.host
}

/* ----------------------- Post-build bundle verify ------------------------ */

/**
 * The built bundle is minified, so the URL and the key's distinctive prefix
 * survive verbatim in the JS. Check the actual dist output (which `cap sync`
 * copies into the APK) — this proves the injection end-to-end.
 */
function verify() {
  const dist = 'dist'
  if (!existsSync(dist)) {
    fail(`No ${dist}/ directory found. Run "npm run build" first, then re-run this check with --verify.`)
  }

  const url = process.env.VITE_SUPABASE_URL
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY

  if (!url || !anonKey) {
    fail('Cannot verify the bundle: VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are not set in this environment.')
  }

  const assetsDir = join(dist, 'assets')
  const files = existsSync(assetsDir)
    ? readdirSync(assetsDir).filter((name) => name.endsWith('.js'))
    : []

  if (files.length === 0) {
    fail(`No JS bundle found in ${assetsDir}/. The build may have failed — check the vite output.`)
  }

  // The URL hostname discriminates *which* project the APK talks to. The full
  // anon key (not a prefix — the first ~36 chars are a shared JWT header) proves
  // the exact key was baked in. Both survive minification verbatim as string
  // literals, so a full match is reliable.
  const urlRef = (() => {
    try {
      return new URL(url).hostname
    } catch {
      return null
    }
  })()

  const key = anonKey.trim()
  let foundUrl = false
  let foundKey = false

  for (const file of files) {
    const contents = readFileSync(join(assetsDir, file), 'utf8')
    if (!foundUrl && urlRef && contents.includes(urlRef)) foundUrl = true
    if (!foundKey && key && contents.includes(key)) foundKey = true
  }

  if (!foundUrl || !foundKey) {
    const missing = []
    if (!foundUrl) missing.push(`the Supabase URL (${urlRef ?? url})`)
    if (!foundKey) missing.push('the anon key')
    fail(
      `The built bundle does not contain ${missing.join(' and ')} — Supabase was NOT injected.\n` +
        '  This usually means the env vars were absent when "vite build" ran. Re-run with them set.\n' +
        '  NOTE: if Vite defined the var but the value changed, rebuild — dist/ is stale.',
    )
  }

  log(`Verified ${files.length} bundle file(s) — Supabase URL + anon key are baked into the APK source.`)
  process.exit(0)
}

/* --------------------------------- Entry --------------------------------- */

if (process.argv.includes('--verify')) {
  verify()
} else {
  preflight()
}
