-- The restaurant app has one backend (the Anthropic API) since its route through the Mac
-- was removed, so app_config no longer gates backends.
alter table public.app_config drop column if exists allowed_backends;
alter table public.app_config drop column if exists default_backend;
