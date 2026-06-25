-- Generic per-device payload for device_status, so devices with shapes that don't fit the
-- litter-robot's typed columns (e.g. the cat feeder: food level, last feed, schedule) can store
-- their own fields without widening the table per device.
alter table device_status add column if not exists data jsonb;
