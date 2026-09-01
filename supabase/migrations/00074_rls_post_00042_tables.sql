-- Close the RLS gap on tables created after 00042.
--
-- 00042 enabled RLS on the 38 tables that existed in July. Supabase defaults
-- tables created via SQL migration to RLS OFF, and nothing enforces it on new
-- ones, so three tables added since then were reachable with the anon key:
--
--   reports          (00064)  read + insert + DELETE
--   workset_reports           read + insert + update + DELETE
--   set_watcher      (00045)  read + DELETE
--
-- Verified by querying each of the 67 public tables with the anon key and
-- comparing against the service key. Everything else is already denied;
-- voice_presence is anon-reachable on purpose and 00042 documents why.
--
-- The anon key is genuinely public: it ships inside the Workset watch app
-- binary as CaptureUploader.publishableKey, so this is real exposure, not a
-- theoretical one.
--
-- The blanket fix would break the watch. `SetReporter.swift` needs anon access
-- to two of these tables, so they get RLS *with* policies granting exactly what
-- the app does and nothing more. What that removes in every case is DELETE,
-- which no client uses.

-- reports: nothing but the hub server touches it, and that uses service_role,
-- which bypasses RLS. No policies -> anon is denied outright.
alter table public.reports enable row level security;

-- workset_reports: the watch POSTs a set (with `Prefer: return=representation`,
-- so the insert must be able to read the row back), then PATCHes it to correct
-- the rep count or mark it deleted. Select is unrestricted because an anon key
-- carries no identity to scope rows by; the achievable win here is dropping
-- DELETE, not narrowing SELECT.
alter table public.workset_reports enable row level security;

create policy "anon reads reports"   on public.workset_reports
  for select to anon using (true);
create policy "anon files reports"   on public.workset_reports
  for insert to anon with check (true);
create policy "anon amends reports"  on public.workset_reports
  for update to anon using (true) with check (true);

-- set_watcher: the watch only reads row 1 to show what it is armed to. It never
-- writes -- arming happens through the data MCP on service_role.
alter table public.set_watcher enable row level security;

create policy "anon reads watcher" on public.set_watcher
  for select to anon using (true);
