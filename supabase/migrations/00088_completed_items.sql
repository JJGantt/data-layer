-- Bring back completion — as a state on the item, not as a ledger beside it.
--
-- 00085 recorded completions in `task_events` and let the item leave the list, on the reasoning that
-- 00053 had already collapsed `done` into `deleted`. That reasoning does not survive the requirement
-- it was measured against: a completed item should stay VISIBLE on the calendar, because seeing the
-- day fill in is half the reward. An event in a side table cannot do that — the item is gone from
-- every surface that draws items.
--
-- Nor does it conflict with 00053. That migration collapsed two flags that MEANT THE SAME THING —
-- both said "this has been dealt with, take it off the list" — and the damage was two surfaces
-- disagreeing about what a tick meant. These two mean different things and have different outcomes:
--
--   completed_at set   the thing happened. Leaves the active lists, STAYS on the calendar, scores.
--   deleted = true     it is gone. No credit, no record, purged after the recovery window.
--
-- The practical argument is stronger than the modelling one. With no completion verb, "take the
-- shirt off the list and put it back up at 1 for the dryer" routed to `set_due` and simply moved the
-- item: two instructions collapsed into one reschedule, because there was nothing else to land on.
-- Distinct outcomes need distinct verbs.

-- A timestamp, not a boolean: the score needs to know HOW LATE it was, and a separate flag beside
-- the time is the second field that can contradict the first.
alter table list_items add column if not exists completed_at text;

-- Every active surface asks the same question, and it is now two conditions rather than one.
create index if not exists list_items_active_idx
  on list_items (due) where deleted = false and completed_at is null and due is not null;

-- `task_events` and its trigger are redundant: a completed item persists, so it IS the record. They
-- are dropped in 00089, after the hub that still reads them has been redeployed — PostgREST errors
-- on a missing table, and the status frame reads it on every build.
