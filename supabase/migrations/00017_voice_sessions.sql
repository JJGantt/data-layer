-- Phase 2 of the Voice → Claude → Pi-wall system: focusable Mac-session registry +
-- terminal routing fields on voice_focus. See status-hub/IDEAS.md.

-- The Mac orchestrator writes the 5 most recent Claude sessions here (from ~/.claude),
-- so the Fly hub /tv (which can't read the Mac filesystem) can show the focusable list.
create table if not exists voice_sessions (
  id text primary key,             -- claude session id (uuid)
  title text,                      -- the session's aiTitle (auto-generated name)
  cwd text,                        -- working directory (for reopening the desk tab)
  project text,                    -- ~/.claude project dir label
  last_active timestamptz,         -- session .jsonl mtime
  updated_at timestamptz not null default now()
);
alter table voice_sessions enable row level security;  -- service_role only

-- Routing fields for when focus is a Mac session shown in the wall web-terminal.
alter table voice_focus add column if not exists terminal_url text;  -- ws URL the /tv xterm.js connects to
alter table voice_focus add column if not exists session_cwd  text;

-- Realtime so /tv updates the focusable list + focus/terminal live.
do $$ begin
  alter publication supabase_realtime add table voice_sessions;
exception when duplicate_object then null; end $$;
