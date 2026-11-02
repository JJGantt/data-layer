-- lease_until: when a claimed voice request lapses unless the turn holding it renews it. The worker sets
-- it at claim and extends it from the turn's own progress (each run attempt, by that attempt's deadline,
-- and each tool call). A claim whose lease has passed is taken back by another worker even while its
-- owner's heartbeat is fresh, which is what a process hung mid-turn looks like. Null on rows claimed
-- without one: those are judged by heartbeat and claim_epoch alone.
alter table public.voice_requests add column if not exists lease_until timestamptz;

-- voice_finish: a turn's write-back (its thread rows and the request's final state) in one transaction,
-- and only while the caller still holds the claim (status claimed, by this worker and process). False
-- means the claim was taken back and nothing was written, so a worker that lost its claim can never post
-- a reply over, or beside, the worker that took the request over.
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
         lease_until = null,
         updated_at = now()
   where id = p_id;
  return true;
end;
$$;

revoke all on function public.voice_finish(uuid, text, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.voice_finish(uuid, text, text, jsonb, jsonb) to service_role;
