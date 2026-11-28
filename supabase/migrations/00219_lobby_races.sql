-- The building's downstairs door (ButterflyMX) opened by racing every path to his phone (status-hub
-- docs/DOOR.md § Lobby door). A race is one request to open it: its `nonce` goes out in every path's
-- message (`open-lobby-7731 <nonce> <path>`), the phone's Shortcuts automation opens the door and then
-- reports which message reached it (`GET /api/lobby/opened/<nonce>/<path>`), and each report is a row in
-- lobby_events. `claimed_by` is the Mac's claim on sending the iMessage (data-layer lobby.ts through
-- realtime.ts onInserts); the hub sends the SMS and the email itself.
create table lobby_races (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  nonce text not null unique default translate(encode(extensions.gen_random_bytes(9), 'base64'), '+/', '-_'),
  reason text,
  claimed_by text
);
create index lobby_races_created_at on lobby_races (created_at desc);

-- kind 'send': a path's message went out (or `error` says why not, `skipped` when the path is not set
-- up). kind 'arrive': the phone reported that path's message, at most once per path per race.
create table lobby_events (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  race_id uuid not null references lobby_races (id) on delete cascade,
  kind text not null check (kind in ('send', 'arrive')),
  path text not null check (path in ('imessage', 'sms', 'email')),
  ok boolean not null default true,
  skipped boolean not null default false,
  error text
);
create unique index lobby_events_one_arrival on lobby_events (race_id, path) where kind = 'arrive';
create index lobby_events_race on lobby_events (race_id);

alter publication supabase_realtime add table lobby_races;
