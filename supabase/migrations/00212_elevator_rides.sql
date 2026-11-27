-- The phone's elevator watch (status-hub apps/Sources/ElevatorUnlock.swift, docs/DOOR.md): every window
-- it ran near home, with the whole barometric and step trace, so the ride thresholds can be tuned from
-- real rides. One row per window or per ride in it.
--
-- outcome: 'unlocked' (a ride up, then steps, then the unlock went through), 'already_unlocked',
-- 'unlock_failed', 'no_exit' (a ride up with no steps after it in time), 'no_ride' (the window ended with
-- no ride seen). trace: { alt: [[seconds from started_at, relative altitude m], ...],
-- steps: [[seconds, cumulative steps], ...] }.
create table elevator_rides (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  device text not null,
  started_at timestamptz not null,
  ended_at timestamptz,
  outcome text not null check (outcome in ('unlocked', 'already_unlocked', 'unlock_failed', 'no_exit', 'no_ride')),
  rise_m real,
  ride_s real,
  steps_in_ride integer,
  steps_after integer,
  unlock_ms integer,
  thresholds jsonb,
  trace jsonb,
  error text
);
create index elevator_rides_at on elevator_rides (at desc);
