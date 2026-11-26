-- SESSION TABS: the extra views a session has open beside its conversation in the phone's session view
-- (status-hub docs/SESSION-TABS.md).
--
--   kind 'content' — something the session put up to show him: a picture, a chart, a markdown page or an
--                    HTML page. Opened, changed and closed by the data MCP's `session_tab` tool.
--   kind 'chrome'  — a live view of a Chrome tab the session is driving, on the Mac or the Pi. Claimed by
--                    the chrome-tabs hook when the session's Chrome tools first report the tab, closed
--                    when the tab closes or the session ends. The frames never touch this table: they go
--                    browser extension → hub → phone over websockets, and only while someone watches.
--
-- A tab belongs to a CONVERSATION (`claude_session_id`, or the row id for a session without one), not to a
-- desk_sessions row: every resume makes a new row, and a chart the session opened should still be there.
create table if not exists public.session_tabs (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  closed_at     timestamptz,
  conversation  text not null,
  kind          text not null check (kind in ('content', 'chrome')),
  title         text,
  -- content
  format        text check (format in ('markdown', 'html', 'image')),
  body          text,                -- the markdown or HTML
  image         text,                -- a name in the shared-images bucket
  -- chrome
  machine       text check (machine in ('mac', 'pi')),
  target        text,                -- the browser's own tab id (the Claude extension's, which ours shares)
  url           text
);
create index if not exists session_tabs_open on public.session_tabs (conversation) where closed_at is null;
-- One open live tab per browser tab: the hook claims on every Chrome call, and a repeat claim is a no-op.
create unique index if not exists session_tabs_chrome_open on public.session_tabs (machine, target)
  where kind = 'chrome' and closed_at is null;

alter table public.session_tabs enable row level security;

do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'session_tabs') then
    execute 'alter publication supabase_realtime add table public.session_tabs';
  end if;
end $$;
