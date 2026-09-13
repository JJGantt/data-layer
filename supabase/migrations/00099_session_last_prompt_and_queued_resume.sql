-- The prompt that produced a session's last reply, published beside it by both machines from the
-- transcript (orchestrator/src/transcripts.js readTail). A surface showing one session shows the
-- two together, so the reply is read against what it answers.
alter table desk_sessions add column if not exists last_prompt text;

-- A parked session resumed on a full Pi waits for a slot like new work does, so the queue has to
-- carry which conversation to resume. Null for a fresh session.
alter table desk_queue add column if not exists resume_id text;
