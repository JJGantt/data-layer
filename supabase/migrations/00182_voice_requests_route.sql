-- Which route the worker runs a hub command on. NULL is the standard route (the Claude subscription);
-- 'fast' is Claude Code's fast mode on the Console API key, asked for by the watch's Hub Fast
-- complication (voice-pipeline docs/ROUTING.md § The fast route).
alter table public.voice_requests add column if not exists route text
  check (route is null or route in ('fast'));
