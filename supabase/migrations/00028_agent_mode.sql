-- Full-agent mode for the subscription/power voice route, plus an editable session-reset timeout.
--   agent_mode      '0'/'1' — when on, the subscription path (power, custom-local; Mac+Pi only) runs as
--                   the unrestricted Claude Code agent (all native tools + MCP tools, no hub framing).
--   agent_cwd       working directory that agent runs in; '' = the worker's default ($HOME).
--   session_reset_s idle seconds before the hub conversation resets (already read by the worker; now
--                   surfaced in Settings). Full-agent mode ignores this and resets manually only.
insert into app_settings (key, value) values
  ('agent_mode', '0'),
  ('agent_cwd', ''),
  ('session_reset_s', '300')
on conflict (key) do nothing;
