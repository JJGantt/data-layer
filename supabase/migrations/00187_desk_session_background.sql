-- What a session still has running in the background once its turn is over: the descriptions of its
-- background agents still in flight, and whether a background shell is still running. Written by each
-- host from Claude Code's own records (voice-pipeline orchestrator/src/discover.js `backgroundOf`).
alter table desk_sessions add column if not exists bg_agents text[];
alter table desk_sessions add column if not exists bg_shell boolean not null default false;
