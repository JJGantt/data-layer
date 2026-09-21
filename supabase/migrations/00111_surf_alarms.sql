-- A SURF ALARM: conditions on the forecast for one morning, which the hub turns into an alarm.
--
-- `rules` is an ORDERED list of {hours, wake}. A rule matches when EVERY hour it lists is rated Fair
-- or better on `day`; hours it does not list are unconstrained. The first matching rule decides the
-- wake time, and no match means no alarm. An empty `hours` matches unconditionally, which is how
-- "otherwise wake me at 8:30" is said, and it only makes sense last.
--
--   [{"hours":[7,8],"wake":"06:00"}, {"hours":[8,9],"wake":"07:00"}]
--
-- `outputs` names what a decision DRIVES, each one an entry in the hub's output registry
-- (server/lib/surfalarm.js). `item` is an alarm-marked list item, which is what the page clock,
-- AlarmKit and the due notification all ring from. `state` is each output's own bookkeeping, keyed by
-- output name (`{"item": {"id": …}}`), written only by the hub.
--
-- The hub already hears every new surf_snapshots row over realtime, so it re-decides on each one and
-- on any change here. `decided` is the last decision, for reading back what it did and why.
create table if not exists public.surf_alarms (
  day      date primary key,
  rules    jsonb not null,
  outputs  text[] not null default '{item}',
  engaged  boolean not null default true,
  state    jsonb not null default '{}',
  decided  jsonb,
  created  timestamp not null default (now() at time zone 'America/New_York'),
  updated  timestamp not null default (now() at time zone 'America/New_York')
);

alter table public.surf_alarms enable row level security;

-- The hub re-decides the moment a rule is set or changed, not on its next backstop.
alter publication supabase_realtime add table public.surf_alarms;
