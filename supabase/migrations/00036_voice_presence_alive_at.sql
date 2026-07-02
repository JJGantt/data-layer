-- Mic liveness beacon: each capture process stamps alive_at every ~30s WHILE audio frames are
-- actually flowing (not merely while the process exists). A stale alive_at therefore means the mic
-- is genuinely down — hung stream, dead process, disconnected device — which is the exact failure
-- that went unnoticed for six days on the Mac. Distinct from updated_at/heard_*_at, which stamp
-- speech events.
alter table voice_presence add column if not exists alive_at timestamptz;
