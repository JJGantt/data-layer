-- Voice inject mode: when on, the always-listening Mac-mic speaker-ID engine (wakefree.py) injects each
-- confirmed command into the focused Mac window + Enter (hands-free dictation / conversation), instead of
-- routing it through the hub. Mac-only; the Fly server gates the ESP mic off while it's on. Replaces the
-- old Cmd+Opt+C hands-free conversation mode entirely.
insert into app_settings (key, value) values
  ('voice_inject_mode', '0')
on conflict (key) do nothing;
