-- Observed wind at the NDBC stations, alongside the water temperature already kept here.
--
-- Every wind number elsewhere in the system is Surfline's model output, including the hours in the
-- past: a surf_hours row with a negative lead_hours is the model's own nowcast, revised by the next
-- run like any other forecast. Nothing recorded what the wind actually did, so no forecast could be
-- scored against it.
--
-- MYPF1 (Mayport Bar Pilots Dock, 2.2mi) carries the anemometer and reports every 6 minutes. 41112
-- is waves and water only, so its wind columns stay null — the buoy has no wind sensor, and an
-- empty column there is the instrument, not a collection gap.
--
-- Stored in mph and degrees true, matching surf_hours.w_spd / w_dir so observed and forecast can be
-- differenced directly. NDBC serves m/s and the collector converts, the same way it already
-- converts Celsius to F.
--
-- WDIR goes missing on its own while WSPD still reports, which is calm air rather than a fault: the
-- vane has no flow to point into. Those rows read wind_mph 0 with a null direction.
alter table public.water_readings add column if not exists wind_dir_deg real;
alter table public.water_readings add column if not exists wind_mph     real;
alter table public.water_readings add column if not exists gust_mph     real;

-- water_f was the only measurement the table held, so it was required. A station reporting wind
-- with its water sensor out is a real observation (70 such rows in a 45-day MYPF1 feed) and must
-- not be dropped for want of a temperature.
alter table public.water_readings alter column water_f drop not null;

alter table public.water_readings drop constraint if exists water_readings_has_measurement;
alter table public.water_readings add constraint water_readings_has_measurement
  check (water_f is not null or wind_mph is not null or wind_dir_deg is not null);

comment on column public.water_readings.wind_dir_deg is
  'direction the wind blows FROM, degrees true; null when calm or not measured';
comment on column public.water_readings.wind_mph is 'sustained wind, mph (NDBC WSPD, m/s converted)';
comment on column public.water_readings.gust_mph is 'peak gust, mph (NDBC GST, m/s converted)';
