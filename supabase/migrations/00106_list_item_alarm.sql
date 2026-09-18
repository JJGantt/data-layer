-- An ALARM-GRADE dated item: one that should RING through silent mode and a Focus rather than arrive
-- as a notification. iOS 26's AlarmKit is what rings it, and an AlarmKit alarm is registered ON the
-- device, so the phone reads this flag (through the hub's /api/alarms) and schedules locally.
--
-- Explicit, and false by default, because the two kinds are not interchangeable: a soup timer should
-- wake the room and "pick up dry cleaning" at 2am should not. Nothing infers this from priority or
-- from wording — an item rings only because it was marked.
alter table list_items add column if not exists alarm boolean not null default false;

-- The alarm feed reads only the marked ones, which are a handful out of every dated item.
create index if not exists list_items_alarm_idx on list_items (due) where alarm and not deleted;
