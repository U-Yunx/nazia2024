# ANA24 — Forex & Crypto Trading Robot

Automated trading platform with a free paper-trading account, strategy
backtester, live signals, auto-tune, and secure live trading through OANDA and
MetaTrader — plus a referral/commission system with manual payouts.

## Stack

- **Frontend** — React 18 + TypeScript + Vite + Tailwind CSS v4
- **Charts** — lightweight-charts (candles, equity curves)
- **Backend** — Supabase (Auth, Postgres, Realtime, Edge Functions)
- **Deploy** — static SPA built with `npm run build` to `dist/`, published to
  Cloudflare as static assets (see [Deployment](#deployment)). `npm run dev`
  for local development.

## Getting started

```bash
npm install
npm run dev
```

Copy `.env.example` to `.env.local` and fill in `VITE_SUPABASE_URL` and
`VITE_SUPABASE_ANON_KEY` (both public/publishable). Without them the app shows
the "Supabase connection required" screen. On the hosted platform these are
injected automatically once a Supabase project is linked.

## Scripts

| Script          | Purpose                                   |
| --------------- | ----------------------------------------- |
| `npm run dev`   | Start the Vite dev server                 |
| `npm run build` | Production build to `dist/`               |
| `npm test`      | Run the Vitest unit tests                 |
| `npm run deploy`| Pre-deploy checks + production build      |
| `npm run deploy:cloudflare` | Credential preflight + build + Cloudflare upload |

## Deployment (Cloudflare)

The app is a static SPA. `vite build` writes `dist/`, which Cloudflare serves as
static assets — no Worker script is involved. The deployment is named
**`ana24`** and is declared in [`wrangler.toml`](./wrangler.toml), together with
two settings the deploy depends on:

- `[assets] directory = "./dist"` — the folder to upload. `wrangler deploy`
  **requires** either this or a Worker `main` entry-point; with neither it exits
  with *"Missing entry-point to Worker script or to assets directory"*.
- `not_found_handling = "single-page-application"` — deep links and hard
  refreshes (`/markets`, `/trading`, …) return `index.html` so React Router
  resolves them instead of 404ing.

> **Do not add a `_redirects` file for the SPA fallback.** The classic
> `/*  /index.html  200` line looks equivalent to the setting above, but
> Cloudflare validates it as an infinite loop and rejects the entire upload:
>
> ```
> Invalid _redirects configuration:
> Line 7: Infinite loop detected in this rule. This would cause a redirect to
> strip `.html` or `/index` and end up triggering this rule again. [code: 100324]
> ```
>
> The rewrite target `/index.html` is normalised back to `/`, which `/*` then
> matches again. `not_found_handling` above is the supported SPA fallback, so
> `public/_redirects` was removed. `wrangler deploy` is unaffected either way —
> the failure happens server-side, at upload.

`dist/` also ships `_headers` (CSP + security + caching), `404.html`,
`robots.txt` and `sitemap.xml`.

### Option A — direct upload (wrangler)

```bash
npm run deploy:cloudflare
```

This runs three steps, each failing fast with a clear message:

1. `scripts/check-cloudflare-env.mjs` — verifies deploy credentials are present
   and that `wrangler.toml` still declares a deployable `[assets]` target.
2. `npm run deploy` — `scripts/check-deploy-env.mjs` (public VITE vars **and**
   CSP/Supabase-ref drift guard) then the production build.
3. `wrangler deploy` — uploads `dist/` to the `ana24` deployment.

Required environment (CI secrets, never committed):

| Variable | What it is | Where to get it |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | API token, real secret | [Create a token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/) with "Workers Scripts — Edit" |
| `CLOUDFLARE_ACCOUNT_ID` | Your account ID (public) | Cloudflare dashboard → right sidebar |
| `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` | Public Supabase URL + anon key | Injected automatically when Supabase is linked |

### Option B — Git-integrated builds (Cloudflare dashboard)

Connect the repo to Cloudflare instead of uploading with wrangler. The dashboard
then runs:

- **Build command:** `npm ci && npm run build`
- **Deploy command:** `npx wrangler deploy`
- **Environment variables:** set `VITE_SUPABASE_URL` and
  `VITE_SUPABASE_ANON_KEY` (public) plus `NODE_VERSION=20.19.0`. Cloudflare's
  build image does **not** read `.nvmrc`, and Vite 7 requires Node 20.19+ /
  22.12+ — without `NODE_VERSION` the build can fail on an older default Node.
  Secrets (e.g. `CLOUDFLARE_API_TOKEN`) are not needed for this flow.

The deploy command is `npx wrangler deploy` (the Workers command), which is why
`wrangler.toml` must define an `[assets]` target. Don't mix the two models: if
you ever point the deploy command at a Pages upload
(`npx wrangler pages deploy dist --project-name=ana24`), the config has to go
back to a `pages_build_output_dir` project.

### Keeping the Supabase project ref in sync

`public/_headers` pins the Supabase project ref in the CSP `connect-src`
(`https://<ref>.supabase.co` + `wss://<ref>.supabase.co`). If the linked
Supabase project ever changes, update **both** `public/_headers` and
`VITE_SUPABASE_URL` — `npm run deploy` aborts the build if they drift, so a
browser-blocked-CSP deploy can't ship silently.

## Architecture

- `src/lib/` — pure logic: trading engine, risk math, strategies, indicators,
  backtests, platform API layer (Supabase), formatting, currency conversion.
- `src/hooks/` — React hooks: auth, market data (realtime quotes), platform
  data, saved strategies, paper account.
- `src/components/` — UI kit + shared components.
- `src/pages/` — routes (Home, Dashboard, Trading, Backtester, Signals,
  Strategies, Performance, Referrals, Gateway, Admin, …).
- `supabase/functions/` — Edge Functions: `market-data` (provider proxy),
  `broker-oanda` / `broker-mt` (live broker bridges via OANDA v20 and
  MetaApi), `broker-token` (scoped robot API tokens), `robot-runner`
  (background robot cycles), `news-ticker`.

## Live broker trading

- **OANDA** — the user saves their OANDA API token in the app; it is stored
  encrypted and used only server-side inside the `broker-oanda` bridge.
- **MetaTrader 4/5** — reached through the free cloud gateway at
  [metaapi.cloud](https://metaapi.cloud). Each user connects their MT account
  on the Brokers page and adds their own **free MetaApi API token**, which is
  validated against MetaApi (a security pass) and then auto-provisions and
  deploys the account in the MetaApi cloud. Admins can instead configure a
  single platform-wide `METAAPI_TOKEN` secret (general mode) that all
  connections trade through.
- The robot runs from the browser for paper/managed modes and through the
  `robot-runner` cron (every minute) for background runs.

## Security

- No secrets in the client bundle. API keys (market data providers, brokers,
  MetaApi) live in Supabase Edge Function secrets / encrypted at rest and are
  read server-side.
- Live broker trading is proxied through server-side bridges; broker
  credentials never reach the browser.
- Row Level Security on all user-scoped tables.

## Testing

`npm test` runs Vitest over `src/**/*.test.ts` — engine reducer, risk math,
strategy indicators, backtests, robot lifecycle and formatting helpers.
`node scripts/smoke-trading.mjs` runs the trading-engine smoke suite.