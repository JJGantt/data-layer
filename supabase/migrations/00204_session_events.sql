-- EVERY EVENT OF A SESSION'S CONVERSATION, SAVED AS IT ARRIVES (status-hub routes/conversation.js,
-- docs/HUB-INTERNALS.md § the session view). The hub's list of a conversation's events (prompts, thoughts,
-- tool calls, replies) is written here one row per event the moment the hub takes it, so a deploy loses
-- nothing and has nothing to rebuild: a restarted hub reads the list back exactly, positions and the
-- host's turn counter included. One id is one message: the same id written again updates its row.
create table if not exists public.session_events (
  conversation text not null,             -- claude_session_id, else the desk_sessions row id
  id           text not null,             -- the message's identity (a prompt's host id, `reply:<ms>`, a uuid)
  seq          integer not null,          -- its position in the conversation's list
  kind         text not null check (kind in ('prompt', 'text', 'tool', 'reply')),
  text         text not null,
  at           timestamptz,               -- a reply's turn time; a seeded event's turn
  seen         boolean,                   -- a prompt: whether the model has read it
  cmd          text,                      -- a prompt: the command that sent it
  turn         text,                      -- the host's key for the turn this event belongs to
  n            integer,                   -- its position in that turn, as the host numbered it
  created_at   timestamptz not null default now(),
  primary key (conversation, id)
);
create index if not exists session_events_seq on public.session_events (conversation, seq desc);
alter table public.session_events enable row level security;
