-- Testing the arrival approaches one at a time (status-hub docs/DOOR.md): app_settings.door_unlock_modes
-- says which may unlock ({"elevator","wifi","bluetooth"} booleans). A ride detected while the elevator
-- approach is off is still recorded, as 'disabled'. lan_joins joins realtime so the hub acts on a Wi-Fi
-- join the moment a listener writes it.
alter table elevator_rides drop constraint elevator_rides_outcome_check;
alter table elevator_rides add constraint elevator_rides_outcome_check
  check (outcome in ('unlocked', 'already_unlocked', 'unlock_failed', 'no_exit', 'no_ride', 'down', 'disabled'));
insert into app_settings (key, value) values ('door_unlock_modes', '{"elevator":true,"wifi":false,"bluetooth":false}')
  on conflict (key) do nothing;
alter publication supabase_realtime add table lan_joins;
