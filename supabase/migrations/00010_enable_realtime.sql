-- Enable Supabase Realtime (push) on the tables the status hub watches.
do $$
declare t text;
begin
  foreach t in array array['device_status','nutrition_entries','workout_sessions','exercises'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname='supabase_realtime' and schemaname='public' and tablename=t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
