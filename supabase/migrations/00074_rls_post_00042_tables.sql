-- RLS on reports, workset_reports and set_watcher.
--
-- Supabase creates a table from a SQL migration with RLS off, and the anon key
-- is public: it ships inside the Workset watch app binary as
-- CaptureUploader.publishableKey. A table without RLS is reachable with it.
--
-- `SetReporter.swift` reaches two of these tables with that key, so they get
-- RLS *with* policies granting what the app does. No client deletes from any of
-- them, so none of the policies allows DELETE. Later migrations narrow these
-- further (00147 for workset_reports, 00151 for set_watcher).

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
