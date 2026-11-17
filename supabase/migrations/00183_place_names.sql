-- Place names for positions, from Apple Maps (data-layer src/places.ts): the address at a spot, and the
-- business or landmark there when Apple has one. Keyed by the position rounded to 4 decimals (about 11 m),
-- so each spot is looked up once and every machine shares the answer. `poi` is null where Apple has none.
create table if not exists place_names (
  key          text primary key,           -- 'lat,lon' at 4 decimals
  address      text,                       -- e.g. '123 Main St, Jacksonville, FL'
  poi          text,                       -- business / landmark name at that spot
  area         text,                       -- neighbourhood or area of interest, when Apple gives one
  looked_up_at timestamptz not null default now()
);
alter table place_names enable row level security;
