-- app_settings.updated_at was `default now()`, and a DEFAULT only fires on INSERT. Writers that upsert
-- with `Prefer: resolution=merge-duplicates` hit the UPDATE path, so the column froze at whatever the
-- last writer that set it explicitly had stamped. The hub settings endpoint sends updated_at; mcp-voice
-- (set_inject_mode / set_always_on / set_model / ...) sends only {key, value}. Result: a key toggled via
-- the MCP kept a stale timestamp, and "when did this last change?" was unanswerable — voice_inject_mode
-- read as untouched since 2026-07-02 while it was in fact flipped minutes earlier.
--
-- Stamp it in the database instead, so every writer is honest no matter what it sends.

create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists app_settings_set_updated_at on app_settings;

create trigger app_settings_set_updated_at
  before update on app_settings
  for each row
  execute function set_updated_at();
