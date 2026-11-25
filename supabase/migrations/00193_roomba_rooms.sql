-- ROOMBA ROOMS — the rooms on each of the Roomba's maps, as the iRobot app names them (data-layer
-- src/roomba.ts). The robot itself knows only map and region ids; the names live in iRobot's cloud map
-- and are copied here by roomba/fetch-cloud.py, re-run whenever rooms are renamed or remapped. A
-- room clean sends (pmap_id, user_pmapv_id, region_id) from a row here.
create table if not exists roomba_rooms (
  pmap_id text not null,
  region_id text not null,
  name text not null,
  region_type text,
  map_name text,
  user_pmapv_id text not null,
  updated_at timestamptz not null default now(),
  primary key (pmap_id, region_id)
);
alter table roomba_rooms enable row level security;
