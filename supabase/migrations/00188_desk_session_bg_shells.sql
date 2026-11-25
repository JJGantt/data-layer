-- Each background shell a session has running, named by the description its Bash call gave it (else its
-- command's first line). Written by each host (voice-pipeline orchestrator/src/discover.js `backgroundOf`).
alter table desk_sessions add column if not exists bg_shells text[];
