-- An HTML write-up a dispatched session publishes when it finishes its work.
--
-- This is an ADDITIONAL artifact, not a replacement channel: the session still answers normally, so
-- Remote Control and the transcript are untouched. The page is what you read on the phone afterwards.
--
-- `notified` is the push ledger. The hub's tick pushes rows that are false and flips them, so a
-- report is announced exactly once — including across a hub restart, which an in-memory set would not
-- survive.
create table if not exists reports (
  id        text primary key,
  session   text,                      -- desk_sessions.id, when the publisher knows its own
  repo      text,
  title     text not null,
  summary   text not null default '',  -- one line; this becomes the notification body
  html      text not null,
  notified  boolean not null default false,
  created   timestamptz not null default now()
);

create index if not exists reports_created_idx  on reports (created desc);
create index if not exists reports_unnotified_idx on reports (created) where notified = false;
