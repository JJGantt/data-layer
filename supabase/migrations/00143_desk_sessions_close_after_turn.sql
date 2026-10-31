-- A session that asks to close ITSELF (end_session naming its own row) is not closed on the spot: the
-- request arrives mid-turn, and closing then kills the process before it writes the reply, so the
-- watch and phone are left with no answer. The data MCP stamps this instead, and the session's host
-- (voice-pipeline orchestrator/src/deskSessions.js on the Mac, pi-desk on the Pi and Fly) closes it
-- once a turn that ended after this moment has been published.
alter table public.desk_sessions
  add column if not exists close_after_turn timestamptz;
