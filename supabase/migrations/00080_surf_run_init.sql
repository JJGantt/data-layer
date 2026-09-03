-- Record which model run a snapshot came from.
--
-- The KBYG payloads carry `runInitializationTimestamp` — the wave/weather model cycle the forecast
-- was produced by. Two captures of the same run are byte-identical: same 240 rows, same window,
-- same hash, verified against two captures 74 minutes apart. So a capture that finds the run
-- unchanged has nothing to add, and storing it costs ~17KB for a duplicate.
--
-- That matters now the collector runs four times a day against a cycle that appears to be six
-- hours: without this column most captures would be duplicates. With it, capture frequency and
-- storage growth are decoupled, so polling more often costs nothing but a page load.
--
-- Nullable, and the 151 existing rows stay null — the value was never captured for them and there
-- is no way to recover it. Treat null as "unknown run", never as "same run".
alter table public.surf_snapshots add column if not exists run_init bigint;

create index if not exists surf_snapshots_spot_run_idx
  on public.surf_snapshots (spot_id, run_init desc nulls last);
