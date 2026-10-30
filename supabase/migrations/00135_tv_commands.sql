-- TV COMMANDS — voice and sessions controlling the bedroom TV (google-tv repo, docs/VOICE.md).
--
-- The data MCP's `tv` tool inserts a row; the hub, subscribed to inserts, pushes it to the TV's
-- companion app over /api/tv/stream; the app carries it out on the TV and posts the result to
-- /api/tv/result, which fills `result` and `done_at`; the tool is subscribed to that update and
-- returns it. Realtime end to end, so nothing polls. Rows are kept for the record; each is tiny.
create table if not exists tv_commands (
  id uuid primary key default gen_random_uuid(),
  op text not null,
  args jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  done_at timestamptz,
  result jsonb
);
create index if not exists tv_commands_created on tv_commands (created_at desc);
alter table tv_commands enable row level security;
alter publication supabase_realtime add table public.tv_commands;
