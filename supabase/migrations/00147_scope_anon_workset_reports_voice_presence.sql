-- Scope the anon key (public: it ships inside the Workset watch app) to what that app does.
--
-- workset_reports: the watch POSTs a report (reps, occurred_at, session, algorithm) with
-- return=representation, then PATCHes corrected_reps or deleted on that report by id. 00045's
-- two-hour-window policies cover exactly that; 00074 added unconditional duplicates on top, and
-- policies OR together, so anon could read every report and UPDATE any column of any row. Setting
-- set_id to an arbitrary sets.id and then deleted = true made the security-definer
-- workset_report_amend() delete that row from the training log (or rewrite its reps). The
-- duplicates go, and column grants pin what anon may write: set_id is only ever written by the
-- workset_report_to_set() trigger.
drop policy if exists "anon reads reports"  on public.workset_reports;
drop policy if exists "anon files reports"  on public.workset_reports;
drop policy if exists "anon amends reports" on public.workset_reports;

revoke insert, update, delete, truncate on public.workset_reports from anon;
grant insert (reps, occurred_at, session, algorithm) on public.workset_reports to anon;
grant update (corrected_reps, deleted) on public.workset_reports to anon;
grant usage on sequence public.workset_reports_id_seq to anon;

-- voice_presence: every reader and writer (jared-voice server, Mac listener and wakefree, pi-audio,
-- the workers, the hub) uses the service key, which bypasses RLS. Nothing reaches it as anon.
drop policy if exists "voice_presence open" on public.voice_presence;
revoke insert, update, delete, truncate on public.voice_presence from anon;
