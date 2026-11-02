-- Scope the anon key (public: it ships inside the Workset watch app) on set_watcher and the
-- workset-captures bucket to exactly what that app does.
--
-- set_watcher: the watch only needs to know what it is armed to, so its badge can say whether a
-- counted set will be logged. Every other reader (the hub, the data MCP) uses the service key. Anon
-- has no access to the table, whose row keeps the last armed exercise, weight and arming times even
-- when nothing is armed; it calls workset_watcher() instead: one row, the exercise and weight while
-- set_watcher_is_armed() holds, nulls otherwise. Security definer because anon has no table access
-- to invoke it with; it reads one fixed row and takes no arguments.
drop policy if exists "anon reads watcher"      on public.set_watcher;
drop policy if exists set_watcher_select_anon   on public.set_watcher;
revoke all on public.set_watcher from anon;

create or replace function public.workset_watcher()
returns table (exercise text, weight_lbs real)
language sql stable security definer set search_path = '' as $$
    select case when public.set_watcher_is_armed() then w.exercise end,
           case when public.set_watcher_is_armed() then w.weight_lbs end
      from public.set_watcher w
     where w.id = 1
$$;

revoke all on function public.workset_watcher() from public;
grant execute on function public.workset_watcher() to anon, authenticated, service_role;

-- workset-captures: CaptureUploader POSTs `text/csv` to workset/sensor_capture/<session>/motion.csv.
-- A recording is about 16.5 KB per second of 100 Hz motion; the longest a counted set can save is
-- about 250 s (4 MB), and the largest stored so far is 1.3 MB. 20 MB is about twenty minutes of
-- recording, which leaves record-without-counting mode room while refusing anything that is not a
-- recording.
update storage.buckets
   set file_size_limit = 20 * 1024 * 1024,
       allowed_mime_types = array['text/csv']
 where id = 'workset-captures';

drop policy if exists workset_captures_insert_anon on storage.objects;
create policy workset_captures_insert_anon
    on storage.objects for insert
    to anon
    with check (bucket_id = 'workset-captures'
                and name like 'workset/sensor_capture/%/motion.csv');
