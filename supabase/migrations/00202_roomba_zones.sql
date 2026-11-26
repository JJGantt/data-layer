-- Clean Zones drawn in the iRobot app (a litter box, under a table) sit beside the rooms in
-- roomba_rooms. A zone's id is numbered separately from the rooms' (both start low), so `kind` is part
-- of the key; the robot is sent type 'rid' for a room and 'zid' for a zone.
alter table roomba_rooms add column if not exists kind text not null default 'room' check (kind in ('room', 'zone'));
alter table roomba_rooms drop constraint if exists roomba_rooms_pkey;
alter table roomba_rooms add primary key (pmap_id, kind, region_id);
