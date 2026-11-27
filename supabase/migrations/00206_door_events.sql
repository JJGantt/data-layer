-- FRONT DOOR EVENTS — every change of the SwitchBot Lock Ultra on the front door (README § The front door).
--
-- SwitchBot's API has no history, so this is it. The status hub writes a row for each webhook event
-- (status-hub server/routes/switchbot.js): `event` is what changed (locked, unlocked, jammed, opened,
-- closed), `lock_state` / `door_state` the state after it. Its slow backstop writes `source` 'backstop'
-- when the lock's real state differs from the latest row, i.e. the webhook missed a change; that is
-- reported as an error when it happens. The current state is device_status row 'front-door'.
create table if not exists door_events (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  event text not null,
  lock_state text,
  door_state text,
  source text not null check (source in ('webhook', 'backstop')),
  raw jsonb
);
create index if not exists door_events_at on door_events (at desc);
alter table door_events enable row level security;
alter publication supabase_realtime add table door_events;
