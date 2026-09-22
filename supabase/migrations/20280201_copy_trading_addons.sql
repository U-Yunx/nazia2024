-- v2.9 — Copy-trading add-on sold as a duration-based subscription.
--
-- 1. Widen the add-on kind constraint so 'copy_trading' add-ons are valid.
-- 2. Add `commission_pct` to addons: > 0 means the buyer's referrer earns a
--    commission when the add-on purchase is activated. The 1-day copy-trading
--    tier is sold WITHOUT referral commission (commission_pct = 0); the
--    7/30/180-day tiers earn the standard 10%.
-- 3. Seed four copy-trading add-ons:
--       Copy trading — 1 day   = $20   (no referral commission)
--       Copy trading — 7 days  = $50
--       Copy trading — 30 days = $100
--       Copy trading — 180 days = $250
-- 4. `trg_activate_addon_purchase` mirrors `activate_subscription()` for add-on
--    purchases: when an admin activates a purchase whose add-on has
--    commission_pct > 0 and the buyer has a referrer, a pending referral
--    commission is created, total_referrals bumps, and the referrer is
--    notified. Copy trading is considered ACTIVE while any activated
--    copy_trading purchase is within its `duration_days` window (enforced in
--    the app via activated_at + duration_days).

-- 1. Widen the add-on kind constraint.
alter table public.addons drop constraint if exists addons_kind_check;
alter table public.addons add constraint addons_kind_check
  check (kind in ('robot','mt_account','ads','slot','copy_trading'));

-- 2. Referral commission % on add-ons (0 = the purchase earns no commission).
alter table public.addons add column if not exists commission_pct numeric not null default 0
  check (commission_pct >= 0);

-- 3. Seed the copy-trading add-ons (1 slot = 1 robot + 1 account is
--    irrelevant here: copy trading is a time-based access grant).
insert into public.addons (name, description, kind, amount, price, currency, active, sort, duration_days, commission_pct) values
  ('Copy trading — 1 day',   'Copy any pro trader''s full configuration to your robot for 1 day — method, pairs, sizing, exits and risk in one click. Sold without referral commission.', 'copy_trading', 1, 20,  'USDT', true, 5, 1,   0),
  ('Copy trading — 7 days',  'Copy any pro trader''s full configuration to your robot for 7 days — method, pairs, sizing, exits and risk in one click.', 'copy_trading', 1, 50,  'USDT', true, 6, 7,   10),
  ('Copy trading — 30 days', 'Copy any pro trader''s full configuration to your robot for 30 days — method, pairs, sizing, exits and risk in one click.', 'copy_trading', 1, 100, 'USDT', true, 7, 30,  10),
  ('Copy trading — 180 days','Copy any pro trader''s full configuration to your robot for 180 days — method, pairs, sizing, exits and risk in one click.', 'copy_trading', 1, 250, 'USDT', true, 8, 180, 10)
on conflict do nothing;

-- 4. Referral commission on add-on activation (mirrors activate_subscription).
create or replace function public.activate_addon_purchase()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  addon public.addons%rowtype;
  referrer_id uuid;
begin
  if new.status = 'active' and old.status is distinct from 'active' then
    new.activated_at := coalesce(new.activated_at, now());
    select * into addon from public.addons where id = new.addon_id;
    -- Only commissionable add-ons (e.g. NOT the 1-day copy-trading tier)
    -- create a referral commission for the buyer's referrer.
    if addon.commission_pct > 0 then
      select referred_by into referrer_id from public.profiles where id = new.user_id;
      if referrer_id is not null then
        insert into public.referrals
          (referrer_id, referred_id, subscription_id, commission_pct, commission_amount, status)
        values
          (referrer_id, new.user_id, null, addon.commission_pct,
           round(new.amount * addon.commission_pct / 100, 2), 'pending');
        update public.profiles set total_referrals = total_referrals + 1 where id = referrer_id;

        insert into public.notifications (user_id, type, title, body, link)
        values (
          referrer_id,
          'success',
          'Referral commission earned',
          format('Your referral just activated %s — %s %s commission is now pending.', addon.name, round(new.amount * addon.commission_pct / 100, 2), new.currency),
          '/referrals'
        );
      end if;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_activate_addon_purchase on public.addon_purchases;
create trigger trg_activate_addon_purchase
  before update of status on public.addon_purchases
  for each row execute function public.activate_addon_purchase();
