# ANA24 — Forex & Crypto Trading Robot

Automated trading platform with a free paper-trading account, strategy
backtester, live signals, auto-tune, and secure live trading through OANDA and
MetaTrader — plus a referral/commission system with manual payouts.

## Stack

- **Frontend** — React 18 + TypeScript + Vite + Tailwind CSS v4
- **Charts** — lightweight-charts (candles, equity curves)
- **Backend** — Supabase (Auth, Postgres, Realtime, Edge Functions)
- **Deploy** — static SPA built with `npm run build` to `dist/`, deployable to
  Cloudflare Pages (see [Deployment](#deployment)). `npm run dev` for local
  development.

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
| `npm run deploy:pages` | Credential preflight + build + Cloudflare Pages upload |

## Deployment (Cloudflare Pages)

The app is a static SPA; `dist/` ships with Cloudflare Pages-friendly
`_redirects` (SPA fallback), `_headers` (CSP + security + caching), `404.html`,
`robots.txt` and `sitemap.xml`. The Pages project is named **`ana24`** and is
declared in [`wrangler.toml`](./wrangler.toml).

### Option A — direct upload (wrangler)

```bash
npm run deploy:pages
```

This runs three steps, each failing fast with a clear message:

1. `scripts/check-cloudflare-env.mjs` — verifies deploy credentials are present.
2. `npm run deploy` — `scripts/check-deploy-env.mjs` (public VITE vars **and**
   CSP/Supabase-ref drift guard) then the production build.
3. `wrangler pages deploy` — uploads `dist/` to the `ana24` Pages project.

Required environment (CI secrets, never committed):

| Variable | What it is | Where to get it |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | API token, real secret | [Create a token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/) with "Cloudflare Pages — Edit" |
| `CLOUDFLARE_ACCOUNT_ID` | Your account ID (public) | Cloudflare dashboard → right sidebar |
| `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` | Public Supabase URL + anon key | Injected automatically when Supabase is linked |

### Option B — Git-integrated builds (Pages dashboard)

Connect the repo in the Cloudflare Pages dashboard instead of using wrangler.
Then:

- **Build command:** `npm ci && npm run build`
- **Build output directory:** `dist`
- **Environment variables:** set `VITE_SUPABASE_URL` and
  `VITE_SUPABASE_ANON_KEY` (public) plus `NODE_VERSION=20.19.0`. Cloudflare
  Pages does **not** read `.nvmrc`, and Vite 7 requires Node 20.19+ / 22.12+ —
  without `NODE_VERSION` the build can fail on Pages' older default Node.
  Secrets (e.g. `CLOUDFLARE_API_TOKEN`) are not needed for this flow.

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