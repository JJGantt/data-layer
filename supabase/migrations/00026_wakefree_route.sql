-- Wake-free voice route. The wake-WORD path picks the route per-utterance from which wake word fired
-- ('Hey Rhasspy' → fast/Haiku, 'Hey Jarvis' → power/Opus), but wake-free has no wake word to
-- disambiguate, so it runs on ONE configurable route set here in the hub. Read by the Mac wake-free
-- loop (wakefree.py, live per command) and the ESP wake-free path (Fly server, bridged live by the Mac
-- listener via /wakefree-route). 'fast' = Efficiency (Haiku + 1h cache), 'power' = Accuracy (Opus).
insert into app_settings (key, value) values
  ('wakefree_route', 'fast')
on conflict (key) do nothing;
