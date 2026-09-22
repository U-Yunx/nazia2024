-- v2.4.2 — Public live-progress + masked profit leaderboard.
--
-- Two SECURITY DEFINER functions expose ONLY aggregated, name-masked rows to
-- anon/authenticated (same pattern as public_user_stats). Raw accounts, trades
-- and profiles stay behind owner-scoped RLS; these functions never return
-- emails, real names or user ids — only a masked handle + numbers.

-- Mask a handle: keep the first and last character, hide the middle.
-- "Anna" -> "A***a", "Joe" -> "J***e", "Q" -> "Q*".
create or replace function public._mask_handle(t text)
returns text
language sql immutable
set search_path = ''
as $$
  select case
    when t is null or btrim(t) = '' then null
    when char_length(btrim(t)) <= 2 then left(btrim(t), 1) || '*'
    else left(btrim(t), 1) || '***' || right(btrim(t), 1)
  end;
$$;

-- Leaderboard: each user's single highest profit event ever — best closed
-- trade, best completed robot session, or best unrealized peak — plus how many
-- winning events they have and when their last one happened.
create or replace function public.get_leaderboard(limit_n int default 10)
returns table (handle text, best_profit numeric, events bigint, last_seen timestamptz)
language sql stable security definer
set search_path = ''
as $$
  with wins as (
    select user_id, pnl as pnl, updated_at as ts
    from public.paper_trades
    where status = 'closed' and pnl > 0
    union all
    select user_id, pnl as pnl, coalesce(ended_at, created_at) as ts
    from public.robot_sessions
    where pnl > 0
    union all
    select user_id, peak_profit_usd as pnl, updated_at as ts
    from public.paper_trades
    where peak_profit_usd > 0
  )
  select
    coalesce(
      public._mask_handle(nullif(btrim(p.display_name), '')),
      public._mask_handle(split_part(coalesce(p.email, ''), '@', 1)),
      'Trader'
    ) as handle,
    max(w.pnl) as best_profit,
    count(*)::bigint as events,
    max(w.ts) as last_seen
  from wins w
  join public.profiles p on p.id = w.user_id
  group by p.id
  order by best_profit desc
  limit case
    when limit_n is null or limit_n < 1 then 10
    when limit_n > 100 then 100
    else limit_n
  end;
$$;

-- Live traders: each registered user's current net P&L, open positions, active
-- robots and last activity (masked handle), newest activity first.
create or replace function public.get_live_traders(limit_n int default 8)
returns table (handle text, pnl numeric, open_trades bigint, active_robots bigint, last_seen timestamptz)
language sql stable security definer
set search_path = ''
as $$
  with acct as (
    select user_id,
           sum(balance) - sum(initial_balance) as pnl,
           max(coalesce(updated_at, created_at)) as last_seen
    from public.paper_accounts
    group by user_id
  ),
  open_t as (
    select user_id, count(*)::bigint as n
    from public.paper_trades
    where status = 'open'
    group by user_id
  ),
  runs as (
    select user_id, count(*)::bigint as n
    from public.robot_runs
    where status = 'running'
      and client_heartbeat_at > now() - interval '15 minutes'
    group by user_id
  )
  select
    coalesce(
      public._mask_handle(nullif(btrim(p.display_name), '')),
      public._mask_handle(split_part(coalesce(p.email, ''), '@', 1)),
      'Trader'
    ) as handle,
    coalesce(a.pnl, 0) as pnl,
    coalesce(t.n, 0) as open_trades,
    coalesce(r.n, 0) as active_robots,
    greatest(
      coalesce(a.last_seen, '-infinity'::timestamptz),
      (select max(updated_at) from public.paper_trades pt where pt.user_id = p.id),
      (select max(coalesce(rs.ended_at, rs.created_at)) from public.robot_sessions rs where rs.user_id = p.id)
    ) as last_seen
  from public.profiles p
  left join acct a on a.user_id = p.id
  left join open_t t on t.user_id = p.id
  left join runs r on r.user_id = p.id
  where a.user_id is not null or t.user_id is not null or r.user_id is not null
  order by last_seen desc
  limit case
    when limit_n is null or limit_n < 1 then 8
    when limit_n > 50 then 50
    else limit_n
  end;
$$;

revoke all on function public._mask_handle(text) from public;
revoke all on function public.get_leaderboard(int) from public;
revoke all on function public.get_live_traders(int) from public;
grant execute on function public.get_leaderboard(int) to anon, authenticated;
grant execute on function public.get_live_traders(int) to anon, authenticated;