-- The one-sentence summary of a finished turn: what it did, or the question it ends on.
--
-- The host that ran the turn asks Haiku for it the moment the turn ends (voice-pipeline
-- orchestrator/src/sessionWatch.js `summarise`), and the hub uses it as the push notification body.
-- Stored here too so get_sessions can show each session's last answer as that sentence instead of a
-- reply cut off mid-thought. Null when the reply was short enough to be its own summary (under 200
-- characters), or when the summariser failed.
alter table desk_turns add column if not exists summary text;

-- Written by the hub when the summary frame arrives, in one statement that cannot lose to the trigger
-- or to desk_turn_events: the row may not exist yet, and neither path overwrites what the other knows.
-- The reply passed here is only a placeholder for an insert; the trigger replaces it with the full one.
create or replace function desk_turn_summary(conv text, turn_at timestamptz, turn_reply text, turn_summary text)
returns void language sql security definer set search_path = public as $$
  insert into desk_turns (conversation, at, reply, summary)
  values (conv, turn_at, turn_reply, turn_summary)
  on conflict (conversation, at) do update set summary = excluded.summary;
$$;

revoke all on function desk_turn_summary(text, timestamptz, text, text) from public, anon, authenticated;
