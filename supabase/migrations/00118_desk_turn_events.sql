-- A finished turn's whole ordered list, not only its first prompt and its reply.
--
-- A turn is more than one prompt and one answer: the user can say something while it is running, and what
-- the session did between (tool calls, what it said between them) happened in an order. The hub's
-- session view is that ordered list, but it holds it in memory and reseeds from this table when it
-- restarts — and seeded from `prompt` and `reply` alone, a message sent mid-turn is gone and nothing
-- sits where it happened.
--
-- `events` is the turn as the machine that ran it read it from the transcript, in order:
-- [{ id, kind: 'prompt' | 'text' | 'tool', text, seen?, cmd? }]. The reply is not repeated in it.
-- Null for turns recorded before this, which seed as prompt then reply, as they always did.
alter table desk_turns add column if not exists events jsonb;

-- Written by the hub when the host reports the turn's end, in one statement that cannot lose to the
-- trigger above it: the row may or may not exist yet (the host writes `desk_sessions` first, but the
-- two are separate requests), and neither order may overwrite what the other knows. The trigger never
-- touches `events`; this never touches a prompt or reply already recorded.
create or replace function desk_turn_events(conv text, turn_at timestamptz, turn_reply text, turn_events jsonb)
returns void language sql security definer set search_path = public as $$
  insert into desk_turns (conversation, at, reply, events)
  values (conv, turn_at, turn_reply, turn_events)
  on conflict (conversation, at) do update set events = excluded.events;
$$;

revoke all on function desk_turn_events(text, timestamptz, text, jsonb) from public, anon, authenticated;
