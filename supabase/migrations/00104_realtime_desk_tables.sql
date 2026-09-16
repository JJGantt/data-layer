-- The session surfaces (the home wall's session panel, the sessions wall, the phone's repos pane) were
-- driven by a 5s fetch of /api/sessions — ~76k Supabase reads a day to observe a list that changed
-- about six times. Nothing could push them instead, because none of the tables a session view is
-- assembled from was in the publication: desk_sessions for the session itself, desk_queue for work
-- waiting behind it, desk_focus for which one a spoken follow-up lands in.
--
-- `reports` joins them for the same reason: reportTick polls it every 20s — the fastest database timer
-- in the hub — purely to notice a row it could be told about.
--
-- Without these the subscription is SILENT: it subscribes cleanly, reports SUBSCRIBED, and never
-- delivers, which looks exactly like a working feature that has nothing to say.
--
-- Ordering note, if this is ever rebuilt from scratch: BOTH session trackers must be change-gated
-- before this runs (voice-pipeline commit 9cb0a0f). Until they were, each tracker rewrote every
-- resident row every 30s whether or not anything had moved, and each of those writes becomes a
-- broadcast to every open screen the moment this publication includes the table — turning a read
-- storm into a push storm rather than removing it.
--
-- The default replica identity is enough: every surface re-reads on an event rather than reading the
-- payload, so the old row is never needed.
do $$
declare t text;
begin
  foreach t in array array['desk_sessions','desk_queue','desk_focus','reports'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname='supabase_realtime' and schemaname='public' and tablename=t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
