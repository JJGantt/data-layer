-- Weekly training volume per muscle: ONE definition, read by both the hub (the muscle gauges and the
-- body map) and data-layer (`get_weekly_volume`). They each used to implement it, and a report that
-- disagreed with the map it describes is what that produced.
--
-- The rule:
--   - the window is `p_days` training days counted back from today, where a day starts at 04:00 in the
--     display timezone (`app_settings.display_tz`, default America/New_York). `sets.occurred_at` is
--     naive local text, so a set at 01:30 belongs to the previous day;
--   - each set credits its muscles: `sets.muscles_override` when present, else the exercise's
--     `exercise_muscles` rows (matched by name, case-insensitively);
--   - sets fall into BOUTS, a new one after a gap of more than 3 hours, and a muscle earns at most 11
--     sets in one bout (the junk-volume guard). A bout belongs to the day of its last set;
--   - the weekly target per muscle is `muscle_volume_targets`, whose `_default` row covers the rest.
--
-- Returns what a caller needs to sum and present it, not a finished presentation:
--   window  the day strings, oldest first;
--   bouts   [{muscle, day, sets}]  each bout's credited sets per muscle, after the cap;
--   days    [{muscle, day, raw}]   uncapped credit per muscle per day (today's badge, recency);
--   targets {muscle: target, _default: n}.

create table if not exists muscle_volume_targets (
  muscle text primary key,
  target numeric not null check (target > 0)
);
alter table muscle_volume_targets enable row level security;
insert into muscle_volume_targets (muscle, target) values
  ('_default', 14), ('abs', 8), ('obliques', 8), ('erectors', 4), ('hip_flexors', 8), ('forearms', 10)
on conflict (muscle) do nothing;

create or replace function muscle_volume(p_days int default 7) returns jsonb
language sql stable set search_path = public as $$
with tz as (
  select coalesce((select value from app_settings where key = 'display_tz' and value <> ''), 'America/New_York') as z
), today as (
  select ((now() at time zone (select z from tz)) - interval '4 hours')::date as d
), win as (
  select (select d from today) - (greatest(p_days, 1) - 1) as start_day, (select d from today) as end_day
), s as (
  select left(st.occurred_at, 19)::timestamp as ts,
         (left(st.occurred_at, 19)::timestamp - interval '4 hours')::date as day,
         st.exercise, st.muscles_override
  from sets st, win
  where st.occurred_at >= to_char(win.start_day, 'YYYY-MM-DD') || 'T04:00:00'
), gaps as (
  select *, case when lag(ts) over (order by ts) is null
                   or ts - lag(ts) over (order by ts) > interval '3 hours' then 1 else 0 end as starts
  from s
), b as (
  select *, sum(starts) over (order by ts) as bout from gaps
), bout_day as (
  select distinct on (bout) bout, day from b order by bout, ts desc
), credit as (
  select b.bout, b.day, kv.key as muscle, (kv.value #>> '{}')::numeric as c
    from b, jsonb_each(b.muscles_override) kv
   where b.muscles_override is not null
  union all
  select b.bout, b.day, em.muscle, em.contribution::numeric
    from b join exercise_muscles em on lower(em.name) = lower(b.exercise)
   where b.muscles_override is null
), capped as (
  select c.muscle, bd.day, least(sum(c.c), 11) as sets
    from credit c join bout_day bd using (bout)
   group by c.bout, bd.day, c.muscle
), per_day as (
  select muscle, day, sum(c) as raw from credit group by day, muscle
)
select jsonb_build_object(
  'window', (select jsonb_agg(to_char(d, 'YYYY-MM-DD') order by d)
               from win, generate_series(win.start_day, win.end_day, interval '1 day') g(d)),
  'bouts', coalesce((select jsonb_agg(jsonb_build_object('muscle', muscle, 'day', to_char(day, 'YYYY-MM-DD'), 'sets', sets)) from capped), '[]'::jsonb),
  'days', coalesce((select jsonb_agg(jsonb_build_object('muscle', muscle, 'day', to_char(day, 'YYYY-MM-DD'), 'raw', raw)) from per_day), '[]'::jsonb),
  'targets', (select jsonb_object_agg(muscle, target) from muscle_volume_targets)
);
$$;

-- So a target changed in SQL reaches the hub's cached gauges at once.
do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'muscle_volume_targets') then
    alter publication supabase_realtime add table public.muscle_volume_targets;
  end if;
end $$;
