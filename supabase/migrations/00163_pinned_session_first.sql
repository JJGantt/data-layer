-- A PINNED session is number 1. Every surface that lists sessions (the phone, the walls, the watch, the
-- voice tools' get_sessions) orders by this number, so the pin puts it at the top of all of them at once,
-- and "session one" names the row the user sees first. Below it, the order is unchanged: most recently
-- active first. Otherwise as 00157.

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
), pinned_conv as (
  select coalesce(claude_session_id, id) as conv from s where id = (select id from pin_hit)
), numbered as (
  select id, row_number() over (order by (conv is not distinct from (select conv from pinned_conv)) desc,
                                         activity desc, (status <> 'resident'), last_seen desc) as n from listed
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
