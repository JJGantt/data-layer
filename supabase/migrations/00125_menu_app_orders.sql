-- THE RESTAURANT APP'S ORDER LIST: what guests ordered, heard by the watch and pulled out by the
-- model, one row per item, each under its menu name.
--
-- RLS on with NO anon policy, unlike the app's other tables (00116): the app ships to TestFlight
-- testers, and every tester's anon key would otherwise read and write one shared list. The watch
-- reaches it only through the hub's owner-gated /api/cg/orders, which uses the service key.
--
-- Text only, by design: no audio is kept anywhere. `heard` is the transcript the items came from.

create table public.cg_orders (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  kind        text not null check (kind in ('dish', 'wine', 'liquor', 'cocktail', 'other')),
  item_id     text,             -- the menu id (bottles.id, a dish or cocktail name); null for 'other'
  name        text not null,    -- the menu name, as the list shows it
  qty         integer not null default 1 check (qty > 0),
  note        text,             -- how it was ordered: temperature, neat, a mixer, a side swap
  heard       text,             -- the transcript this order came from
  interaction_id uuid,          -- the watch's app_logs interaction for that recording
  done_at     timestamptz
);

create index cg_orders_open on public.cg_orders (created_at desc) where done_at is null;

alter table public.cg_orders enable row level security;
