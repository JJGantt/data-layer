-- An assistant reply the user asked to know something from (an answer, a lookup) rather than a confirmation
-- that something was done. The hub worker sets needs_read from a marker the model appends; read_at is
-- stamped once a surface has actually shown it (the watch: on screen, wrist up, a couple of seconds).
-- The watch keeps an unread answer reachable until then, so a later command cannot bury it.
alter table voice_messages
  add column if not exists needs_read boolean not null default false,
  add column if not exists read_at timestamptz;
