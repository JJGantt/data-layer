-- HEALTH ROLLUPS — what get_health_data reads, so a model is handed days rather than thousands of
-- heart-rate rows. Days are calendar days in America/New_York (not the hub's 4am nutrition day: a
-- reading at 1am belongs to the date on the clock).

-- Every type that has data, with its unit and span: the catalogue a caller picks a type from.
create or replace function health_types()
returns table (type text, unit text, samples bigint, first_at timestamptz, last_at timestamptz)
language sql stable as $$
  select type, max(unit), count(*), min(start_at), max(start_at)
  from health_samples group by type order by type
$$;

-- One type rolled up per day. `sum` is the meaningful figure for cumulative types (steps, energy,
-- distance, exercise minutes), `avg`/`min`/`max` for the rest (heart rate, HRV, SpO2, weight).
create or replace function health_daily(p_type text, p_from date, p_to date)
returns table (day date, samples bigint, avg double precision, min double precision,
               max double precision, sum double precision, unit text)
language sql stable as $$
  select (start_at at time zone 'America/New_York')::date, count(*), avg(value), min(value),
         max(value), sum(value), max(unit)
  from health_samples
  where type = p_type
    and start_at >= (p_from::timestamp at time zone 'America/New_York')
    and start_at <  ((p_to + 1)::timestamp at time zone 'America/New_York')
  group by 1 order by 1
$$;

-- One row per night from sleep_samples, keyed by the wake date. A "night" is a run of samples
-- with no gap over three hours, so a nap is its own row rather than part of the night before.
create or replace function sleep_nights(p_from date, p_to date)
returns table (night date, bed_at timestamptz, up_at timestamptz, asleep_min double precision,
               core_min double precision, deep_min double precision, rem_min double precision,
               awake_min double precision, in_bed_min double precision)
language sql stable as $$
  with s as (
    select *, extract(epoch from end_at - start_at) / 60 as mins,
           case when start_at - lag(end_at) over (order by start_at) > interval '3 hours'
                  or lag(end_at) over (order by start_at) is null then 1 else 0 end as brk
    from sleep_samples
  ), g as (select *, sum(brk) over (order by start_at) as grp from s)
  select (max(end_at) at time zone 'America/New_York')::date, min(start_at), max(end_at),
         coalesce(sum(mins) filter (where stage in ('core', 'deep', 'rem', 'asleep_unspecified')), 0),
         coalesce(sum(mins) filter (where stage = 'core'), 0),
         coalesce(sum(mins) filter (where stage = 'deep'), 0),
         coalesce(sum(mins) filter (where stage = 'rem'), 0),
         coalesce(sum(mins) filter (where stage = 'awake'), 0),
         coalesce(sum(mins) filter (where stage = 'in_bed'), 0)
  from g group by grp
  having (max(end_at) at time zone 'America/New_York')::date between p_from and p_to
  order by 1
$$;
