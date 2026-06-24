-- Custom voice route. When chatbox_route or wakefree_route = 'custom', the worker reads these knobs
-- instead of the fixed Efficiency (Haiku/API) / Accuracy (Opus/subscription) presets:
--   custom_model  : haiku | sonnet | opus
--   custom_think  : none | low | high   (extended-thinking effort; 'high' adds ultrathink)
--   custom_runner : local (free subscription, Mac/Pi) | api (Anthropic API)
-- 'local' always falls back to the API when no local worker is available.
insert into app_settings (key, value) values
  ('custom_model', 'sonnet'),
  ('custom_think', 'low'),
  ('custom_runner', 'local')
on conflict (key) do nothing;
