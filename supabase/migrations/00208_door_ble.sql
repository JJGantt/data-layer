-- FRONT DOOR over Bluetooth (README § The front door). The lock's own BLE advertisements, heard by a
-- listener on each machine near the door (door/listener.py), are now the primary source of door_events;
-- the hub's webhook route and five-minute backstop stay behind it.
--
-- door_report() is the one writer for listeners: it takes an advisory lock so two listeners hearing the
-- same advertisement produce one row, compares the report to the latest row (one row per value that
-- changed, the same rules as status-hub server/lib/door.js), drops a report whose advert sequence byte
-- is OLDER than the latest BLE row's (a slow listener's stale advert after a newer change), and keeps
-- device_status 'front-door' current, battery merged in rather than nulled.
alter table door_events drop constraint if exists door_events_source_check;
alter table door_events add constraint door_events_source_check check (source in ('webhook', 'backstop', 'command', 'ble'));
alter table door_events add column if not exists ble_seq integer;
alter table door_events add column if not exists machine text;

create or replace function door_report(p_lock text, p_door text, p_seq integer, p_battery integer,
                                       p_machine text, p_raw jsonb)
returns setof door_events language plpgsql as $$
declare
  prev door_events;
  last_ble door_events;
  lk text; dr text;
begin
  perform pg_advisory_xact_lock(hashtext('door_events'));
  select * into prev from door_events order by at desc, id desc limit 1;
  select * into last_ble from door_events where source = 'ble' and ble_seq is not null
    and at > now() - interval '10 minutes' order by at desc, id desc limit 1;
  -- Sequence is one byte and wraps: 128..255 behind the latest is an older advert.
  if last_ble.id is not null and ((p_seq - last_ble.ble_seq + 256) % 256) >= 128 then return; end if;
  lk := coalesce(p_lock, prev.lock_state);
  dr := coalesce(p_door, prev.door_state);
  if p_lock is not null and p_lock is distinct from prev.lock_state then
    return query insert into door_events (event, lock_state, door_state, source, raw, ble_seq, machine)
      values (p_lock, lk, prev.door_state, 'ble', p_raw, p_seq, p_machine) returning *;
  end if;
  if p_door is not null and p_door is distinct from prev.door_state then
    return query insert into door_events (event, lock_state, door_state, source, raw, ble_seq, machine)
      values (p_door, lk, dr, 'ble', p_raw, p_seq, p_machine) returning *;
  end if;
  insert into device_status (device, name, status, online, updated_at, data)
    values ('front-door', 'Front door', lk, true, now(),
            jsonb_build_object('lock', lk, 'door', dr, 'battery', p_battery))
  on conflict (device) do update set
    status = excluded.status, online = true, updated_at = now(),
    data = coalesce(device_status.data, '{}'::jsonb) || jsonb_strip_nulls(excluded.data);
end $$;
revoke all on function door_report(text, text, integer, integer, text, jsonb) from public, anon, authenticated;
