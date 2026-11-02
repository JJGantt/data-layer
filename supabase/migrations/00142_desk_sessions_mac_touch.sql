-- What a Mac session's idle reaper needs to tell a session used AT the Mac from one the Mac
-- only hosted (voice-pipeline orchestrator/src/idle.js).
--
-- remote_inputs: a fingerprint (first line, first 60 chars) of every prompt the orchestrator itself
--   put into the session: the launch prompt and every follow-up it typed. A human prompt in the
--   transcript that matches none of them was typed at the Mac's keyboard.
-- touched_at: when the first such prompt was seen. Set once and never cleared; a session with it
--   set is never parked automatically.
alter table public.desk_sessions
  add column if not exists remote_inputs text[] not null default '{}',
  add column if not exists touched_at timestamptz;
