-- Auto-discovered Govee light inventory (refreshed from the Govee cloud API every ~30 min by the
-- always-on jared-voice machine). Read by the Govee MCP (controllable lights) and the worker's
-- system-prompt context, on both Mac and Fly. `key` is the tool identifier; `hidden` excludes a
-- light from voice control without deleting it.
create table if not exists govee_devices (
  key text primary key,
  device_id text not null,
  sku text not null,
  display_name text not null,
  hidden boolean not null default false,
  updated_at timestamptz not null default now()
);

-- Service-role only (the workers use the service key, which bypasses RLS).
alter table govee_devices enable row level security;
