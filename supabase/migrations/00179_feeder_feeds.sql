-- Every feed the cat feeder reports, scheduled and manual. The feeder itself keeps only its latest
-- feed of each kind (dp 237 scheduled, dp 247 manual) and overwrites it at the next one, so this is
-- the only history. Written by petlibro-collector (service_role); (kind, fed_at) dedupes the push
-- listener and the backstop read reporting the same feed.
create table if not exists public.feeder_feeds (
    id          bigint generated always as identity primary key,
    kind        text not null check (kind in ('scheduled', 'manual')),
    portions    integer not null,
    fed_at      timestamptz not null,
    recorded_by text,
    created_at  timestamptz not null default now(),
    unique (kind, fed_at)
);
create index if not exists feeder_feeds_fed_at_idx on public.feeder_feeds (fed_at desc);
alter table public.feeder_feeds enable row level security;
