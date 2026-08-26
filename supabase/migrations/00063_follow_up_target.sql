-- Follow-ups: "send a follow-up that…" goes to the session THIS ASSISTANT most recently dispatched.
--
-- Deliberately NOT "the most recently active session". Jared may be working at the keyboard in another
-- session at the same time, and a follow-up dictated by voice must never land there. The pointer moves
-- only when the MCP starts or resumes a session — nothing a human does at a terminal can steal it.
--
-- The pointer stores a COMMAND id rather than a session id because at dispatch time the session does
-- not exist yet: start_session enqueues a command, and the machine creates the tmux session a moment
-- later. desk_sessions.command_id closes that loop once the session appears.

alter table desk_sessions add column if not exists command_id text;
create index if not exists desk_sessions_command_idx on desk_sessions(command_id);

-- Single-row pointer. `app_settings` would have worked, but this keeps desk state together and gives
-- the column a name that says what it is.
create table if not exists desk_focus (
  id          text primary key default 'current',
  command_id  text,          -- the dispatch this points at
  session_id  text,          -- resolved once the session exists; null until then
  machine     text,
  updated     timestamptz not null default now()
);

insert into desk_focus (id) values ('current') on conflict (id) do nothing;

alter table desk_focus enable row level security;
