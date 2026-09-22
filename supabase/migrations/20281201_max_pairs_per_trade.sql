-- Robot "max pairs per trade" cap.
-- ---------------------------------------------------------------------------
-- The trading page lets the user cap how many distinct pairs the robot may
-- open positions on per tick (0 = no cap — the tier allowance applies; 1..50
-- = at most N pairs). The value is mirrored into every robot_runs row
-- (src/lib/trading/robotRun.ts) and the background robot-runner enforces the
-- same cap while the page is closed (supabase/functions/robot-runner), so a
-- fresh environment must have the column for the upsert and the runner's
-- SELECT * to keep working.

alter table public.robot_runs
  add column if not exists max_pairs_per_trade integer not null default 0;

comment on column public.robot_runs.max_pairs_per_trade is
  'User cap on distinct pairs the robot may open per tick (0 = no cap, the tier allowance applies; 1..50 = at most N pairs, never above the tier limit).';
