-- CI RESULTS GO BACK TO THE SESSION THAT PUSHED.
--
-- `ci_pushes` is written by the git pre-push hook every machine runs (claude-config shared/git-hooks),
-- through the hub's POST /api/ci/pushes: which conversation pushed which commit. Commits carry no
-- session id (no attribution lines), so this is the only link from a commit back to its author.
--
-- `ci_runs` is written by the hub from GitHub's workflow_run webhook (POST /api/ci/github): one row per
-- run, requested then completed. A failed run on a push to the default branch is sent to the session in
-- ci_pushes as a follow-up, or to a new session in the repo when that one cannot be reached; `routed`
-- says which. A run requested and never completed is reported to the ops responder (status-hub
-- routes/ci.js). Both tables are service-role only.

create table if not exists ci_pushes (
  repo text not null,                 -- owner/name on GitHub
  sha text not null,                  -- the commit pushed, which is the run's head_sha
  branch text,
  claude_session_id text,             -- the conversation (desk_sessions.claude_session_id); null for a push by hand
  hub_session_id text,                -- the desk_sessions row at the time, for reading the record
  machine text,
  pushed_at timestamptz not null default now(),
  primary key (repo, sha)
);
alter table ci_pushes enable row level security;

create table if not exists ci_runs (
  run_id bigint primary key,
  attempt int not null default 1,
  repo text not null,
  workflow text,
  sha text,
  branch text,
  event text,
  conclusion text,
  url text,
  requested_at timestamptz not null default now(),
  completed_at timestamptz,
  routed text,                        -- what the hub did with a failure: session:<id>, new:<command id>, or why nothing
  missing_reported_at timestamptz     -- set once a run with no completion has been reported
);
alter table ci_runs enable row level security;
create index if not exists ci_runs_open on ci_runs (requested_at) where completed_at is null;
