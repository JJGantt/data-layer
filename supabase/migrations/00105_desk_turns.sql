-- One row per FINISHED turn of a conversation: what he said, and what the session answered.
--
-- `desk_sessions` holds only the last turn (`last_prompt`, `last_reply`), and each new turn replaces
-- it. A surface showing one session wants the few exchanges before that too, because a reply read on
-- its own is often an answer to something said two turns ago.
--
-- Keyed by the CONVERSATION (`claude_session_id`), not the row: a resume or a transfer makes a new
-- `desk_sessions` row for the same conversation, and its history has to follow it across.
--
-- Written by a trigger rather than by the machines, for three reasons. There are two writers of
-- `desk_sessions` (the Mac's orchestrator and the Pi's pi-desk) and each writes a turn end from two
-- places (the transcript watcher, and the reconcile tick behind it), so an application-level append
-- would be four call sites that all have to agree. A turn is identified by its `reply_at`, so the
-- same turn reported twice lands on one row. And the row and its turn are written in one transaction,
-- so anything told the row changed can already read the turn.
create table if not exists desk_turns (
  conversation text        not null,   -- desk_sessions.claude_session_id, or the row id until it has one
  at           timestamptz not null,   -- the turn's reply_at
  prompt       text,                   -- null when the turn was not started by something he said
  reply        text        not null,
  primary key (conversation, at)
);

create index if not exists desk_turns_at_idx on desk_turns(at);

alter table desk_turns enable row level security;

create or replace function desk_sessions_record_turn() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  conv text := coalesce(new.claude_session_id, new.id);
begin
  if new.reply_at is null or new.last_reply is null then
    return new;
  end if;

  -- A later write of the same turn may know less than an earlier one did (a reader that could not
  -- find the turn's opening publishes a blank prompt), so a prompt already recorded is kept.
  insert into desk_turns (conversation, at, prompt, reply)
  values (conv, new.reply_at, new.last_prompt, new.last_reply)
  on conflict (conversation, at) do update
    set reply  = excluded.reply,
        prompt = coalesce(excluded.prompt, desk_turns.prompt);

  -- Bounded here, where it grows, so nothing has to come along later and sweep it: the newest 20
  -- turns of a conversation, and nothing older than 30 days. No surface reads further back than ten,
  -- and a parked session is itself dropped at 14 days.
  delete from desk_turns t
   where t.conversation = conv
     and t.at < (select k.at from desk_turns k where k.conversation = conv
                  order by k.at desc offset 19 limit 1);
  delete from desk_turns where at < now() - interval '30 days';

  return new;
end $$;

-- Two triggers because only an UPDATE has an OLD row to compare with. The comparison is the point:
-- pi-desk's reconcile tick upserts every column of every row every 30s, and without it each of those
-- would run the function to rewrite a turn that has not changed.
drop trigger if exists desk_sessions_record_turn_ins on desk_sessions;
create trigger desk_sessions_record_turn_ins
  after insert on desk_sessions
  for each row when (new.reply_at is not null and new.last_reply is not null)
  execute function desk_sessions_record_turn();

drop trigger if exists desk_sessions_record_turn_upd on desk_sessions;
create trigger desk_sessions_record_turn_upd
  after update on desk_sessions
  for each row when (
       old.reply_at          is distinct from new.reply_at
    or old.last_reply        is distinct from new.last_reply
    or old.last_prompt       is distinct from new.last_prompt
    or old.claude_session_id is distinct from new.claude_session_id)
  execute function desk_sessions_record_turn();

-- What every session last said, so a conversation's history starts with its current turn rather
-- than empty.
insert into desk_turns (conversation, at, prompt, reply)
select distinct on (coalesce(claude_session_id, id), reply_at)
       coalesce(claude_session_id, id), reply_at, last_prompt, last_reply
  from desk_sessions
 where reply_at is not null and last_reply is not null
 order by coalesce(claude_session_id, id), reply_at, (last_prompt is null)
on conflict (conversation, at) do nothing;
