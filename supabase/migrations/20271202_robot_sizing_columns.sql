-- Robot position sizing: risk-% per trade (default) or fixed fractional lots.
-- ---------------------------------------------------------------------------
-- The trading page now mirrors `sizing_mode`, `risk_per_trade_pct` and
-- `contract_size` into every robot_runs row (src/lib/trading/robotRun.ts); the
-- background robot-runner sizes trades with the same rules while the page is
-- closed. This adds those columns and widens `lot` from whole lots (int) to
-- 0.01-step fractionals so fixed mode can express micro lots (e.g. 0.05 ×
-- 100,000 = 5,000 units on a Standard account).

alter table public.robot_runs
  add column if not exists sizing_mode text not null default 'fixed'
    check (sizing_mode in ('risk', 'fixed'));

alter table public.robot_runs
  add column if not exists risk_per_trade_pct double precision not null default 1;

alter table public.robot_runs
  add column if not exists contract_size integer not null default 100000;

-- Widening int → double precision keeps every legacy integer lot intact (old
-- pre-sizing runs read back as 'fixed' sizing with that exact lot).
alter table public.robot_runs
  alter column lot type double precision using lot::double precision;

comment on column public.robot_runs.lot is
  'Fractional lot (0.01 step, e.g. 0.05; 1 lot = contract_size units) the robot opens every trade at in fixed sizing; 0 = not picked yet.';
comment on column public.robot_runs.sizing_mode is
  'Per-trade position sizing: risk (% of equity, default) or fixed (the picked lot).';