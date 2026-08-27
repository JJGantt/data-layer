-- Mirroring a session so the other machine can pick it up.
--
-- A Claude session is not process state — it is an append-only transcript plus a working directory —
-- so "moving" one is copying a file and resuming it. Proven end to end before this was built: a Mac
-- transcript resumed on the Pi with every absolute path rewritten to the Pi's home, same session id,
-- full recall of the conversation.
--
-- Only the tail is ever uploaded. `mirror_offset` is how many bytes of the transcript are already in
-- the `transcripts` storage bucket, as `<claude_session_id>/<offset>.part`; the destination
-- concatenates the parts in offset order. Whole-file uploads would move megabytes on every turn —
-- one transcript here is 16MB.
alter table desk_sessions add column if not exists mirror_offset bigint not null default 0;
alter table desk_sessions add column if not exists mirror_at timestamptz;

-- A fourth status alongside resident / evicted / ended: `transferred`. The session was handed to the
-- other machine, which resumed it under a row of its own. The old row is kept, not deleted, because
-- it is where that half of the conversation happened — but it is not something to resume again.
--
-- THE INVARIANT IS ONE WRITER. Resuming a transcript that is still live elsewhere does not reattach;
-- it starts a second process replaying the same file, and the two diverge with one id between them.
-- Measured: the Pi's resume appended 16 records the Mac's copy never saw. So a transfer CLOSES the
-- session on the source machine, flushes the last of the mirror, and only then asks the destination
-- to resume it.
