-- voice_requests.tier exists on the live project but was added in the dashboard, so no migration
-- created it. Written down here so the migrations rebuild the schema; a no-op where it exists.
alter table public.voice_requests add column if not exists tier text;
