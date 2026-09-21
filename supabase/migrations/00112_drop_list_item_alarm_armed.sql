-- The phone no longer registers alarms with AlarmKit, so there is no ack to record: the TV and the open
-- hub page ring straight from the feed. Nothing reads or writes this column.
alter table list_items drop column if exists alarm_armed_at;
