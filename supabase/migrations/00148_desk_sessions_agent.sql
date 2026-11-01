-- Which agent a session runs: Claude Code, or OpenAI's Codex CLI when Claude cannot take the work (an
-- outage, the usage limit). The hosts launch and read the two differently (voice-pipeline
-- orchestrator/src/codex.js, pi-desk/launch-codex.sh), and the hub draws a Codex session blue so it is
-- plain at a glance that Claude is not the one working. A queued session keeps its agent until it runs.
-- For a Codex row, claude_session_id holds the Codex thread id, the conversation's identity there.
alter table public.desk_sessions
  add column if not exists agent text not null default 'claude' check (agent in ('claude', 'codex'));
alter table public.desk_queue
  add column if not exists agent text not null default 'claude' check (agent in ('claude', 'codex'));
