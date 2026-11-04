-- ENERGY SAMPLES MERGED TO THE MINUTE — active and basal energy, the bulk of health_samples.
--
-- While a workout session runs, the watch writes active and basal energy every ~3 seconds; a session
-- left running all day writes ~6,000 rows a day of each. Nothing reads them finer than a sum, and
-- held raw they outgrew the database's memory (2.1M of 2.3M rows), so every insert into the random-
-- UUID index read from disk and the instance ran out of disk I/O. Short samples are summed into one
-- row per type, source and minute; the totals for any minute, hour or day are unchanged.
--
-- A merged row's id is derived from (type, source, minute), so a later merge into the same minute
-- adds to it. Merging waits until samples are two days old, past the phone's retry of a failed page
-- (which resends the same UUIDs). A FULL re-read (changing the app's anchorKey, status-hub
-- docs/HEALTH.md) resends merged samples as raw ones and would count them twice: delete the merged
-- rows (metadata ? 'merged') of the types first.
create or replace function merge_energy_samples(p_from timestamptz, p_to timestamptz)
returns bigint language plpgsql as $$
declare n bigint;
begin
  with gone as (
    delete from health_samples
    where type in ('activeEnergyBurned', 'basalEnergyBurned')
      and start_at >= p_from and start_at < p_to
      and end_at - start_at < interval '60 seconds'
      and not (coalesce(metadata, '{}'::jsonb) ? 'merged')
    returning type, value, unit, source, start_at, end_at, received_at
  ), minutes as (
    select type, source, date_trunc('minute', start_at) m, sum(value) v, max(unit) unit,
           max(end_at) e, max(received_at) r, count(*) c
    from gone group by 1, 2, 3
  ), ins as (
    insert into health_samples (id, type, value, unit, start_at, end_at, source, metadata, received_at)
    select md5(type || '|' || coalesce(source, '') || '|' || m::text)::uuid, type, v, unit, m,
           greatest(e, m + interval '1 minute'), source, jsonb_build_object('merged', c), r
    from minutes
    on conflict (id) do update set
      value = health_samples.value + excluded.value,
      end_at = greatest(health_samples.end_at, excluded.end_at),
      metadata = jsonb_build_object('merged',
        (health_samples.metadata->>'merged')::bigint + (excluded.metadata->>'merged')::bigint),
      received_at = excluded.received_at
    returning 1
  )
  select (select count(*) from gone) into n;
  return n;
end $$;

-- Run by the hub after each page it writes (routes/healthdata.js), over the window two to thirty
-- days back, so the table stays merged without a timer.
create or replace function merge_recent_energy_samples()
returns bigint language sql as $$
  select merge_energy_samples(now() - interval '30 days', now() - interval '2 days')
$$;

revoke all on function merge_energy_samples(timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function merge_recent_energy_samples() from public, anon, authenticated;
