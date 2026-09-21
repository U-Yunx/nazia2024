-- Partial take-profit (scale-out) persistence.
--
-- The robot's scale-out exit banks part of a position at the first target,
-- moves the stop to break-even and lets the rest ride to the full take-profit.
-- Two position-level facts must survive reloads and server-side takeovers so a
-- browser → robot-runner handoff behaves identically:
--   - tp1_price      — the first-target price stamped at OPEN time (fixed even
--                      after the trailing/break-even ratchet moves the stop).
--   - partial_taken  — whether the position already banked its first target
--                      (the rule fires exactly once per position).
-- Both live on paper_trades (open rows only; closed rows carry nulls).

alter table public.paper_trades
  add column if not exists tp1_price double precision;

alter table public.paper_trades
  add column if not exists partial_taken boolean not null default false;
