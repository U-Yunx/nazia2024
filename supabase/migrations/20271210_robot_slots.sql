-- Per-robot-slot ledgers: each robot (slot 1..N) gets its own paper / managed
-- account and trade journal instead of one shared per user. Slot 1 keeps the
-- legacy rows (default robot_number = 1), so existing users lose nothing.

alter table public.paper_accounts
  add column if not exists robot_number integer not null default 1;

alter table public.paper_accounts
  add constraint paper_accounts_robot_number_positive check (robot_number > 0);

alter table public.paper_trades
  add column if not exists robot_number integer not null default 1;

alter table public.paper_trades
  add constraint paper_trades_robot_number_positive check (robot_number > 0);

-- Replace the single-account-per-user uniqueness with per-slot accounts.
alter table public.paper_accounts drop constraint if exists paper_accounts_user_id_key;
drop index if exists public.paper_accounts_user_id_key;

create unique index if not exists paper_accounts_user_robot_idx
  on public.paper_accounts (user_id, robot_number);

create index if not exists paper_trades_user_robot_idx
  on public.paper_trades (user_id, robot_number);

-- Every trade already on the ledger belongs to slot 1 — backfill any drifted
-- rows to their owning account's slot for safety.
update public.paper_trades t
set robot_number = a.robot_number
from public.paper_accounts a
where a.user_id = t.user_id
  and t.robot_number = 1
  and a.robot_number <> 1;
