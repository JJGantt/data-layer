-- The single pin slot, replaced by desk_pins (00164). Nothing reads or writes it.
do $$ begin
  if exists (select 1 from pg_publication_tables
              where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'desk_focus') then
    execute 'alter publication supabase_realtime drop table desk_focus';
  end if;
end $$;
drop table if exists desk_focus;
