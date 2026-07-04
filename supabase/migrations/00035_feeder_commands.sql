-- Command relay for feeding the cat feeder from the web hub. The hub (on Fly) can't reach the
-- LAN-only feeder, so a "Feed Now" tap inserts a pending row here; the Pi collector (on the LAN)
-- claims it, dispenses, and marks it done. One row per feed request.
create table if not exists feeder_commands (
  id uuid primary key default gen_random_uuid(),
  action text not null default 'feed',
  portions int not null default 1,
  status text not null default 'pending',   -- pending | done | failed
  source text,                              -- e.g. 'hub-web'
  created_at timestamptz not null default now(),
  executed_at timestamptz,
  result text
);
create index if not exists feeder_commands_pending_idx on feeder_commands (created_at) where status = 'pending';
