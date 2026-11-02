-- A pending voice_requests row is claimed by the voice worker and run as the owner with every tool, and the
-- anon key is public (it ships inside the Workset and restaurant menu apps). Every legitimate writer —
-- the jared-voice server, the hub, the Mac listener, the voice-fallback edge function — uses the
-- service key, which bypasses RLS, so anon gets nothing on this table.
drop policy if exists voice_requests_anon_insert on public.voice_requests;
revoke insert, update, delete on public.voice_requests from anon;
