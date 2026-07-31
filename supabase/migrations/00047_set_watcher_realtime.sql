-- Push rep-watcher changes to the hub immediately.
--
-- Without this the hub only picked the watcher up on its next periodic status frame,
-- so setting it to a new exercise mid-workout took many seconds to appear — during
-- exactly the window where the point of showing it is to confirm, before lifting,
-- that sets are being logged as the right thing.
--
-- Only the watcher itself is published. workset_reports is not: every report already
-- writes a row to `sets`, which is published, so the hub is pushed anyway and adding
-- reports would double every notification for no new information.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'set_watcher'
  ) then
    execute 'alter publication supabase_realtime add table public.set_watcher';
  end if;
end $$;
