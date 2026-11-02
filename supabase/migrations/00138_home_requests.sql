-- HOME REQUESTS — reads that only the Pi can answer, because what they need is on the home network
-- or in the Pi's signed-in automation browser (data-layer src/homeRequests.ts). Today: the owner's own
-- YouTube account (youtubeAccount.ts). A caller anywhere (Fly, the Mac) inserts a row; data-http on
-- the Pi, subscribed to inserts, answers by filling `result` and `done_at`; the caller is subscribed
-- to that update. Same shape as tv_commands, so nothing polls. Rows are kept; each is small text.
create table if not exists home_requests (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  args jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  done_at timestamptz,
  result jsonb
);
create index if not exists home_requests_created on home_requests (created_at desc);
alter table home_requests enable row level security;
alter publication supabase_realtime add table public.home_requests;
