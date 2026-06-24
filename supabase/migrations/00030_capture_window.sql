-- Dedup by the actual RECORDING WINDOW, not enqueue time. Each capture path stamps the wall-clock span
-- of the audio it recorded; the worker collapses requests whose windows overlap (same utterance heard by
-- two mics) and lets genuinely distinct (sequential, non-overlapping) commands both run — replacing the
-- blind 10s created_at fudge.
alter table voice_requests
  add column if not exists capture_start timestamptz,
  add column if not exists capture_end   timestamptz;
