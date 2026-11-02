-- A turn dropped as room noise stays in the conversation, marked.
--
-- The always-on mics hear everything, so the assistant must be able to decide an utterance was not
-- for it. Until now that decision ERASED the turn: no user row, no assistant row, nothing in the
-- thread. If the judgement was wrong, the words were simply gone — the user could not say "do the one
-- you ignored", and the next turn's "answer my question" referred to something that, as far as the
-- model could see, had never been said.
--
-- So the user's words are kept and flagged. Anything reading the thread can show them differently,
-- or leave them out; what matters is that they are still there to point at.
alter table voice_messages add column if not exists ignored boolean not null default false;
create index if not exists voice_messages_ignored_idx on voice_messages(created_at desc) where ignored;
