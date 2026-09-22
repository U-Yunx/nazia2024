-- Durable robot state.
--
-- The robot's running flag, auto-run window, session-guard baseline, last-run
-- stamp and activity feed used to live in localStorage only, so a refresh on
-- another device (or after clearing the browser) came back with the robot off,
-- an empty history and no idea when it had last traded. This table is the
-- durable copy the Trading page hydrates from on load and mirrors to whenever
-- any of it changes, so a reload — on this device or another — restores exactly
-- what the robot was doing.
--
-- One row per (user, robot slot): slot 1 is the default robot, slots 2..3 are
-- the extra robots, and slot 0 is the manual trading workspace. Ownership is
-- enforced with the same owner-scoped RLS as paper_accounts / robot_runs.
--
-- Timestamps that the browser owns (the auto-run window end, the run start and
-- the last successful cycle) are stored as epoch milliseconds in bigint — the
-- exact values the client already persists, so nothing needs converting on
-- either side.

create table if not exists public.robot_state (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  robot_number int not null default 1,
  running boolean not null default false,
  run_end_at bigint,
  run_start_at bigint,
  session_start_equity double precision,
  last_run_at bigint,
  activity jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (user_id, robot_number)
);

create index if not exists robot_state_user_idx on public.robot_state (user_id, robot_number);

alter table public.robot_state enable row level security;

drop policy if exists "owner select robot_state" on public.robot_state;
drop policy if exists "owner insert robot_state" on public.robot_state;
drop policy if exists "owner update robot_state" on public.robot_state;
drop policy if exists "owner delete robot_state" on public.robot_state;

create policy "owner select robot_state" on public.robot_state
  for select using (auth.uid() = user_id);
create policy "owner insert robot_state" on public.robot_state
  for insert with check (auth.uid() = user_id);
create policy "owner update robot_state" on public.robot_state
  for update using (auth.uid() = user_id);
create policy "owner delete robot_state" on public.robot_state
  for delete using (auth.uid() = user_id);
