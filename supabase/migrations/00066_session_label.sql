-- A short human name for a dispatched piece of work.
--
-- Every name a session already has is derived from its directory — the tmux id, the Remote Control
-- name and Claude Code's own name are all repo + a timestamp suffix. That identifies the checkout and
-- says nothing about the job, so three sessions on status-hub are indistinguishable in a list.
--
-- The router writes this when it dispatches, because that is the only point where the request exists
-- as language. On the queue too: a job can wait a long time for a slot, and it must not lose its name
-- while it waits.
alter table desk_sessions add column if not exists label text;
alter table desk_queue    add column if not exists label text;
