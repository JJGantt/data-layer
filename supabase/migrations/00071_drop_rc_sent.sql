-- Remote Control is a SETTING, not something to type into a running session.
--
-- `remoteControlAtStartup` in ~/.claude/settings.json turns it on for every session started on that
-- machine, including the ones opened by hand — so there is nothing to track, and nothing to
-- inject. The column added an hour earlier recorded whether we had typed `/remote-control` into a
-- session, which is exactly the janky mechanism the setting replaces.
alter table desk_sessions drop column if exists rc_sent;
