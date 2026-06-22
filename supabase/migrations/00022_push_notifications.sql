-- Native iOS push notifications (APNs).
--   device_tokens: one row per install's APNs device token (the sender targets these).
--   notifications: a send log; the unique dedupe_key enforces "at most one per key" so the
--   daily weight reminder can only fire once per local day even across server restarts.
create table if not exists device_tokens (
    token       text primary key,                 -- APNs device token (hex)
    platform    text not null default 'ios',
    bundle_id   text,
    last_seen   timestamptz not null default now(),
    created_at  timestamptz not null default now()
);

create table if not exists notifications (
    id            bigint generated always as identity primary key,
    kind          text not null,                  -- e.g. 'weight_reminder'
    title         text,
    body          text,
    dedupe_key    text unique,                    -- e.g. 'weight_reminder:2026-06-22'
    scheduled_for timestamptz,
    sent_at       timestamptz,
    ok            boolean,
    detail        text,                           -- APNs response / error, for debugging
    created_at    timestamptz not null default now()
);
create index if not exists notifications_kind_created_idx on notifications(kind, created_at desc);

notify pgrst, 'reload schema';
