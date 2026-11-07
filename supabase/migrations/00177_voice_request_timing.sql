-- timing: where a voice command's time went, stage by stage, kept on the request row so a slow turn can be
-- traced from the database alone (process logs on Fly hold minutes). Each writer adds its own keys:
-- the hub (audio received, transcription, enqueue), the worker (run start, first model output, finish,
-- token and cache counts), the watch via the hub (answer received, answer on screen). Times are ISO
-- strings, durations are *_ms. status-hub docs/HUB-INTERNALS.md § Command timing lists the keys.
alter table public.voice_requests add column if not exists timing jsonb;

-- Merges keys into a request's timing without reading it first: several writers stamp the same row
-- at different moments, and a read-modify-write would drop whichever landed in between.
create or replace function public.voice_timing(p_id uuid, p_timing jsonb)
returns void
language sql
set search_path = public
as $$
  update voice_requests set timing = coalesce(timing, '{}'::jsonb) || p_timing where id = p_id;
$$;

revoke all on function public.voice_timing(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.voice_timing(uuid, jsonb) to service_role;

-- voice_finish also merges `p_fields.timing`, so the worker's stamps land in the same transaction as its
-- outcome. Otherwise unchanged from 00159.
create or replace function public.voice_finish(p_id uuid, p_worker text, p_epoch text, p_fields jsonb,
                                               p_messages jsonb default '[]'::jsonb)
returns boolean
language plpgsql
set search_path = public
as $$
begin
  perform 1 from voice_requests
   where id = p_id and status = 'claimed' and claimed_by = p_worker and claim_epoch is not distinct from p_epoch
   for update;
  if not found then
    return false;
  end if;

  insert into voice_messages (request_id, focus, mode, role, text, done, ignored, worker, needs_read, engine,
                              attachments, created_at)
  select p_id, coalesce(m->>'focus', 'hub'), m->>'mode', m->>'role', coalesce(m->>'text', ''),
         coalesce((m->>'done')::boolean, true), coalesce((m->>'ignored')::boolean, false), m->>'worker',
         coalesce((m->>'needs_read')::boolean, false), m->>'engine', m->'attachments', clock_timestamp()
    from jsonb_array_elements(p_messages) with ordinality as t(m, n)
   order by n;

  update voice_requests
     set status = p_fields->>'status',
         result = coalesce(p_fields->>'result', result),
         error = coalesce(p_fields->>'error', error),
         timing = case when p_fields ? 'timing' then coalesce(timing, '{}'::jsonb) || (p_fields->'timing') else timing end,
         lease_until = null,
         updated_at = now()
   where id = p_id;
  return true;
end;
$$;
