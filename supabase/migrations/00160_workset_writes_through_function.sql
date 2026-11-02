-- The Watchset watch app holds no Supabase key: every read and write it makes goes through the
-- `workset` edge function (supabase/functions/workset), which checks the device's own token and acts
-- with the service role. So no client key reaches anything Workset uses. The publishable key that
-- once shipped in the app's public source is anon, and anon may no longer file a report (which the
-- workset_report_to_set() trigger turns into a logged set), amend one, read the armed watcher, or
-- store a capture.
drop policy if exists workset_reports_insert_anon on public.workset_reports;
drop policy if exists workset_reports_select_anon on public.workset_reports;
drop policy if exists workset_reports_update_anon on public.workset_reports;
revoke all on public.workset_reports from anon, authenticated;
revoke all on sequence public.workset_reports_id_seq from anon, authenticated;

revoke execute on function public.workset_watcher() from anon, authenticated;

drop policy if exists workset_captures_insert_anon on storage.objects;
