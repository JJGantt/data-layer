-- Workers a voice request has already failed on. A worker whose turn fails before any tool ran puts
-- the request back to 'pending' with its own id added here, and no worker listed claims it again, so
-- a fault on one machine (a broken CLI install, a revoked login) hands the command to the next one
-- instead of ending it. See voice-pipeline worker/README.md § Handing a failed turn on.
alter table voice_requests add column if not exists failed_on text[] not null default '{}';
