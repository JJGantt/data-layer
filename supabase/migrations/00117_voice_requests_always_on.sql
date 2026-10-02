-- Whether the capture was an always-on mic overhearing the room, stamped by whoever captured it.
-- The worker reads this and nothing else to decide whether a turn may be dropped as not-for-it and
-- whether it may send a text or email — a press, a typed line and a listener can come from the same
-- device, so the source label cannot answer it. Unstamped is a deliberate command, never ignorable.
alter table public.voice_requests add column if not exists always_on boolean not null default false;
