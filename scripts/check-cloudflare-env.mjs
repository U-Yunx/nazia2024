#!/usr/bin/env node
/**
 * Pre-deploy credential check for the Cloudflare Pages upload step.
 *
 * Runs BEFORE the production build (wired in package.json -> deploy:pages) so a
 * deploy that cannot be uploaded never wastes a build — it fails fast with a
 * clear, actionable message instead of the cryptic wrangler auth error.
 *
 * Checks:
 *   1. CLOUDFLARE_API_TOKEN  — Cloudflare API token (a REAL secret; keep it in
 *      CI/environment secrets, never in the repo or client bundle).
 *   2. CLOUDFLARE_ACCOUNT_ID — the account that owns the `ana24` project
 *      (public, but required for Pages deploys).
 *   3. wrangler.toml exists and declares the project name the deploy expects.
 *
 * Create an API token here:
 *   https://developers.cloudflare.com/fundamentals/api/get-started/create-token/
 * The token needs the "Cloudflare Pages — Edit" permission for the account.
 * Find your account ID on the Cloudflare dashboard right sidebar (or under
 * Workers & Pages -> your project -> Settings).
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const EXPECTED_PROJECT = 'ana24'
const errors = []

if (!process.env.CLOUDFLARE_API_TOKEN) {
  errors.push(
    '- CLOUDFLARE_API_TOKEN is not set.\n' +
      '    Create a token with the "Cloudflare Pages — Edit" permission at\n' +
      '    https://developers.cloudflare.com/fundamentals/api/get-started/create-token/\n' +
      '    and expose it to the deploy step (CI secret / environment).\n' +
      '    It is a secret — never commit it or put it in a .env file that ships.',
  )
}

if (!process.env.CLOUDFLARE_ACCOUNT_ID) {
  errors.push(
    '- CLOUDFLARE_ACCOUNT_ID is not set.\n' +
      '    Find it in the Cloudflare dashboard (right sidebar of any page, or\n' +
      '    Workers & Pages -> your project -> Settings) and expose it to the\n' +
      '    deploy step as an environment variable.',
  )
}

const configPath = resolve('wrangler.toml')
if (!existsSync(configPath)) {
  errors.push(
    `- wrangler.toml is missing (expected at ${configPath}).\n` +
      '    The Pages project config drives the upload; without it the deploy\n' +
      '    has no project name or output directory.',
  )
} else {
  const config = readFileSync(configPath, 'utf8')
  if (!new RegExp(`^name\\s*=\\s*["']${EXPECTED_PROJECT}["']`, 'm').test(config)) {
    errors.push(
      `- wrangler.toml does not declare name = "${EXPECTED_PROJECT}".\n` +
        `    The deploy targets the Cloudflare Pages project "${EXPECTED_PROJECT}".`,
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
  '[check-cloudflare-env] Cloudflare credentials present. Proceeding to build + deploy.',
)
process.exit(0)
