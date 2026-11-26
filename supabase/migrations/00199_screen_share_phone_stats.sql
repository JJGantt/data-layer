-- The phone's receiving counters for a screen share (frame rate, jitter buffer, decode), written by the
-- hub, beside the Mac's sending ones in `stats`, which the screen agent writes: two writers, two columns.
alter table public.screen_shares add column if not exists phone_stats jsonb;
