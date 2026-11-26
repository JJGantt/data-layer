-- The Roomba's HOME MAP: the one map (pmap id) the roomba tool works with. The iRobot app keeps maps
-- of earlier homes; they stay there, but roomba/fetch-cloud.py saves only this map's rooms into
-- roomba_rooms, so `rooms` and `clean_rooms` see nothing else. Change the value to switch maps.
insert into app_settings (key, value) values
  ('roomba_map', 'PrlM0ujoRVa0Yv9zwQaM6Q')
on conflict (key) do nothing;
delete from roomba_rooms where pmap_id <> 'PrlM0ujoRVa0Yv9zwQaM6Q';
