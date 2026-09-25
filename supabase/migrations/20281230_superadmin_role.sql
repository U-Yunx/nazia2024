-- Superadmin tier — a role above 'admin'.
--
-- Design notes (why it is built this way):
--
--   * `is_admin()` now matches 'admin' OR 'superadmin'. That is deliberate: every
--     admin-gated RLS policy and feature in the database routes through
--     `public.is_admin()`, so widening it means a superadmin inherits the whole
--     admin surface for free — and a plain admin keeps every power they had.
--     Adding a role value WITHOUT this step would have silently demoted the
--     superadmin (no policy matches 'superadmin'), which is the exact bug this
--     file avoids.
--   * `is_superadmin()` is the new top tier and is the only thing that may
--     manage roles. Previously ANY admin could promote anyone (including
--     themselves) to admin — a privilege-escalation path. Role management is
--     now superadmin-only.
--   * Self-changes are refused so the platform owner can never lock the
--     workspace out of its own superadmin by accident.
--
-- Idempotent: safe to replay.

-- ------------------------- 1. widen the role constraint -------------------------

alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles
  add constraint profiles_role_check
  check (role in ('user', 'admin', 'superadmin'));

-- ------------------------- 2. is_admin() now spans both tiers --------------------

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role in ('admin', 'superadmin')
  )
$$;

revoke execute on function public.is_admin() from public, anon;

-- ----------------------------- 3. is_superadmin() --------------------------------

create or replace function public.is_superadmin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'superadmin'
  )
$$;

revoke execute on function public.is_superadmin() from public, anon;

-- ------------------- 4. role changes are superadmin-only, non-self -----------------

create or replace function public.set_user_role(p_user_id uuid, p_role text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_superadmin() then
    raise exception 'Only a superadmin can change roles';
  end if;
  if p_role not in ('user', 'admin', 'superadmin') then
    raise exception 'Invalid role: %', p_role;
  end if;
  if p_user_id = auth.uid() then
    raise exception 'You cannot change your own role';
  end if;
  update public.profiles set role = p_role::text where id = p_user_id;
  if not found then
    raise exception 'No profile found for that user';
  end if;
end $$;

revoke execute on function public.set_user_role(uuid, text) from public, anon;
grant execute on function public.set_user_role(uuid, text) to authenticated;

-- --------------------- 5. same rules on direct row updates ------------------------
-- Without this, a plain admin could still escalate through a plain UPDATE on
-- profiles.role (which the existing trigger only blocked for non-admins).

create or replace function public.guard_profile_role()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.role is distinct from new.role then
    if not public.is_superadmin() then
      raise exception 'Only a superadmin can change roles';
    end if;
    if new.role not in ('user', 'admin', 'superadmin') then
      raise exception 'Invalid role: %', new.role;
    end if;
    if old.id = auth.uid() then
      raise exception 'You cannot change your own role';
    end if;
  end if;
  return new;
end $$;

-- ---------------------- 6. promote the platform owner -----------------------------
--
-- The guard trigger above refuses every role change unless the caller is a
-- superadmin — and a migration runs with no JWT, so `auth.uid()` is null and it
-- correctly refuses this one too. We therefore lift the guard for the single
-- seeding statement and put it straight back. This runs as the table owner
-- (postgres) inside the migration transaction, so there is no window where a
-- client could slip a role change through.

alter table public.profiles disable trigger guard_profile_role;

update public.profiles
set role = 'superadmin'
where email = '6880.asx@gmail.com'
  and role is distinct from 'superadmin';

alter table public.profiles enable trigger guard_profile_role;
