-- PINS ARE A SET, and the session the surfaces show is DERIVED from them.
--
-- Any number of conversations can be pinned. A pin holds a session at the top of every list — the phone,
-- the walls, the watch and the voice tools' get_sessions all order by the numbers below — most recently
-- pinned first. The SHOWN session (`focus`: the wall's reply column and footer, the watch's default) is the
-- most recently pinned one, else the most recently active running session.
--
-- A pin is on the CONVERSATION (`claude_session_id`, else the row id), not on a row, because every resume
-- and every move between machines makes a new row for the same conversation.
--
-- Follow-ups no longer go to "the focused session": the caller always names the session (data-layer
-- followUp), so nothing here tracks a dispatch that has not opened yet. `focus.pending` stays in the shape,
-- always false, for readers that still look at it.
--
-- `desk_focus` (one pin plus that pending dispatch) is no longer read; 00165 drops it once nothing writes it.

create table if not exists desk_pins (
  conv text primary key,
  pinned_at timestamptz not null default now()
);
alter table desk_pins enable row level security;

-- The single pin there was carries over.
insert into desk_pins (conv)
select coalesce(s.claude_session_id, s.id)
  from desk_focus f join desk_sessions s on s.id = f.session_id
 where f.id = 'current'
on conflict (conv) do nothing;

do $$ begin
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'desk_pins') then
    execute 'alter publication supabase_realtime add table desk_pins';
  end if;
end $$;

-- Returns {numbers: {row id: n}, pins: [row id, ...] (listed rows whose conversation is pinned),
--          focus: {session_id, pinned, pending}}.
create or replace function desk_sessions_state() returns jsonb
language sql stable set search_path = public as $$
with s as (
  select id, status, claude_session_id, last_seen,
         coalesce(claude_session_id, id) as conv,
         coalesce(active_at, reply_at, started) as activity
  from desk_sessions
), listed as (
  -- One row per conversation: the running one if it runs, else the most recently active.
  select distinct on (conv) id, conv, activity, status, last_seen
    from s where status in ('resident', 'evicted')
   order by conv, (status <> 'resident'), activity desc, last_seen desc
), pinned as (
  select l.id, p.pinned_at from listed l join desk_pins p on p.conv = l.conv
), numbered as (
  select l.id, row_number() over (order by p.pinned_at desc nulls last,
                                           l.activity desc, (l.status <> 'resident'), l.last_seen desc) as n
    from listed l left join pinned p on p.id = l.id
), top_pin as (
  select id from pinned order by pinned_at desc limit 1
), auto as (
  select id from s where status = 'resident' order by activity desc, last_seen desc limit 1
)
select jsonb_build_object(
  'numbers', coalesce((select jsonb_object_agg(id, n) from numbered), '{}'::jsonb),
  'pins', coalesce((select jsonb_agg(id order by pinned_at desc) from pinned), '[]'::jsonb),
  'focus', case
    when (select id from top_pin) is not null
      then jsonb_build_object('session_id', (select id from top_pin), 'pinned', true, 'pending', false)
    else jsonb_build_object('session_id', (select id from auto), 'pinned', false, 'pending', false)
  end
);
$$;
