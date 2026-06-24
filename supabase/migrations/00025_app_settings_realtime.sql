-- Publish app_settings on realtime so Mac-side processes (the voice listener) react the instant a
-- setting changes in the hub UI — e.g. the wake-free on/off toggle (wakefree_enabled) flips the
-- listener between wake-word capture and the wake-free speaker-ID loop, event-driven, no polling.
-- Idempotent: skip if already a member.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'app_settings'
  ) then
    execute 'alter publication supabase_realtime add table public.app_settings';
  end if;
end $$;
