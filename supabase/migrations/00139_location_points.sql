-- EVERY POSITION THE USER'S DEVICES REPORT, kept at the grain they report it (status-hub docs/LOCATION.md).
-- `locations` (00128) is the latest fix per device; this is the history behind it, so "where was I
-- yesterday at 3" has an answer. The phone and the watch each record on their own, because they get
-- separated: rows are keyed by device, and nothing merges them.
--
-- (device, at) is the key because a device never reports two fixes for one instant, and a batch the app
-- resends after a lost reply then lands on the rows it already wrote instead of doubling them.
--
-- RLS on with NO policies: a position is the service role's business only.
create table if not exists location_points (
  device      text not null,              -- 'phone', 'watch', 'mac'
  at          timestamptz not null,       -- when the device took the fix
  lat         double precision not null,
  lon         double precision not null,
  h_acc       real,                       -- metres, horizontal accuracy as reported
  alt         real,                       -- metres above sea level
  v_acc       real,
  speed       real,                       -- m/s; null when the device did not know
  course      real,                       -- degrees from true north; null when unknown
  floor       smallint,
  received_at timestamptz not null default now(),
  primary key (device, at)
);
create index if not exists location_points_at on location_points (at desc);
alter table location_points enable row level security;
