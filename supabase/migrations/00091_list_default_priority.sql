-- A list can carry a default priority, which its new items inherit.
--
-- This is the deterministic answer to a problem that was being solved by guesswork. Everything on
-- `work` is a shift; nothing on it is a chore. Rather than have the model decide per item whether a
-- thing sounds like a task — which it got to do until it was taken away, precisely because a wrong
-- guess silently changes a score — the LIST says it once and every shift inherits it.
--
-- INHERITED AT CREATION, NOT AT READ. The default is copied onto the row when the item is made, and
-- the row is authoritative from then on. Deriving it live would mean changing a list's default
-- retroactively rewrites what past items scored, which is a thing no surface would announce and
-- nobody could audit. The cost is that changing a default does not reach items already on the list;
-- that is the right trade, because those already have scores attached to them.
alter table lists add column if not exists default_priority smallint not null default 0;

alter table lists drop constraint if exists lists_default_priority_ck;
alter table lists add constraint lists_default_priority_ck check (default_priority between -1 and 1);

comment on column lists.default_priority is
  'Priority new items on this list inherit when none is given: 1 important, 0 normal, -1 exempt';
