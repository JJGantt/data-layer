-- Session lifecycle: a session can be RESIDENT (running, on Remote Control), EVICTED (closed to free
-- the machine, resumable with full context), or QUEUED (asked for, waiting for a slot).
--
-- The Pi holds a small number of sessions resident. Idle ones cost no CPU — measured at 00:00:00 of
-- CPU across 17 minutes — but ~334MB each, permanently, on a 4GB machine. So residency is bounded by
-- MEMORY, while how many may run a turn at once is bounded by CPU. They are different limits and this
-- table has to express both.
--
-- `claude_session_id` is what makes eviction survivable: Claude Code writes a full transcript per
-- session to ~/.claude/projects/<path>/<id>.jsonl and `claude --resume <id>` replays it. Without the
-- id recorded here, closing a session would destroy it rather than park it.

alter table desk_sessions add column if not exists claude_session_id text;
alter table desk_sessions add column if not exists status text not null default 'resident';
alter table desk_sessions add column if not exists last_reply text;
alter table desk_sessions add column if not exists ended timestamptz;
-- Where the transcript lives, so any surface can read history without knowing Claude's layout rules.
alter table desk_sessions add column if not exists transcript_path text;

create index if not exists desk_sessions_status_idx on desk_sessions(status);

-- A queued request that has not been given a slot yet. Deliberately NOT desk_commands: those expire,
-- because a command from a machine that was asleep should not fire hours later. A queued session is
-- the opposite — it is waiting on purpose and must never expire.
create table if not exists desk_queue (
  id        text primary key,
  worker    text not null,
  repo      text not null,
  prompt    text,
  created   timestamptz not null default now(),
  -- Set when a slot is taken and the session starts; the row is deleted immediately after, so this is
  -- only ever briefly non-null. Present so a crash mid-handoff is visible rather than silent.
  claimed   timestamptz
);

create index if not exists desk_queue_worker_idx on desk_queue(worker, created);

alter table desk_queue enable row level security;
