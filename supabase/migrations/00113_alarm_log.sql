-- THE ALARM LOG — what happened to every alarm, durably, so a morning can be audited afterwards.
--
-- The hub writes it (status-hub server.js `alarmLog`). Each row is an EVENT, never a heartbeat:
--   hub/decision  every surf-alarm decision, one per new forecast or rule change, and what it did
--   hub/due       an alarm item's moment arriving, with the last state heard from every ringer
--   <ringer>/…    a ring, a stop, a player failing, and each CHANGE in a ringer's armed state
--                 (next alarm, Guided Access, screen, audio) — a steady page writes nothing
-- Ringer sources are named `tv` (the Pi's tv-ring) and `<surface>@<device>` for a page's alarm clock.
-- Tens of rows a day. Not in the realtime publication: nothing watches it live.
create table if not exists alarm_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  source text not null,
  ev text not null,
  item_id text,
  detail jsonb not null default '{}'::jsonb
);
create index if not exists alarm_log_at on alarm_log (at desc);
alter table alarm_log enable row level security;
