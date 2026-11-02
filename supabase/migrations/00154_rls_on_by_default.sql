-- Every table created in public gets row level security turned on as it is created.
--
-- Supabase creates a table with RLS OFF, and the publishable keys that ship inside the apps act as
-- anon, so a table someone forgot to lock is readable and writable by anyone holding one. RLS on with
-- no policy is the right default here (service_role bypasses it), so it is applied by the database
-- rather than remembered by whoever writes the migration. A table a client genuinely reaches still
-- needs its policies written; this only removes the open-by-default state.

create or replace function public.enable_rls_on_new_table()
returns event_trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  obj record;
begin
  for obj in
    select * from pg_event_trigger_ddl_commands()
    where command_tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      and object_type = 'table'
      and schema_name = 'public'
  loop
    execute format('alter table %s enable row level security', obj.object_identity);
  end loop;
end;
$$;

revoke all on function public.enable_rls_on_new_table() from public, anon, authenticated;

drop event trigger if exists enable_rls_on_new_table;
create event trigger enable_rls_on_new_table
  on ddl_command_end
  when tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
  execute function public.enable_rls_on_new_table();
