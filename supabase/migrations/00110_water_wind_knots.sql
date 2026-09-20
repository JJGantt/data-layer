-- Put the observed wind in knots, and drop the rows that hold only NDBC's missing-value sentinel.
--
-- KNOTS, because this column exists to be differenced against surf_hours.w_spd, and that is knots:
-- capture.mjs stores whatever the Surfline page requested, and the page asks for
-- units[windSpeed]=KTS (confirmed in the response's own associated.units). Surfline's spot page and
-- NDBC's station page both display knots as well, so this is also the number seen when either is
-- checked by hand. Holding the measurement in mph next to a forecast in knots puts a 1.15 factor
-- between two columns that look directly comparable.
alter table public.water_readings rename column wind_mph to wind_kts;
alter table public.water_readings rename column gust_mph to gust_kts;

update public.water_readings
   set wind_kts = round((wind_kts / 1.150779)::numeric, 1)::real,
       gust_kts = round((gust_kts / 1.150779)::numeric, 1)::real
 where wind_kts is not null or gust_kts is not null;

-- The monthly stdmet archives mark a dead sensor with an all-nines value in the field's own width
-- (999 direction, 99.0 m/s, 999.0 degrees C) rather than the realtime feed's MM. Those parse as
-- numbers, so a collector that only checks for MM stores 1830.2 F water and 221.5 mph wind — values
-- flagged nowhere, which quietly wreck any average taken over the column.
--
-- ndbc.mjs now range-checks every field against what the instrument can physically report, which
-- rejects the sentinels at parse time. The constraint below is that same test at the table, so a
-- future collector cannot reintroduce them: a parser bug fails its insert instead of landing
-- silently. The affected rows carry a sentinel in EVERY field, so nothing is lost with them.
delete from public.water_readings
 where water_f      > 120     -- 1830.2 F, from 999.0 C
    or wind_kts     > 100
    or gust_kts     > 100
    or wind_dir_deg > 360;    -- 999 degrees

alter table public.water_readings drop constraint if exists water_readings_plausible;
alter table public.water_readings add constraint water_readings_plausible check (
      (water_f      is null or water_f      between 25 and 105)
  and (wind_kts     is null or wind_kts     between 0  and 150)
  and (gust_kts     is null or gust_kts     between 0  and 150)
  and (wind_dir_deg is null or wind_dir_deg between 0  and 360)
);

comment on column public.water_readings.wind_kts is
  'sustained wind, knots (NDBC WSPD, m/s converted); same unit as surf_hours.w_spd';
comment on column public.water_readings.gust_kts is 'peak gust, knots (NDBC GST, m/s converted)';
