-- Global key/value app settings (read by the worker + Fly server, written by the hub settings UI).
-- Holds the voice routing mode (sdk | subscription) and per-device trailing-silence seconds, etc.
create table if not exists app_settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

-- Service-role only (worker + hub server use the service key, which bypasses RLS). No anon access.
alter table app_settings enable row level security;

-- Seed defaults. routing_mode: 'subscription' = Mac/Pi run claude -p on the subscription (free, cold
-- start); 'sdk' = warm Agent SDK everywhere (uses the SDK credit, lower latency). Fly is always SDK.
insert into app_settings (key, value) values
  ('routing_mode', 'subscription')
on conflict (key) do nothing;
