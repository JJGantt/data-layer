-- THE CLIENT LOG — what the watch and the phone reported about themselves, durably.
--
-- The hub writes it from /api/clientlog (status-hub server.js), for the watch and the phone only; the
-- TV's once-a-minute alarm heartbeats stay in the console. Before this the lines lived only in the
-- hub's console, whose buffer holds about an hour, so a command lost on the wrist could not be traced
-- the next morning. Swept after 14 days by the hub.
create table if not exists client_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  src text not null,
  ev text not null,
  data jsonb not null default '{}'::jsonb
);
create index if not exists client_log_at on client_log (at desc);
create index if not exists client_log_ev on client_log (ev, at desc);
alter table client_log enable row level security;
