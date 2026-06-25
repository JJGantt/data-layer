-- Speak replies aloud: an independent switch for whether the assistant's final reply is read aloud by
-- TTS, decoupled from voice inject mode. Inject mode injects the transcript into the focused window; this
-- toggle alone controls speech. Default off — replies are silent unless explicitly turned on. The Mac
-- listener mirrors this to the ~/.hammerspoon/voice-speak flag that the voice_speak.py hook gates on.
insert into app_settings (key, value) values
  ('voice_speak_replies', '0')
on conflict (key) do nothing;
