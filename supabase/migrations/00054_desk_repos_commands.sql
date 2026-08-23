-- Desk control: the hub UI lists the Mac's repos and launches a Claude session in one.
--
-- The hub server runs on Fly, so it can neither see the Mac's filesystem nor reach it over the
-- LAN. Supabase is the only thing both sides already speak, so it carries both directions:
--
--   repos          the Mac's orchestrator daemon scans ~/repos and publishes what's there
--   desk_commands  the hub enqueues "open a session in <path>"; the orchestrator claims + runs it
--
-- Presence rides the existing worker_presence table under worker='desk', so the hub can grey the
-- launch buttons out when the Mac is asleep instead of silently queueing a command for later.

create table if not exists public.repos (
    path        text primary key,              -- absolute path on the Mac; the command's only valid target
    name        text not null,                 -- basename, what the UI lists
    branch      text,                          -- current branch (null when detached/unreadable)
    dirty       boolean not null default false,
    last_commit timestamptz,                   -- committer date of HEAD; drives the UI's sort
    updated     timestamptz not null default now()
);

create table if not exists public.desk_commands (
    id      uuid primary key default gen_random_uuid(),
    kind    text not null,                                  -- 'open_session'
    payload jsonb not null default '{}'::jsonb,             -- { path, name }
    -- pending -> running -> done | error, or expired when the Mac was asleep and picked it up too
    -- late (a queued launch is only wanted for a minute or so; stale ones must not open a terminal).
    status  text not null default 'pending',
    detail  text,                                           -- AppleScript result, or the failure
    created timestamptz not null default now(),
    updated timestamptz not null default now()
);
create index if not exists desk_commands_pending_idx on public.desk_commands (created) where status = 'pending';

-- RLS on, no policies: every accessor here (hub server, orchestrator) uses service_role, which
-- bypasses it. Matches 00042 — anon/authenticated are denied by default.
alter table public.repos         enable row level security;
alter table public.desk_commands enable row level security;

-- Realtime so the orchestrator launches the instant the row lands, instead of polling every 2s.
alter publication supabase_realtime add table public.desk_commands;
