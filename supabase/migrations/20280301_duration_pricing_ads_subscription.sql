-- v2.11 — Duration-priced main subscription + ads subscription add-on.
--
-- 1. The main subscription becomes ONE "Standard" package whose price depends
--    on the billing duration chosen at checkout:
--        1 day = $20 · 7 days = $50 · 30 days = $100 · 180 days = $250
--    The price tiers live in `packages.features.price_tiers` and are applied
--    client-side on the Packages page (amount = tier[chosen duration], falling
--    back to `price` for admin-created fixed-price packages). The old
--    Starter / Pro / Elite packages are deactivated, not deleted, so existing
--    subscriptions keep their package reference.
-- 2. Copy trading is trimmed to two tiers: 1 day = $20 (sold without referral
--    commission) and 30 days = $100. The 7-day and 180-day tiers are
--    deactivated.
-- 3. A new 'ads' add-on sells ad placement as a flat 30-day subscription =
--    $100, activated exactly like copy trading (duration window on the
--    purchase, 10% referral commission).

-- 1. Deactivate the old packages and seed the duration-priced main package.
update public.packages set active = false where active = true;

insert into public.packages (name, description, price, currency, duration_days, commission_pct, robots, mt_accounts, features, active, sort)
values (
  'Standard',
  'Main subscription — the price depends on the billing duration you pick: 1 day = $20, 7 days = $50, 30 days = $100, 180 days = $250. Includes 1 robot slot + 1 MT4/5 account.',
  100, 'USDT', 30, 10, 1, 1,
  '{"auto_tune": true, "broker_connections": 1, "price_tiers": {"1": 20, "7": 50, "30": 100, "180": 250}}'::jsonb,
  true, 1
);

-- 2. Copy trading: keep the 1-day ($20) and 30-day ($100) tiers, hide 7/180-day.
update public.addons set active = false
where kind = 'copy_trading' and duration_days in (7, 180);

-- 3. Ads subscription add-on (flat 30 days = $100, standard 10% commission).
insert into public.addons (name, description, kind, amount, price, currency, active, sort, duration_days, commission_pct) values
  ('Ads subscription — 30 days', 'Run your ad across the platform for 30 days — approved ads stay live while the subscription is active.', 'ads', 1, 100, 'USDT', true, 9, 30, 10)
on conflict do nothing;
