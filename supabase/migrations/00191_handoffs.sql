-- HANDOFFS: a session stuck on something only Jared can do (a sign-in, a captcha, a choice) hands him a
-- screenshot of the screen it is stuck on; he taps on it, or types, from the phone or the watch, and the
-- tap is clicked on that screen. data-layer src/handoff.ts opens one (the request_handoff tool);
-- src/handoffAgent.ts on the machine that owns the screen captures it and carries out each action;
-- status-hub routes/handoffs.js is what the phone and watch talk to.
--
-- `handoffs` is the screen: which one (`target`), its newest screenshot (`image`, a name in the
-- shared-images bucket, `seq` counting them) and where it stands (`status`).
create table if not exists public.handoffs (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  session     text,                       -- desk_sessions.id of the session that asked (HUB_SESSION_ID)
  target      text not null check (target in ('mac-screen', 'mac-chrome', 'pi-browser')),
  note        text,                       -- what the session needs done, in its words
  status      text not null default 'new' check (status in ('new', 'open', 'done', 'cancelled', 'failed')),
  image       text,
  seq         integer not null default 0,
  width       integer,                    -- the screenshot's pixel size
  height      integer,
  taps        integer not null default 0, -- how many actions he sent, for the session's summary
  typed       integer not null default 0, -- how many times he typed (never what)
  error       text,
  claimed_by  text
);

-- One row per thing he did. `text` is what he typed: the agent types it and then clears it, so it is
-- never kept and never reaches the session. x and y are fractions (0-1) of the screenshot `seq` showed.
create table if not exists public.handoff_actions (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  handoff     uuid not null references public.handoffs(id) on delete cascade,
  target      text not null,
  kind        text not null check (kind in ('tap', 'text', 'key', 'refresh', 'done', 'cancel')),
  x           double precision,
  y           double precision,
  text        text,
  key         text check (key in ('enter', 'tab', 'backspace', 'escape')),
  seq         integer,
  done_at     timestamptz,
  error       text,
  claimed_by  text
);
create index if not exists handoff_actions_handoff on public.handoff_actions (handoff);

alter table public.handoffs enable row level security;
alter table public.handoff_actions enable row level security;

do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'handoffs') then
    execute 'alter publication supabase_realtime add table public.handoffs';
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'handoff_actions') then
    execute 'alter publication supabase_realtime add table public.handoff_actions';
  end if;
end $$;
