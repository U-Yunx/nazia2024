#!/usr/bin/env node
/**
 * Pre-deploy credential check for the Cloudflare upload step.
 *
 * Runs BEFORE the production build (wired in package.json -> deploy:cloudflare)
 * so a deploy that cannot be uploaded never wastes a build — it fails fast with
 * a clear, actionable message instead of the cryptic wrangler auth error.
 *
 * Checks:
 *   1. CLOUDFLARE_API_TOKEN  — Cloudflare API token (a REAL secret; keep it in
 *      CI/environment secrets, never in the repo or the client bundle).
 *   2. CLOUDFLARE_ACCOUNT_ID — the account that owns the `ana24` deployment
 *      (public, but required when the token can reach several accounts).
 *   3. wrangler.toml exists, declares the expected deployment name, and defines
 *      a deployable target — an `[assets]` directory or a `main` script.
 *      Without a target, `wrangler deploy` exits with "Missing entry-point to
 *      Worker script or to assets directory".
 *
 * Create an API token here:
 *   https://developers.cloudflare.com/fundamentals/api/get-started/create-token/
 * The token needs the "Workers Scripts — Edit" permission for the account.
 * Find your account ID on the Cloudflare dashboard right sidebar.
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const EXPECTED_PROJECT = 'ana24'
const errors = []

if (!process.env.CLOUDFLARE_API_TOKEN) {
  errors.push(
    '- CLOUDFLARE_API_TOKEN is not set.\n' +
      '    Create a token with the "Workers Scripts — Edit" permission at\n' +
      '    https://developers.cloudflare.com/fundamentals/api/get-started/create-token/\n' +
      '    and expose it to the deploy step (CI secret / environment).\n' +
      '    It is a secret — never commit it or put it in a .env file that ships.',
  )
}

if (!process.env.CLOUDFLARE_ACCOUNT_ID) {
  errors.push(
    '- CLOUDFLARE_ACCOUNT_ID is not set.\n' +
      '    Find it in the Cloudflare dashboard (right sidebar of any page, or\n' +
      '    Workers & Pages -> your deployment -> Settings) and expose it to the\n' +
      '    deploy step as an environment variable.',
  )
}

const configPath = resolve('wrangler.toml')
if (!existsSync(configPath)) {
  errors.push(
    `- wrangler.toml is missing (expected at ${configPath}).\n` +
      '    The config drives the upload: without it there is no deployment name\n' +
      '    and no assets directory to publish.',
  )
} else {
  const config = readFileSync(configPath, 'utf8')

  if (!new RegExp(`^name\\s*=\\s*["']${EXPECTED_PROJECT}["']`, 'm').test(config)) {
    errors.push(
      `- wrangler.toml does not declare name = "${EXPECTED_PROJECT}".\n` +
        `    The deploy targets the Cloudflare deployment "${EXPECTED_PROJECT}".`,
    )
  }

  // `wrangler deploy` needs a Worker entry-point (`main`) or an assets
  // directory (`[assets]`). A Pages-era config (only `pages_build_output_dir`)
  // has neither, which is exactly how the deploy dies with "Missing
  // entry-point to Worker script or to assets directory". Catch it here, before
  // a build is wasted.
  const hasMain = /^\s*main\s*=/m.test(config)
  const hasAssets = /^\s*\[assets\]/m.test(config)

  if (!hasMain && !hasAssets) {
    errors.push(
      '- wrangler.toml defines no deployable target.\n' +
        '    `wrangler deploy` needs either a Worker entry-point:\n' +
        '      main = "src/index.ts"\n' +
        '    or a static assets directory:\n' +
        '      [assets]\n' +
        '      directory = "./dist"\n' +
        '    Without one the upload fails with "Missing entry-point to Worker\n' +
        '    script or to assets directory".',
    )
  }
}

if (errors.length > 0) {
  console.error('[check-cloudflare-env] Cloudflare deploy preflight FAILED:\n')
  for (const message of errors) console.error(message)
  console.error(
    '\nSet the missing values, then retry. Nothing was built or uploaded.',
  )
  process.exit(1)
}

console.log(
  '[check-cloudflare-env] Cloudflare credentials and config present. Proceeding to build + deploy.',
)
process.exit(0)
