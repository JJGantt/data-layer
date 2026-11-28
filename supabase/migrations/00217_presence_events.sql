-- His phone and watch arriving at or leaving home, as heard by a listener near the door (data-layer
-- presence/ble.py): one row per change, not per sighting. The hub unlocks on a Bluetooth 'arrive' when
-- the bluetooth approach is on (status-hub routes/switchbot.js). away_s on an arrival is how long the
-- device had been unheard.
create table presence_events (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  machine text not null,
  device text not null,
  source text not null check (source in ('ble')),
  event text not null check (event in ('arrive', 'leave')),
  rssi integer,
  away_s integer
);
create index presence_events_at on presence_events (at desc);
alter publication supabase_realtime add table presence_events;
