-- The Gmail watcher's failure episode, so its stuck alert survives a restart.
--
-- failing_since is the first failed notification since the last success; stuck_alerted_at is set
-- when the watcher pushes after STUCK_AFTER of that. Both are cleared on the next success. They live
-- here rather than in the process because pull-repos restarts the unit on every push, and a clock
-- kept in memory would restart with it. Naive Eastern wall clock with no default, like the rest of
-- this table (00097).
alter table gmail_watch_state
  add column if not exists failing_since    timestamp,
  add column if not exists stuck_alerted_at timestamp;
