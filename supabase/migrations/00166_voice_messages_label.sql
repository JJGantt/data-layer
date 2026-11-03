-- The answers inbox (status-hub docs/WATCH.md § The answers inbox): every reply flagged worth reading,
-- newest first, kept for good, each row named by a short label for the question it answers.
--
-- label is that name. The orchestrator writes it with the read marker it already appends
-- (voice-pipeline worker prompts.py, `[[read: …]]`); a relayed session reply takes the session's job
-- label, which the orchestrator wrote when it dispatched the work. NULL on a row written before this,
-- or by a model that left the label off — a surface falls back to the question's own words.
alter table public.voice_messages add column if not exists label text;

-- A relayed session reply joins the inbox only when the orchestrator said so as it dispatched the work
-- (start_session's `needs_read`, carried on the desk_commands payload to voice-pipeline relay.js): most
-- dispatched jobs need no answer read. Replies relayed before that existed carry no such word and stay out.

-- A command spoken from an answer opened in the inbox names that answer, and the worker hands the
-- model the question and the answer with it (voice-pipeline worker process.py `about_directive`).
alter table public.voice_requests add column if not exists about_id uuid;
