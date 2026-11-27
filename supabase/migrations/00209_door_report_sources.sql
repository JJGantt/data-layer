-- door_report() becomes the ONE writer of door_events for every source: the Bluetooth listeners
-- (door/listener.py, 'ble'), and the status hub's webhook, lock/unlock ('command') and backstop
-- (server/routes/switchbot.js). Its advisory lock serialises them across processes and machines, so a
-- command and the Bluetooth advert of the same change, or two listeners hearing one advert, produce one
-- row: whichever arrives second finds the state already recorded. The advert sequence check applies to
-- 'ble' reports only. Returns the rows written.
drop function if exists door_report(text, text, integer, integer, text, jsonb);

create or replace function door_report(p_source text, p_lock text, p_door text, p_battery integer default null,
                                       p_seq integer default null, p_machine text default null,
                                       p_raw jsonb default null)
returns setof door_events language plpgsql as $$
declare
  prev door_events;
  last_ble door_events;
  lk text; dr text;
begin
  perform pg_advisory_xact_lock(hashtext('door_events'));
  select * into prev from door_events order by at desc, id desc limit 1;
  if p_source = 'ble' and p_seq is not null then
    select * into last_ble from door_events where source = 'ble' and ble_seq is not null
      and at > now() - interval '10 minutes' order by at desc, id desc limit 1;
    -- Sequence is one byte and wraps: 128..255 behind the latest is an older advert.
    if last_ble.id is not null and ((p_seq - last_ble.ble_seq + 256) % 256) >= 128 then return; end if;
  end if;
  lk := coalesce(p_lock, prev.lock_state);
  dr := coalesce(p_door, prev.door_state);
  if p_lock is not null and p_lock is distinct from prev.lock_state then
    return query insert into door_events (event, lock_state, door_state, source, raw, ble_seq, machine)
      values (p_lock, lk, prev.door_state, p_source, p_raw, p_seq, p_machine) returning *;
  end if;
  if p_door is not null and p_door is distinct from prev.door_state then
    return query insert into door_events (event, lock_state, door_state, source, raw, ble_seq, machine)
      values (p_door, lk, dr, p_source, p_raw, p_seq, p_machine) returning *;
  end if;
  insert into device_status (device, name, status, online, updated_at, data)
    values ('front-door', 'Front door', lk, true, now(),
            jsonb_build_object('lock', lk, 'door', dr, 'battery', p_battery))
  on conflict (device) do update set
    status = excluded.status, online = true, updated_at = now(),
    data = coalesce(device_status.data, '{}'::jsonb) || jsonb_strip_nulls(excluded.data);
end $$;
revoke all on function door_report(text, text, text, integer, integer, text, jsonb) from public, anon, authenticated;
