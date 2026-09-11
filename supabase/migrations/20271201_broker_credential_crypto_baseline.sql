-- ---------------------------------------------------------------------------
-- v2.10 — Broker credential crypto + standalone config tables (repo baseline)
--
-- Why this exists: the repo's migration folder drifted from the applied
-- production history. The live DB has had `encrypt_broker_cred` /
-- `decrypt_broker_cred` (SECURITY DEFINER) and the `app_secrets` + `settings`
-- tables since the "broker_credential_at_rest_encryption" era, but no
-- migration file in THIS repo creates them. A fresh `supabase db push` would
-- therefore fail at `20270412_auto_token_store.sql` (ALTER TABLE app_secrets
-- on a missing table) and at `20271101_metaapi_per_user_tokens.sql` (the
-- guard trigger calls `public.encrypt_broker_cred`, which would not exist).
--
-- This migration is IDEMPOTENT and safe on every environment:
--   * fresh DBs  → creates the missing tables + crypto functions + key;
--   * live DB    → every statement is a no-op, so it is safe to apply.
--
-- It mirrors the exact implementation already proven in production
-- (`enc:`-prefixed, hex-encoded pgp_sym ciphertext; key read from
-- `app_secrets.broker_cred_key` inside the SECURITY DEFINER functions so the
-- passphrase is never exposed to anon/authenticated callers).
-- ---------------------------------------------------------------------------

-- 1) app_secrets — service-role-only token store (deny-all RLS).
create table if not exists public.app_secrets (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);
alter table public.app_secrets enable row level security;
revoke all on public.app_secrets from anon, authenticated;
revoke all on public.app_secrets from public;
grant select, insert, update, delete on public.app_secrets to service_role;
create index if not exists app_secrets_key_idx on public.app_secrets (key);

-- 2) settings — public-readable config rows (admin-write RLS).
create table if not exists public.settings (
  key        text primary key,
  value      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.settings enable row level security;
revoke all on public.settings from anon;
grant select on public.settings to anon, authenticated;
grant insert, update, delete on public.settings to service_role;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'settings' and policyname = 'settings read'
  ) then
    create policy "settings read" on public.settings for select using (true);
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'settings' and policyname = 'settings admin write'
  ) then
    create policy "settings admin write" on public.settings
      for all using (public.is_admin()) with check (public.is_admin());
  end if;
end $$;

-- 3) pgcrypto (Neon/Supabase convention: installed in the `extensions` schema).
create extension if not exists pgcrypto with schema extensions;

-- 4) Broker credential crypto — SECURITY DEFINER, service-role only execution.
create or replace function public.encrypt_broker_cred(p_plain text)
returns text
language plpgsql
security definer
set search_path = public
as $function$
declare
  k text;
begin
  if p_plain is null or p_plain = '' then
    return p_plain;
  end if;
  if left(p_plain, 4) = 'enc:' then
    return p_plain; -- already encrypted
  end if;
  select value into k from public.app_secrets where key = 'broker_cred_key';
  if k is null then
    raise exception 'Missing broker credential key.';
  end if;
  return 'enc:' || encode(extensions.pgp_sym_encrypt(p_plain, k), 'hex');
end $function$;

create or replace function public.decrypt_broker_cred(p_enc text)
returns text
language plpgsql
security definer
set search_path = public
as $function$
declare
  k text;
begin
  if p_enc is null or p_enc = '' then
    return p_enc;
  end if;
  if left(p_enc, 4) <> 'enc:' then
    return p_enc; -- not encrypted yet
  end if;
  select value into k from public.app_secrets where key = 'broker_cred_key';
  if k is null then
    raise exception 'Missing broker credential key.';
  end if;
  return extensions.pgp_sym_decrypt(decode(substring(p_enc from 5), 'hex'), k)::text;
end $function$;

-- Crypto functions are reachable ONLY by the service role (edge functions) and
-- the guard trigger (runs as table owner); anon/authenticated never execute
-- them, so no client session can encrypt/decrypt credentials at will.
revoke execute on function public.encrypt_broker_cred(text) from public, anon, authenticated;
revoke execute on function public.decrypt_broker_cred(text) from public, anon, authenticated;
grant execute on function public.encrypt_broker_cred(text) to service_role;
grant execute on function public.decrypt_broker_cred(text) to service_role;

-- 5) Master credential key — generated once, preserved forever afterwards.
insert into public.app_secrets (key, value)
values ('broker_cred_key', encode(gen_random_bytes(32), 'hex'))
on conflict (key) do nothing;

-- 6) Platform default settings for the robot/broker bridge (never overwrite
--    admin-tuned values that already exist).
insert into public.settings (key, value, updated_at)
values
  ('risk_defaults', '{"maxOpenPositions":5,"maxDailyLossPct":5}'::jsonb, now()),
  ('broker_bridge', '{"liveExecutionEnabled":true}'::jsonb, now())
on conflict (key) do nothing;