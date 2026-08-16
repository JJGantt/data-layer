-- Durable event log for the Litter-Robot watcher (Fly app `litter-robot-watcher`).
-- The watcher's on-disk JSONL logs are ephemeral (wiped on every Fly redeploy), and the robot's own
-- Whisker activity history is capped at ~100 events, so meaningful events — state changes, cycles we
-- fire, stall resets, drawer/sleep/offline transitions, errors — are also mirrored here best-effort by
-- the watcher (service_role) for a durable, queryable audit trail. Noisy UI/reconnect events are skipped.
create table if not exists public.litter_events (
    id           bigint generated always as identity primary key,
    ts           timestamptz not null,
    device       text,
    event        text not null,
    status       text,
    cycle_state  text,
    cycle_status text,
    weight       real,
    cat_weight   real,
    cat_detect   text,
    drawer_pct   integer,
    litter_pct   real,
    is_sleeping  boolean,
    online       boolean,
    data         jsonb,
    created_at   timestamptz not null default now()
);
create index if not exists litter_events_ts_idx on public.litter_events (ts desc);
create index if not exists litter_events_event_idx on public.litter_events (event);
-- RLS on for parity with device_status; the watcher and readers use the service_role key (bypasses RLS).
alter table public.litter_events enable row level security;
