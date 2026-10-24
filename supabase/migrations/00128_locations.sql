-- WHERE JARED LAST WAS, one row per device that reports a position. The hub upserts it from the fix a
-- device sends with a command (status-hub server.js `noteLocation`): the watch, or the phone/browser
-- page. A model reads it on demand through the data MCP's `get_location` rather than having it pasted
-- into every prompt, so a request that does not need it never sees it.
--
-- It moves only when he talks to a device that has a fix, so `at` is the age of the answer — the
-- reader has to show it.
--
-- RLS on with NO policies: a position is the service role's business only.
create table if not exists locations (
  device     text primary key,          -- 'watch' or 'web'
  lat        double precision not null,
  lon        double precision not null,
  acc        integer,                   -- metres, as the device reported its accuracy
  place      text,                      -- a name only when the device produced one itself
  at         timestamptz not null default now()
);
alter table locations enable row level security;
