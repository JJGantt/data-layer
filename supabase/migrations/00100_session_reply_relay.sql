-- A session dispatched from the hub conversation posts its first finished reply into that thread
-- (voice-pipeline orchestrator/src/relay.js), so an answer comes back where the question was asked.
--
-- session_id names the session a message came from, and is UNIQUE: the reply lands once however many
-- paths notice the finished turn (the transcript watcher and the reconcile tick both try). Every
-- ordinary message leaves it NULL, and a unique constraint admits any number of NULLs.
--
-- session_label is the session's name at that moment, so a surface can say which session is talking
-- without joining desk_sessions — whose rows are swept after a week while the message stays.
alter table public.voice_messages add column if not exists session_id text;
alter table public.voice_messages add column if not exists session_label text;
alter table public.voice_messages add constraint voice_messages_session_id_key unique (session_id);
