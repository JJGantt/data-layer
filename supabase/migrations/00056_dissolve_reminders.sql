-- Dissolve `reminders` into `list_items`. "Reminder" stops being a table and becomes a predicate:
-- an item with a due date. Nothing else distinguishes one.
--
-- The two tables were already the same row shape — id, text, deleted, created, updated — differing
-- only in that reminders had `due` and list_items had `list_name`. Every behavioural difference
-- followed from `due` alone: the 60s scheduler fires rows where `due` is past, the badge counts the
-- same, and an undated reminder already behaved exactly like a to-do (it never fired, never badged).
-- Meanwhile `todo` was never special — it is one row in `lists` beside `grocery` and `Amazon`. So
-- the general model already existed and reminders were the one thing standing outside it.
--
-- Folding them in generalises due dates to EVERY list, which is the point: an Amazon item that has
-- to be ordered by Friday is a dated Amazon item, not a reminder that happens to mention Amazon. It
-- fires and badges identically to anything else. There are no classes of item.
--
-- EXPAND half of an expand/contract pair. This migration is purely additive so the deployed hub —
-- which still reads `reminders` — keeps working until it is redeployed; 00057 drops the table.

alter table list_items add column if not exists title text;
alter table list_items add column if not exists due   text;

-- The scheduler's hot query is "everything dated", run every 60 seconds forever.
create index if not exists list_items_due_idx on list_items(due) where due is not null;

-- Reminders land on `todo`: `list_name` is NOT NULL, and inventing a `reminders` list to hold them
-- would rebuild the very separation this removes.
--
-- IDS ARE PRESERVED, and that is not incidental. The push ledger dedupes on
-- `notifications.dedupe_key = 'reminder:' || id`, so a reminder that has already fired is recorded
-- under its current id. Reissuing ids would leave those ledger rows orphaned and every
-- already-delivered reminder would fire a second time the moment the new scheduler caught up.
insert into list_items (id, list_name, text, title, due, deleted, created, updated)
select id, 'todo', text, null, due, deleted, created, updated
from reminders
on conflict (id) do nothing;
