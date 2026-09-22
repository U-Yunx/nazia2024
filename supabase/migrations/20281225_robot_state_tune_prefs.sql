-- Extend the durable robot-state row with the two config blocks a restored
-- robot needs in order to come back COMPLETE — not just with the pairs and
-- strategy it happened to be trading.
--
--   prefs — the full autopilot configuration: auto-run duration, trade mode,
--           pair count, per-pair / max-open-trades / per-cycle caps, the
--           per-trade stops, the session limits and the position sizing.
--   tune  — the manual-tune profile: the aggressiveness preset, the
--           position-size multiplier the robot sizes every trade by, the risk %
--           and the adaptive-risk / volatility-filter / loss-streak guardrails
--           that preset turns on.
--
-- Without these, a run resumed on another device fell back to that device's own
-- defaults (run "until stopped", one position per pair, no cycle cap, 1x size)
-- while the robot on screen claimed to be the same run.
--
-- Both columns are nullable and additive: rows written before this migration
-- keep working and simply restore the sections they already carry — an absent
-- or non-object blob is treated as "nothing to restore" by the client
-- normalisers (prefsFrom / tuneFrom), never as a reset to defaults.

alter table public.robot_state add column if not exists prefs jsonb;
alter table public.robot_state add column if not exists tune jsonb;
