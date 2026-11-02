-- Three things the dispatch path could not express: whether a Mac session is still up, what a
-- session's FINAL answer was, and what happened to a command that never ran.

-- ---- desk_sessions: the same facts from both machines ----------------------
--
-- `transcript_path` was carrying the Terminal tty on Mac rows and the transcript path on Pi rows —
-- one column meaning two things, which is why nothing could read a Mac session's conversation. The
-- tty gets its own column, and `transcript_path` now means the same on both.
alter table desk_sessions add column if not exists tty text;

-- The final message of a turn, and whether one is in flight.
--
-- `last_reply` alone cannot say whether it is the answer or the last thing said before the current
-- turn started. A transcript marks the end of a turn explicitly (an assistant record with
-- stop_reason 'end_turn'), so both machines can publish the distinction rather than guess at it:
-- last_reply is FINAL when working is false.
alter table desk_sessions add column if not exists working  boolean not null default false;
alter table desk_sessions add column if not exists reply_at timestamptz;

-- ---- desk_commands: who took it -------------------------------------------
-- A command claimed by a machine that then died stays 'running' for ever, and is indistinguishable
-- from one still legitimately in progress. Recording the claimer lets each machine sweep its OWN
-- abandoned claims into the dead-letter list, and never anyone else's.
alter table desk_commands add column if not exists claimed_by text;

-- ---- desk_dead_letters: nothing spoken is ever dropped ---------------------
--
-- A dispatched prompt is often several minutes of dictated stream-of-consciousness that cannot be
-- repeated. So when a command cannot run — the target machine is asleep, it expired, the launch
-- errored, the machine died mid-claim — the payload is preserved here and the caller is told, out
-- loud, that it did not run.
--
-- Deliberately NOT a retry queue. Work that could not run when it was asked for has usually stopped
-- being wanted by the time the machine comes back, and a prompt that fires hours late is worse than
-- one that never fired. Retry is a decision the user makes afterwards, from this list.
create table if not exists desk_dead_letters (
  id               text primary key,
  command_id       text,                        -- the desk_commands row, when it got that far
  kind             text not null,               -- open_session | follow_up | resume_session | end_session
  payload          jsonb not null,              -- the WHOLE original payload, prompt included
  machine          text,                        -- where it was meant to run
  reason           text not null,               -- why it did not run, in words
  source           text,                        -- who noticed: dispatch | hub | pi-desk | desk
  created          timestamptz not null default now(),
  retried          timestamptz,                 -- re-dispatched from here
  retry_command_id text,
  dismissed        timestamptz                  -- no longer wanted
);

create index if not exists desk_dead_letters_open_idx
  on desk_dead_letters(created desc) where retried is null and dismissed is null;

alter table desk_dead_letters enable row level security;
