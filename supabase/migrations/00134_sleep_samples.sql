-- SLEEP SAMPLES — Apple Watch sleep as Apple Health records it, one row per HealthKit sample.
--
-- The StatusHub iPhone app reads HKCategoryTypeIdentifier.sleepAnalysis and posts new and deleted
-- samples to the hub (/api/health/sleep, status-hub docs/SLEEP.md), which writes here. `id` is the
-- sample's HealthKit UUID, so a re-sent sample upserts instead of duplicating, and a deletion in
-- Health removes the same row.
--
-- The watch writes a night's stages only after waking, so this is a record of past nights, not a
-- live "asleep now" signal.
create table if not exists sleep_samples (
  id uuid primary key,
  start_at timestamptz not null,
  end_at timestamptz not null,
  -- HKCategoryValueSleepAnalysis: in_bed, asleep_unspecified, awake, core, deep, rem
  stage text not null,
  source text,      -- the writing app/device as Health names it ("<name>'s Apple Watch")
  received_at timestamptz not null default now()
);
create index if not exists sleep_samples_start on sleep_samples (start_at desc);
alter table sleep_samples enable row level security;
