-- A second speech-to-text reading of the same clip, from a different Whisper model, kept only when its
-- words differ from `transcript`. The worker hands both to the model so a word one transcriber misheard
-- ("pair putt" for "haircut") can be recovered from the other instead of being saved as said.
alter table voice_requests add column if not exists alt_transcript text;
