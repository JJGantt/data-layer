-- When the session's last reply was READ.
--
-- A session's `reply_at` is when its final answer landed. This is when that answer was opened, so a
-- surface can mark the ones still owed attention: unread means `reply_at` is set and is newer than
-- this. On the session row itself rather than per device, because the phone, the wall and the Mac are
-- all looking at one list and one of them reading an answer means it has been read.
--
-- Null means never opened, which for a session that has replied is unread — the right answer for one
-- that finished while nobody was looking.
alter table desk_sessions add column if not exists seen_at timestamptz;
