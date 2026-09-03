-- Measured water temperature from NOAA NDBC stations.
--
-- Surfline publishes no water-temp forecast and no history: one whole-degree value per day, never
-- revised within it (66 of 66 paired 06:30/14:30 captures were identical). So the water column in
-- surf_snapshots answers "roughly how warm is it this week" and nothing finer.
--
-- NDBC is the opposite: a real instrument, reporting on its own clock, in Celsius to a tenth. Two
-- stations are worth keeping because they measure different water and the gap between them is the
-- interesting part:
--
--   41112  Offshore Fernandina Beach buoy, 23mi   open ocean; agrees with Surfline within ~1F
--   MYPF1  Mayport Bar Pilots Dock, 2.2mi         St Johns River mouth; runs ~3F warmer
--
-- MYPF1 is nearest but it is river water, tidally flushed and sun-warmed, so it is not the surf-zone
-- temperature despite being closest. It earns its place by reporting every 6 minutes, which is the
-- only way to see whether water temp moves within a day at all — a question the Surfline series
-- structurally cannot answer.
--
-- Stored in F to match everything else the hub renders; NDBC serves C and the collector converts.
create table if not exists public.water_readings (
  station  text        not null,
  ts       timestamptz not null,
  water_f  real        not null,
  primary key (station, ts)
);

create index if not exists water_readings_ts_idx on public.water_readings (ts desc);

alter table public.water_readings enable row level security;
