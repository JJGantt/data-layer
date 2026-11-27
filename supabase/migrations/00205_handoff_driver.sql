-- A handoff a session drives itself (drive_screen) rather than one handed to Jared (request_handoff).
-- driver = 'session': its end is not reported back to the session as if he had finished it. idle_s: seconds since the Mac last had input from him, read when the screen was opened.
alter table handoffs add column if not exists driver text;
alter table handoffs add column if not exists idle_s integer;
