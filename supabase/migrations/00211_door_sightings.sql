-- Every report a source makes about the front door, kept even when it adds nothing to door_events.
-- door_events stays the ground truth (one row per change, written by whichever source got there first);
-- door_sightings records who said what and when, so each source's reliability and lag can be measured:
-- for every change, which of the Bluetooth listeners, the SwitchBot webhook and the hub's own commands
-- reported it, and how long after the first.
--
-- outcome: 'new' wrote at least one door_events row; 'duplicate' carried only what was already recorded;
-- 'stale' was a Bluetooth advert older than the latest one (sequence check) and was ignored.
-- lock_event / door_event: the door_events row that holds the state this report carried, the one it wrote
-- or the one it duplicated. sampled_at: the source's own time for the reading when it gives one (the
-- webhook's context.timeOfSample), so its delivery lag can be told from the moment the lock changed.
-- The backstop's 5-minute status read is a poll, not a report, and is kept only when it wrote a row.
create table door_sightings (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  source text not null check (source in ('ble', 'webhook', 'backstop', 'command')),
  machine text,
  lock_state text,
  door_state text,
  battery integer,
  ble_seq integer,
  sampled_at timestamptz,
  outcome text not null check (outcome in ('new', 'duplicate', 'stale')),
  lock_event bigint references door_events (id),
  door_event bigint references door_events (id)
);
create index door_sightings_lock_event on door_sightings (lock_event);
create index door_sightings_door_event on door_sightings (door_event);

create or replace function door_report(p_source text, p_lock text, p_door text, p_battery integer default null,
                                       p_seq integer default null, p_machine text default null,
                                       p_raw jsonb default null)
returns setof door_events language plpgsql as $$
declare
  prev door_events;
  last_ble door_events;
  lk text; dr text;
  wrote_lock door_events; wrote_door door_events;
  lock_id bigint; door_id bigint;
  sampled timestamptz;
begin
  perform pg_advisory_xact_lock(hashtext('door_events'));
  begin
    sampled := to_timestamp((p_raw -> 'context' ->> 'timeOfSample')::double precision / 1000);
  exception when others then sampled := null;
  end;
  select * into prev from door_events order by at desc, id desc limit 1;
  if p_source = 'ble' and p_seq is not null then
    select * into last_ble from door_events where source = 'ble' and ble_seq is not null
      and at > now() - interval '10 minutes' order by at desc, id desc limit 1;
    -- Sequence is one byte and wraps: 128..255 behind the latest is an older advert.
    if last_ble.id is not null and ((p_seq - last_ble.ble_seq + 256) % 256) >= 128 then
      insert into door_sightings (source, machine, lock_state, door_state, battery, ble_seq, sampled_at, outcome)
        values (p_source, p_machine, p_lock, p_door, p_battery, p_seq, sampled, 'stale');
      return;
    end if;
  end if;
  lk := coalesce(p_lock, prev.lock_state);
  dr := coalesce(p_door, prev.door_state);
  if p_lock is not null and p_lock is distinct from prev.lock_state then
    insert into door_events (event, lock_state, door_state, source, raw, ble_seq, machine)
      values (p_lock, lk, prev.door_state, p_source, p_raw, p_seq, p_machine) returning * into wrote_lock;
    return next wrote_lock;
  end if;
  if p_door is not null and p_door is distinct from prev.door_state then
    insert into door_events (event, lock_state, door_state, source, raw, ble_seq, machine)
      values (p_door, lk, dr, p_source, p_raw, p_seq, p_machine) returning * into wrote_door;
    return next wrote_door;
  end if;
  -- The row holding each carried value: the one just written, else the latest change to that value.
  if p_lock is not null then
    lock_id := coalesce(wrote_lock.id, (select id from door_events where event = p_lock
      and event in ('locked', 'unlocked', 'jammed') order by at desc, id desc limit 1));
  end if;
  if p_door is not null then
    door_id := coalesce(wrote_door.id, (select id from door_events where event = p_door
      and event in ('opened', 'closed') order by at desc, id desc limit 1));
  end if;
  if p_source <> 'backstop' or wrote_lock.id is not null or wrote_door.id is not null then
    insert into door_sightings (source, machine, lock_state, door_state, battery, ble_seq, sampled_at, outcome,
                                lock_event, door_event)
      values (p_source, p_machine, p_lock, p_door, p_battery, p_seq, sampled,
              case when wrote_lock.id is not null or wrote_door.id is not null then 'new' else 'duplicate' end,
              lock_id, door_id);
  end if;
  insert into device_status (device, name, status, online, updated_at, data)
    values ('front-door', 'Front door', lk, true, now(),
            jsonb_build_object('lock', lk, 'door', dr, 'battery', p_battery))
  on conflict (device) do update set
    status = excluded.status, online = true, updated_at = now(),
    data = coalesce(device_status.data, '{}'::jsonb) || jsonb_strip_nulls(excluded.data);
end $$;
revoke all on function door_report(text, text, text, integer, integer, text, jsonb) from public, anon, authenticated;

-- Per change since sightings began: each source that reported it, with how long after the change was
-- recorded (the first report, so the recording source shows 0).
create view door_event_sources with (security_invoker = true) as
select e.id, e.at, e.event, e.source as recorded_by,
       coalesce(jsonb_object_agg(s.source, round(extract(epoch from s.first_at - e.at)::numeric, 2))
                filter (where s.source is not null), '{}'::jsonb) as heard_by
from door_events e
left join lateral (
  select source, min(at) as first_at from door_sightings
  where (lock_event = e.id or door_event = e.id) and outcome <> 'stale'
  group by source
) s on true
where e.at >= (select coalesce(min(at), now()) from door_sightings)
group by e.id, e.at, e.event, e.source;
