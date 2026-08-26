-- Live Claude sessions, published by whichever machine is running them.
--
-- Two jobs, and the second is why this is a table rather than a log:
--   1. Lifecycle. Sessions are started by voice and by the repo picker, and until now nothing ever
--      closed them — each launch left a tmux session holding a Claude process on a Pi with finite
--      RAM. You cannot close what you cannot enumerate, so first they have to be visible.
--   2. It is the ambient indicator. "Is something being worked on, and on what?" is answered by
--      selecting from here — no separate bookkeeping, and every surface (phone wall, TV, the widget)
--      reads the same rows.
--
-- The publishing machine owns its rows and reconciles them on every tick: a session whose process has
-- exited is deleted rather than left as a tombstone, so what is here is what is actually alive.

create table if not exists desk_sessions (
  id          text primary key,            -- the tmux session name, e.g. hub-status-hub-mt9e8e2h
  worker      text not null,               -- which machine ('pi-desk', later 'desk')
  repo        text not null,
  prompt      text,                        -- what it was asked to do, for the indicator
  started     timestamptz not null default now(),
  last_seen   timestamptz not null default now()
);

create index if not exists desk_sessions_worker_idx on desk_sessions(worker);

alter table desk_sessions enable row level security;
