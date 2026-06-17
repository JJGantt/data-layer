-- Status bus: devices upsert their current status here; the hub reads it.
create table if not exists device_status (
  device            text primary key,
  name              text,
  status            text,
  litter_level_pct  numeric,
  waste_drawer_pct  numeric,
  online            boolean,
  updated_at        timestamptz not null default now()
);
