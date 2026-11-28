-- The phone's near-home trace (status-hub docs/DOOR.md § Near-home trace): while it watches inside the
-- home geofence it records every barometer sample, step-counter update, location fix and motion-activity
-- change, and uploads them in chunks of about 30 s, one row each. Logging only: thresholds for
-- unlocking the building's entrances (by precise location or the stairs at the main entrance) are picked
-- from these rows later; nothing acts on them.
--
-- Each stream is an array of compact arrays, times in seconds from started_at (1 decimal):
--   alt:      [t, relative altitude m, pressure kPa]
--   steps:    [t, cumulative steps since watching began, cadence steps/s or null, pace s/m or null]
--   fixes:    [t, lat, lon, horizontal accuracy m, altitude m, vertical accuracy m, speed m/s, course deg]
--   activity: [t, kind, confidence 0-2]   kind: stationary walking running automotive cycling unknown
--   modes:    [t, accuracy mode]          mode: best | low (the keep-alive manager's accuracy)
-- Retention: about 60 days is plenty for picking thresholds; no pruning job exists yet (docs/DOOR.md todo).
create table home_trace (
  id bigint generated always as identity primary key,
  received_at timestamptz not null default now(),
  device text not null,
  started_at timestamptz not null,
  ended_at timestamptz not null,
  alt jsonb not null default '[]',
  steps jsonb not null default '[]',
  fixes jsonb not null default '[]',
  activity jsonb not null default '[]',
  modes jsonb not null default '[]'
);
create index home_trace_started_at on home_trace (started_at desc);
