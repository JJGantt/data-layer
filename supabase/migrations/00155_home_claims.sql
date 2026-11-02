-- Rows the Pi's home agent acts on are claimed before it acts, so a second machine running the agent
-- by mistake (HOME_AGENT=1 somewhere else) finds each row taken instead of powering the TV off twice
-- or answering a YouTube read from a browser that is not signed in. data-layer realtime.ts claims.
alter table public.tv_commands add column if not exists claimed_by text;
alter table public.home_requests add column if not exists claimed_by text;
