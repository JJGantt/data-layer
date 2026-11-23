-- Where untracked things are kept (data-layer src/itemLocations.ts): one row per item, holding its
-- current location as free text — 'far left kitchen drawer', or coordinates written as text.
-- `key` makes 'Passport' and 'passport ' the same item, so updating one never forks a second row.
create table if not exists item_locations (
  key        text generated always as (lower(btrim(item))) stored primary key,
  item       text not null check (btrim(item) <> ''),
  location   text not null check (btrim(location) <> ''),
  updated_at timestamp not null            -- naive local wall clock, helpers.now()
);
alter table item_locations enable row level security;
