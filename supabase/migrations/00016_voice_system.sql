-- Voice → Claude → Pi-wall system (see status-hub/IDEAS.md "★ Voice → Claude → Pi-wall system").
-- Queue + presence + focus + a conversation stream for the /tv display.

create table if not exists voice_requests (
  id uuid primary key default gen_random_uuid(),
  transcript text not null,
  source text default 'fly',              -- 'mac' | 'fly' (where STT happened)
  status text not null default 'pending', -- pending | claimed | done | error
  assigned_to text,                       -- 'mac' | 'fly' | 'pi' (chosen at enqueue from presence)
  claimed_by text,
  claimed_at timestamptz,
  focus text default 'hub',               -- 'hub' or a Mac session id (target when enqueued)
  result text,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists voice_requests_status_idx on voice_requests(status, created_at);
create index if not exists voice_requests_assigned_idx on voice_requests(assigned_to, status);

create table if not exists voice_messages (
  id uuid primary key default gen_random_uuid(),
  request_id uuid,
  focus text not null default 'hub',      -- which conversation this belongs to (for /tv)
  role text not null,                     -- user | assistant | tool | system
  text text not null default '',
  done boolean not null default true,     -- false while a streaming assistant turn is in progress
  created_at timestamptz not null default now()
);
create index if not exists voice_messages_focus_idx on voice_messages(focus, created_at);

create table if not exists worker_presence (
  worker text primary key,                -- 'mac' | 'fly' | 'pi'
  last_seen timestamptz not null default now(),
  info jsonb
);

create table if not exists voice_focus (
  id int primary key default 1,
  focus text not null default 'hub',      -- 'hub' or a Mac session id
  label text,                             -- display label (session aiTitle) when focused on a session
  updated_by text,
  updated_at timestamptz not null default now(),
  constraint voice_focus_singleton check (id = 1)
);
insert into voice_focus (id, focus) values (1, 'hub') on conflict (id) do nothing;

-- RLS. The PUBLIC transcriber (jared-voice) uses the ANON key and may ONLY insert requests —
-- least privilege so a container breach can't read/delete data. Workers use the service_role
-- key (bypasses RLS) for claim/update/read and for every other table.
alter table voice_requests enable row level security;
drop policy if exists voice_requests_anon_insert on voice_requests;
create policy voice_requests_anon_insert on voice_requests for insert to anon with check (true);

alter table voice_messages  enable row level security;  -- service_role only (no anon policy)
alter table worker_presence enable row level security;  -- service_role only
alter table voice_focus     enable row level security;  -- service_role only

-- Realtime for the /tv panel (server subscribes with the service key, relays via SSE).
do $$ begin
  alter publication supabase_realtime add table voice_messages;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table voice_focus;
exception when duplicate_object then null; end $$;
