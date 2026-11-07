-- A feed is claimed before it is dispensed, so the Mac's fallback collector and the Pi's can both
-- subscribe and only one of them feeds: the first to set claimed_by on a pending row acts. petlibro-mcp
-- collector.py claims.
alter table public.feeder_commands add column if not exists claimed_by text;
