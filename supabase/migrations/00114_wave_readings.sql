-- MEASURED WAVES at the NDBC buoys either side of Mayport, beside the measured wind in water_readings.
--
-- Written by the hub (status-hub lib/livebuoy.js) from each station's realtime2 `.txt` (total height,
-- periods, mean direction, water) and `.spec` (the same sea split into SWELL and WIND WAVES). Every
-- wave number elsewhere is Surfline's model; this is what the water actually did, which is what a
-- short-term forecast needs to correct the model against.
--   41112  Offshore Fernandina Beach (CDIP 132), ~22 mi N
--   41117  St. Augustine (CDIP 194), ~30 mi S
-- Heights in FEET (NDBC serves metres), periods in seconds, directions the waves come FROM: degrees
-- true for the mean, a compass point for the swell and wind-wave parts, which is all `.spec` gives.
create table if not exists wave_readings (
  station text not null,
  ts timestamptz not null,
  wvht_ft real,          -- significant height, whole sea
  dpd_s real,            -- dominant period
  apd_s real,            -- average period
  mwd_deg real,          -- direction at the dominant period
  swh_ft real,           -- swell height
  swp_s real,            -- swell period
  swd text,              -- swell direction, compass point
  wwh_ft real,           -- wind-wave height
  wwp_s real,            -- wind-wave period
  wwd text,              -- wind-wave direction, compass point
  steepness text,
  water_f real,
  primary key (station, ts)
);
alter table wave_readings enable row level security;
