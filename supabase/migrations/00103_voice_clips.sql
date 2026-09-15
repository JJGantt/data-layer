-- The recording behind each phone voice command (sources 'web' and 'web-quick'), kept so a bad
-- transcription can be listened to instead of guessed at. The hub uploads it after enqueueing the
-- request and records where it went in voice_requests.audio; pi-desk's sweepRetention deletes clips on
-- the same schedule as the requests (KEEP_REQUEST_DAYS). Service-role only, so no policies.
insert into storage.buckets (id, name, public)
values ('voice-clips', 'voice-clips', false)
on conflict (id) do nothing;

-- {path, bytes, type, dur}: the object name in voice-clips, its size, the recorder's content type, and
-- the recording's length in seconds as the phone measured it.
alter table public.voice_requests add column if not exists audio jsonb;
