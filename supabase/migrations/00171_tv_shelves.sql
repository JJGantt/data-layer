-- TV SHELVES — the bedroom TV's picks screen (google-tv repo, docs/PICKS.md): rows of thumbnails,
-- each row a shelf with its own title, each item opening a video or show in its app. Written only by
-- the data MCP's `tv_picks` tool; read by the TV app through the hub's /api/tv/picks.
--
-- `position` is a double so an item or shelf can be placed between two others without renumbering
-- its neighbours. Ids are short text ('sh_…', 'pk_…') because the model quotes them back.
create table if not exists tv_shelves (
  id text primary key,
  title text not null,
  position double precision not null,
  created_at timestamptz not null default now()
);
create table if not exists tv_shelf_items (
  id text primary key,
  shelf_id text not null references tv_shelves(id) on delete cascade,
  position double precision not null,
  title text not null,
  url text not null,
  package text,
  image text,
  created_at timestamptz not null default now()
);
create index if not exists tv_shelf_items_shelf on tv_shelf_items (shelf_id, position);
alter table tv_shelves enable row level security;
alter table tv_shelf_items enable row level security;
