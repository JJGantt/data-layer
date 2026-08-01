-- Add transcribed_at to voice_requests: the instant STT finishes and the jared-voice server flips
-- the row transcribing→pending. Lets us split the created_at→claimed_at latency into STT time
-- (created_at→transcribed_at) vs worker pickup lag (transcribed_at→claimed_at). Nullable; only rows
-- created after this ships are stamped.
alter table public.voice_requests add column if not exists transcribed_at timestamptz;
