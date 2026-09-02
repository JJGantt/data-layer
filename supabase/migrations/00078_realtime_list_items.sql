-- The calendar surfaces (the TV wall and /calendar) are driven by a push off the hub's realtime
-- subscription, so both tables a dated item is assembled from have to be in the publication:
-- list_items for the item itself, lists for the emoji and colour a chip is drawn with.
--
-- Without these the subscription is SILENT — it subscribes cleanly, reports SUBSCRIBED, and never
-- delivers, which looks exactly like a working feature that has nothing to say.
--
-- Clearing an item is a soft delete (deleted=true), so it arrives as an UPDATE; the default replica
-- identity is enough because the surfaces re-read on any event rather than reading the payload.
do $$
declare t text;
begin
  foreach t in array array['list_items','lists'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname='supabase_realtime' and schemaname='public' and tablename=t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
