-- Durable robot state: guardrail columns.
--
-- `sizing` was always written by the Trading page's durable mirror but never
-- actually added to the table — so every robot_state upsert failed on the
-- unknown column and NOTHING persisted (running flag, feed, config). `stops`
-- (per-trade TP/SL pip overrides) and `limits` (session max profit/loss USD
-- plus the profit pull-back %) are the newly persisted guardrails, so a run
-- that resumes on another device enforces the same stops and limits.
--
-- All three are nullable jsonb matching the existing `strategy` pattern:
-- null = nothing saved yet, and the page skips restoring them.

alter table public.robot_state add column if not exists sizing jsonb;
alter table public.robot_state add column if not exists stops jsonb;
alter table public.robot_state add column if not exists limits jsonb;