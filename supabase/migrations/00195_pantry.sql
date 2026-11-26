-- The pantry: the specific products he keeps at home, each with its label nutrition, so "yum yum
-- sauce" logged at home means the bottle he actually owns rather than a fresh estimate.
--
-- One row per product. `names` are what he calls it ("yum yum sauce", "teriyaki"); the nutrition is
-- the label's, per one serving of `serving_amount serving_unit` (`serving_g` when the label prints a
-- weight). A brand switch RETIRES the old row (`retired_at`, `replaced_by`) instead of editing it, so
-- what he had before stays answerable.
--
-- Rows are written at cart time by the Walmart/Amazon sessions (src/pantry.ts), not at checkout:
-- checkout happens by hand, out of sight of anything here.

create table if not exists pantry_items (
  id             bigserial primary key,
  names          text[] not null check (cardinality(names) > 0),
  product        text not null,
  serving_amount numeric not null check (serving_amount > 0),
  serving_unit   text not null,
  serving_g      numeric check (serving_g > 0),
  calories       numeric not null check (calories >= 0),
  protein_g      numeric not null check (protein_g >= 0),
  carbs_g        numeric not null check (carbs_g >= 0),
  fat_g          numeric not null check (fat_g >= 0),
  produce_type   text check (produce_type in ('dark_green_vegetable','other_vegetable','fruit')),
  retailer       text check (retailer in ('walmart','amazon')),
  item_id        text,
  notes          text,
  added_at       timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  retired_at     timestamptz,
  replaced_by    bigint references pantry_items(id)
);

create index if not exists pantry_items_current_idx on pantry_items (id) where retired_at is null;

-- Home, for deciding whether an unbranded food is his own pantry's product, is the app_settings row
-- `home_location` ("lat,lon"). It is set directly, not here: this repo is public.
