-- WHEN THE PHONE LAST CONFIRMED it has this alarm registered with iOS.
--
-- An AlarmKit alarm lives on the device, so marking an item `alarm` is a REQUEST and nothing more —
-- the hub cannot know it will ring. The phone acks what it actually holds (POST /api/alarms/ack after
-- every sync) and this is where that lands, which is what lets a surface show the difference between
-- "asked for" and "armed" instead of promising something it cannot see.
--
-- Null means not confirmed: never acked, or the phone acked a set this item was not in (it cancelled
-- it, or never managed to schedule it).
alter table list_items add column if not exists alarm_armed_at timestamptz;
