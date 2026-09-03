-- Distinguish a measured water temperature from a predicted one.
--
-- water_readings began as NDBC observations only, where "when was this true" and "when was this
-- known" are the same instant. Adding an Open-Meteo SST forecast breaks that: a row for 6pm Friday
-- written on Tuesday is a different kind of claim from the buoy reading at 6pm Friday.
--
-- Same lesson as surf_hours.lead_hours, and it is the one that matters most here. Without it a
-- forecast and a measurement are the same shape and the same columns, and anything reading this
-- table would average them together.
--
--   null      measured — NDBC, true when recorded
--   positive  forecast — hours ahead of issue time
--
-- Open-Meteo runs about +1.5F warm against buoy 41112 (mean +1.47, median +1.60, MAE 1.47 over 95
-- overlapping hours — a systematic offset, not scatter). The forecast is stored RAW and uncorrected:
-- both series are kept, so the bias can be recomputed from the overlap whenever it is wanted rather
-- than baked into the data where nobody can see or revise it.
alter table public.water_readings add column if not exists lead_hours real;

comment on column public.water_readings.lead_hours is
  'null = measured observation; positive = forecast, hours ahead of issue time';
