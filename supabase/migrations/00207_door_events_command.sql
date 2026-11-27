-- A door_events row written by the hub's own lock/unlock (status-hub POST /api/door, the watch's
-- toggle) is source 'command': that change came from us, so the backstop must not take it for an event
-- the webhook missed.
alter table door_events drop constraint if exists door_events_source_check;
alter table door_events add constraint door_events_source_check check (source in ('webhook', 'backstop', 'command'));
