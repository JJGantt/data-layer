-- A TIMER is the gentle tier of a ringing item: it rings like an alarm (`alarm` stays true, so every
-- ringer that reads `alarm` still rings it), and the hub ends it about ten seconds after its moment by
-- completing it (status-hub docs/ALARMS.md). An alarm rings until someone stops it.
alter table list_items add column if not exists timer boolean not null default false;
alter table list_items add constraint list_items_timer_rings check (not timer or alarm);
