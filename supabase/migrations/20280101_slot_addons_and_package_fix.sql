-- v2.8 — Bundled "extra slot" add-ons + fixed package allocations.
--
-- 1. Every add-on now grants a number of SLOTS, where 1 slot = 1 robot +
--    one trading account. The old kind-based catalog (robot / mt_account /
--    ads add-ons) is removed and replaced with exactly four add-ons:
--    1 extra slot, 2 extra slots, 3 extra slots, 4 extra slots.
-- 2. Every package includes exactly 1 robot + 1 trading account, no matter
--    the billing duration chosen at purchase time.

-- 1. Widen the add-on kind constraint so bundled slots are valid.
alter table public.addons drop constraint if exists addons_kind_check;
alter table public.addons add constraint addons_kind_check
  check (kind in ('robot','mt_account','ads','slot'));

-- 2. Remove every old add-on from the catalog. Rows referenced by a purchase
--    can't be deleted (FK on delete restrict) — those are hidden instead so
--    nothing breaks, and every purchasable add-on is one of the four below.
update public.addons set active = false;
delete from public.addons a
where a.kind in ('robot','mt_account','ads')
  and not exists (select 1 from public.addon_purchases p where p.addon_id = a.id);

-- 3. Seed the four slot add-ons (1 slot = 1 robot + 1 trading account).
insert into public.addons (name, description, kind, amount, price, currency, active, sort, duration_days) values
  ('1 extra slot',  'Adds 1 robot + 1 trading account to your package.',  'slot', 1,  39,  'USDT', true, 1, 30),
  ('2 extra slots', 'Adds 2 robots + 2 trading accounts to your package.', 'slot', 2,  69,  'USDT', true, 2, 30),
  ('3 extra slots', 'Adds 3 robots + 3 trading accounts to your package.', 'slot', 3,  99,  'USDT', true, 3, 30),
  ('4 extra slots', 'Adds 4 robots + 4 trading accounts to your package.', 'slot', 4, 129,  'USDT', true, 4, 30)
on conflict do nothing;

-- 4. Every package includes exactly 1 robot + 1 trading account.
update public.packages
set robots = 1, mt_accounts = 1
where robots <> 1 or mt_accounts <> 1;