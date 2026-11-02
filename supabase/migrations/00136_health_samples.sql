-- HEALTH SAMPLES — everything Apple Health holds except sleep, one row per HealthKit sample.
--
-- The StatusHub iPhone app reads every quantity and category type Health exposes, plus workouts, and
-- posts new and deleted samples to the hub (/api/health/samples, status-hub docs/HEALTH.md), which
-- writes here. `id` is the sample's HealthKit UUID, so a re-sent sample upserts instead of
-- duplicating, and a deletion in Health removes the same row. Sleep stays in `sleep_samples` (00134).
--
-- `type` is the HealthKit identifier with its prefix dropped: `heartRate`, `restingHeartRate`,
-- `heartRateVariabilitySDNN`, `stepCount`, `activeEnergyBurned`, `appleStandHour`, `workout`, ...
--
--   quantity types: `value` in `unit`, which is the unit Health itself displays for that type
--                   (count/min for heart rate, ms for HRV, kcal, count, m, %, degC, ...).
--   category types: `value` is the HKCategoryValue raw integer for that type, `unit` is null.
--   workouts:       `type` = 'workout', `label` the activity (running, traditionalStrengthTraining,
--                   ...), `value` the duration in seconds, `unit` 's', and `metadata.stats` the
--                   workout's own statistics per type (`{"heartRate": {"avg":..,"min":..,"max":..,
--                   "unit":"count/min"}, "activeEnergyBurned": {"sum":..,"unit":"kcal"}}`).
--
-- Heart rate is the bulk of it: a sample every few minutes at rest and every few seconds in a
-- workout, roughly 1-3k rows a day.
create table if not exists health_samples (
  id uuid primary key,
  type text not null,
  value double precision,
  unit text,
  label text,
  start_at timestamptz not null,
  end_at timestamptz not null,
  source text,      -- the writing app/device as Health names it ("<name>'s Apple Watch")
  metadata jsonb,   -- HealthKit's own metadata for the sample, plus `stats` on a workout
  received_at timestamptz not null default now()
);
create index if not exists health_samples_type_start on health_samples (type, start_at desc);
alter table health_samples enable row level security;
