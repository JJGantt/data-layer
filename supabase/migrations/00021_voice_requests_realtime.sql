-- Publish voice_requests on the realtime channel so the voice worker can claim a
-- command the instant it is INSERTed (event-driven) instead of polling once a second.
-- voice_messages was already in the publication; this closes the gap for the request queue.
-- Idempotent: skip if the table is already a member (re-running ADD would error).
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'voice_requests'
  ) then
    execute 'alter publication supabase_realtime add table public.voice_requests';
  end if;
end $$;
