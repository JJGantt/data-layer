-- A session the user has dismissed from the hub's surfaces (the phone's lists, the walls, the watch).
--
-- Hidden only while nothing newer has happened in it: the hub hides a row while hidden_at is at or
-- after the row's own activity (coalesce(active_at, reply_at, started)), and a resume makes a new row
-- that carries no mark. So any new prompt or reply in the conversation brings it back on its own.
--
-- The voice tools (get_sessions, resolveSession) ignore it: the orchestrator still sees and can reach
-- every session, which is the point of hiding rather than forgetting.
alter table desk_sessions add column if not exists hidden_at timestamptz;
