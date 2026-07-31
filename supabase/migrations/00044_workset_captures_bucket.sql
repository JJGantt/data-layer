-- Raw motion recordings from the Watchset watch app.
--
-- Every set the app recognises is uploaded as a CSV, so a miscount in the gym
-- becomes a recording that can be replayed against the algorithm the same day.
-- Without this a wrong count teaches nothing.
--
-- The layout deliberately mirrors the GolfTracker swing-motion bucket
-- (<root>/sensor_capture/<session>/<file>) so the existing puller at
-- ~/workspace/rep-counting/pull_captures.py reads it without modification.

insert into storage.buckets (id, name, public)
values ('workset-captures', 'workset-captures', false)
on conflict (id) do nothing;

-- The watch ships a publishable key, so it acts as anon. It may CREATE recordings
-- and nothing else: no read, no overwrite, no delete. A key extracted from the app
-- can therefore add junk, but it cannot read what was already recorded or destroy
-- it. Reading is service-role only, which is how the puller runs.
drop policy if exists workset_captures_insert_anon on storage.objects;
create policy workset_captures_insert_anon
    on storage.objects for insert
    to anon
    with check (bucket_id = 'workset-captures');
