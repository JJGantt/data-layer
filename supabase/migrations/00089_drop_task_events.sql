-- CONTRACT half of 00088. A completed item persists (`completed_at`), so it is its own record and
-- the separate ledger has nothing left to hold. Safe only once the hub that read `task_events` has
-- been redeployed — it read the table on every status build.
drop trigger if exists list_items_task_event_trg on list_items;
drop function if exists list_items_task_event();
drop table if exists task_events;
