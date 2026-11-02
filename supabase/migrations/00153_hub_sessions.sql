-- The hub's login sessions: one row per signed-in browser, so a cookie can be revoked (one device, or
-- all of them) without changing HUB_PASSWORD. The cookie carries `s.<id>.<secret>`; only the secret's
-- SHA-256 is stored, so a read of this table cannot sign anyone in. status-hub `lib/auth.js` mints a
-- row at /login (and when it upgrades a browser still holding the old password-derived cookie) and
-- sets revoked_at to end one.
--
-- RLS on with NO policies: only the service role reads or writes it. In the realtime publication so a
-- revocation made directly in SQL reaches the running hub, which holds the rows in memory.
create table if not exists hub_sessions (
  id            uuid primary key,
  secret_sha256 text not null,
  created_at    timestamptz not null default now(),
  via           text not null,
  user_agent    text,
  ip            text,
  revoked_at    timestamptz
);
alter table hub_sessions enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname='supabase_realtime' and schemaname='public' and tablename='hub_sessions'
  ) then
    alter publication supabase_realtime add table public.hub_sessions;
  end if;
end $$;
