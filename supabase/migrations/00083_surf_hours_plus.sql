-- Record Surfline's `plus` flag and the unrounded surf height.
--
-- `surf.min`/`surf.max` are a coarse label, not the number. Two hours both reported as "2-3 ft"
-- differ by about three quarters of a foot depending on `plus`:
--
--   2-3     raw 1.54-2.53   "Thigh to waist"
--   2-3+    raw 2.30-3.28   "Thigh to stomach"
--
-- Dropping the flag made those identical cells on the grid, which is why a building swell rendered
-- flat. `plus` is not specific to 2-3 either — spots with real size show 2-3+, 3-4+ and 4-6+, and
-- the bands are not uniform one-foot steps up there (4-5 and 4-6 both exist).
--
-- s_raw_min/max are kept so banding stays a rendering decision rather than something baked into
-- storage: any future scheme can re-derive its cut points from the actual heights.
--
-- All three are null for the 2,000-odd rows that predate this. The archive's snapshots only ever
-- distilled min/max, so the flag is unrecoverable for them — treat null as unknown, not as false.
-- At this spot the cost is small: `plus` covered 2 hours of the current 240-hour forecast.
alter table public.surf_hours add column if not exists s_plus    boolean;
alter table public.surf_hours add column if not exists s_raw_min real;
alter table public.surf_hours add column if not exists s_raw_max real;
