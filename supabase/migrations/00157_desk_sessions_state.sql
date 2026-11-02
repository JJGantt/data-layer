-- How sessions are NUMBERED and which one is FOCUSED: one definition, read by data-layer (the voice
-- tools: "session three", follow_up) and the hub (/api/sessions, the status strip). They each
-- implemented it, kept equal by comments; two answers is "session three" meaning one thing on the
-- wall and another to the voice tools, or a follow-up landing somewhere the wall does not show.
--
-- NUMBERING: one row per conversation (`claude_session_id`, else the row id) among running and parked
-- rows; the row kept is the running one if it runs, else the most recently active. Numbered from 1,
-- most recently active first (`active_at`, else `reply_at`, else `started`), running and parked
-- together: parking is not activity.
--
-- FOCUS, in order:
--   1. a pin (`desk_focus.session_id`): the running row of that conversation, else the pinned row
--      itself while it still exists (parked, and still his) — `pinned`;
--   2. a dispatch whose session has not opened yet (`desk_focus.command_id`, its command still pending
--      or running, no row carrying it) — `pending`, no session;
--   3. otherwise the most recently active running session.
--
-- Returns {numbers: {row id: n}, focus: {session_id, pinned, pending}}.

create or replace function desk_sessions_state() returns jsonb
language sql stable set search_path = public as $$
with s as (
  select id, status, claude_session_id, command_id, last_seen,
         coalesce(claude_session_id, id) as conv,
         coalesce(active_at, reply_at, started) as activity
  from desk_sessions
), listed as (
  select distinct on (conv) id, conv, activity, status, last_seen
    from s where status in ('resident', 'evicted')
   order by conv, (status <> 'resident'), activity desc, last_seen desc
), numbered as (
  select id, row_number() over (order by activity desc, (status <> 'resident'), last_seen desc) as n from listed
), f as (
  select session_id, command_id from desk_focus where id = 'current'
), pinned_row as (
  select s.* from s join f on s.id = f.session_id
), pin_hit as (
  select coalesce(
    (select r.id from s r join f on r.id = f.session_id where r.status = 'resident'),
    (select r.id from s r join pinned_row p on r.claude_session_id = p.claude_session_id
      where r.status = 'resident' order by r.last_seen desc limit 1),
    (select id from pinned_row)) as id
), pending as (
  select exists (
    select 1 from f join desk_commands c on c.id::text = f.command_id
     where f.command_id is not null
       and c.status in ('pending', 'running')
       and not exists (select 1 from s where s.command_id = f.command_id)) as yes
), auto as (
  select id from s where status = 'resident' order by activity desc, last_seen desc limit 1
)
select jsonb_build_object(
  'numbers', coalesce((select jsonb_object_agg(id, n) from numbered), '{}'::jsonb),
  'focus', case
    when (select id from pin_hit) is not null
      then jsonb_build_object('session_id', (select id from pin_hit), 'pinned', true, 'pending', false)
    when (select yes from pending)
      then jsonb_build_object('session_id', null, 'pinned', false, 'pending', true)
    else jsonb_build_object('session_id', (select id from auto), 'pinned', false, 'pending', false)
  end
);
$$;
