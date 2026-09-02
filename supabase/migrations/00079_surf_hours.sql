-- One row per spot-hour: the best available reading for that hour, materialized from
-- surf_snapshots.
--
-- surf_snapshots stores whole 240-hour forecasts, so a given hour appears in ~17 of them at lead
-- times from +232h down to -15h. Answering "what were conditions at 8am on the 14th" therefore
-- means scanning every snapshot that spans it and picking one. This table picks once.
--
-- The rule is the most recent capture covering the hour. Its rival — nearest in absolute time —
-- disagrees about which row to take 38% of the time but about the RATING only 2.8%, so the choice
-- is nearly free; what is not free is mixing the two, which injects an artifact that is invisible
-- downstream. One rule, applied everywhere.
--
-- lead_hours is why this table is trustworthy. It is (ts - captured_at) in hours: positive means
-- the row was still a forecast when captured, negative means the hour had already passed. A row at
-- +2h agreed with the final reading 99% of the time; a row at +200h, 61%. Without this column a
-- converged hour and a ten-day guess are indistinguishable — same columns, same types — and any
-- model trained across them silently learns that a coin flip is ground truth. Filter on it.
--
-- Fields are copied verbatim from one snapshot row, never blended across captures. The rating is
-- computed by Surfline from that run's own wind and swell, so pairing one run's inputs with
-- another's verdict would destroy the relationship this table exists to preserve.
--
-- Nothing here is a measurement. Poles has no cam, no wind station and a null live feed; the swell
-- is a wave model at a grid point 25mi offshore and the wind is a weather model at the beach. The
-- one exception is tide, which comes from a real NOAA gauge and is not in this table.
create table if not exists public.surf_hours (
  spot_id            text        not null,
  slug               text,
  ts                 bigint      not null,          -- target hour, unix seconds
  hour_utc           timestamptz not null,          -- same instant, queryable
  rk                 text,                          -- Surfline rating key (POOR, FAIR, ...)
  rv                 smallint,                      -- rating ordinal
  s_min              real,                          -- breaking surf, ft
  s_max              real,
  w_spd              real,                          -- wind
  w_dir              real,
  w_type             text,                          -- Offshore / Onshore / Cross-shore
  w_opt              smallint,                      -- Surfline's wind optimality score
  sw_h               real,                          -- primary swell (highest spectral power)
  sw_p               real,
  sw_d               real,
  air_f              real,
  cond               text,
  water_f            real,                          -- snapshot-level, carried down
  lead_hours         real        not null,          -- + = forecast, - = after the fact
  source_captured_at timestamptz not null,
  updated_at         timestamptz not null default now(),
  primary key (spot_id, ts)
);

create index if not exists surf_hours_hour_idx on public.surf_hours (hour_utc);
create index if not exists surf_hours_rk_idx   on public.surf_hours (rk);

-- Matches every other table here: service_role bypasses RLS, and nothing else should reach this.
alter table public.surf_hours enable row level security;
