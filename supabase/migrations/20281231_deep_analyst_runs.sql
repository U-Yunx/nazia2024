-- Deep Analyst run history.
--
-- Every analysis a signed-in user runs is recorded here by the `deep-analyst`
-- Edge Function so the trader can reopen past verdicts, exact levels and
-- reasoning. Anonymous callers are never persisted. RLS keeps each row
-- visible to — and insertable by — its owner only.

create table if not exists public.deep_analyst_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  symbol text not null,
  side text not null check (side in ('long', 'short')),
  entry_price numeric(20, 8),
  mark numeric(20, 8),
  engine text not null default 'deterministic',
  ai_used boolean not null default false,
  model text,
  request jsonb not null default '{}'::jsonb,
  strategy jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists deep_analyst_runs_user_created_idx
  on public.deep_analyst_runs (user_id, created_at desc);

alter table public.deep_analyst_runs enable row level security;

create policy "deep_analyst_runs_select_own"
  on public.deep_analyst_runs
  for select
  to authenticated
  using (user_id = auth.uid());

create policy "deep_analyst_runs_insert_own"
  on public.deep_analyst_runs
  for insert
  to authenticated
  with check (user_id = auth.uid());
