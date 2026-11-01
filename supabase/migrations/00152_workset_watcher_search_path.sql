-- 00151's workset_watcher() ran with an empty search_path, and set_watcher_is_armed() names its
-- table unqualified, so every call failed with "relation set_watcher does not exist". Resolve
-- through public, the same as the other security-definer functions on this table.
create or replace function public.workset_watcher()
returns table (exercise text, weight_lbs real)
language sql stable security definer set search_path = public, pg_temp as $$
    select case when public.set_watcher_is_armed() then w.exercise end,
           case when public.set_watcher_is_armed() then w.weight_lbs end
      from public.set_watcher w
     where w.id = 1
$$;
