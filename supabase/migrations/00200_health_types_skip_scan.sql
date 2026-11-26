-- health_types() without the full scan. A GROUP BY over health_samples reads every row (600k+ and
-- growing ~2k a day) and ran past the API's 8s statement timeout. This walks the
-- (type, start_at desc) index instead: one probe per distinct type, then the first and last sample
-- of each, so it costs ~70 index lookups however large the table grows. Per-type sample counts are
-- dropped, because counting is exactly the full read this avoids.
drop function if exists health_types();
create function health_types()
returns table (type text, unit text, first_at timestamptz, last_at timestamptz)
language sql stable as $$
  with recursive t(type) as (
    (select h.type from health_samples h order by h.type limit 1)
    union all
    select (select h.type from health_samples h where h.type > t.type order by h.type limit 1)
    from t where t.type is not null
  )
  select t.type,
    (select h.unit from health_samples h where h.type = t.type order by h.start_at desc limit 1),
    (select h.start_at from health_samples h where h.type = t.type order by h.start_at asc limit 1),
    (select h.start_at from health_samples h where h.type = t.type order by h.start_at desc limit 1)
  from t where t.type is not null
  order by t.type
$$;
