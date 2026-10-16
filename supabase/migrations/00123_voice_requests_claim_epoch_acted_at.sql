-- claim_epoch: the id of the worker PROCESS that claimed the row (a random id per start, also in its
-- worker_presence.info). A worker restarted mid-run comes back under the same name with a fresh
-- heartbeat, so a claim can only be recognised as orphaned by its process, not its host.
-- acted_at: when the turn first called a tool that changes something. An orphaned or failed request
-- without it is safe to run again on another worker; one with it may be half-done and is not replayed.
alter table voice_requests add column if not exists claim_epoch text;
alter table voice_requests add column if not exists acted_at timestamptz;
