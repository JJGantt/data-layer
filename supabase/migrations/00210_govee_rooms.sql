-- The room each light is in, as the Govee app groups them, so a command can address a whole room
-- ("the bedroom") in one call. Govee's public API does not return rooms, so sync_devices.py never
-- writes this column and it survives every sync.
alter table govee_devices add column if not exists room text;

-- Set when a light stops appearing on the Govee account. The row stays, and the light stays on the
-- roster, until someone deletes it: nothing drops a light by itself.
alter table govee_devices add column if not exists removed_at timestamptz;

update govee_devices set room = 'Bedroom' where key in ('ceiling1', 'ceiling2');
