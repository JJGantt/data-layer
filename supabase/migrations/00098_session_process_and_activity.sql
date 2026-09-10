-- A session's process, and when it last did something.
--
-- pid: the Claude Code process a row belongs to. Each machine reads that process's own record
-- (~/.claude/sessions/<pid>.json) for the conversation it is in, so a row follows `/clear` exactly,
-- and a Terminal tab reused by a later `claude` is a new row rather than this one kept alive.
--
-- active_at: when the conversation last crossed a turn boundary — a prompt sent, a turn finished.
-- Sessions are ordered, numbered and focused by it. Nothing writes it on the 30s reconcile tick
-- except a turn boundary the watcher missed, so the order changes when a session actually does
-- something, never between two reads of an unchanged list.
alter table desk_sessions add column if not exists pid integer;
alter table desk_sessions add column if not exists active_at timestamptz;
update desk_sessions set active_at = coalesce(reply_at, started) where active_at is null;
