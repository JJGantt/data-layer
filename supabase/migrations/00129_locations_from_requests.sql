-- `locations` (00128) follows every command that carries a fix. Both writers of voice_requests — the hub
-- and the voice-fallback edge function — already put the device's fix in `location`, so a trigger here
-- is the one place that keeps the last-known position current, rather than a second write in each.
-- The device is the request's source folded to what a model needs to tell apart: the watch, or a page.
create or replace function locations_from_request() returns trigger language plpgsql as $$
begin
  if new.location is not null and new.location ? 'lat' and new.location ? 'lon' then
    insert into locations (device, lat, lon, acc, place, at)
    values (case when new.source like 'watch%' then 'watch' else 'web' end,
            (new.location->>'lat')::double precision, (new.location->>'lon')::double precision,
            (new.location->>'acc')::integer, nullif(new.location->>'place', ''), now())
    on conflict (device) do update
      set lat = excluded.lat, lon = excluded.lon, acc = excluded.acc, place = excluded.place, at = excluded.at;
  end if;
  return new;
end $$;

drop trigger if exists voice_requests_location on voice_requests;
create trigger voice_requests_location after insert on voice_requests
  for each row execute function locations_from_request();
