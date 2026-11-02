-- Par sheets for the restaurant bar's backup-stock cabinets: what each cabinet should hold, so the
-- app's assistant can compare a read-out of what is actually in one against it and add the shortfall
-- to restock_items.
--
-- product_id is a bottles.id for anything catalogued; an uncatalogued item (Elderflower Syrup) gets a
-- slug with product_kind 'misc' and a name, the same shape restock_items uses for free-text items, so
-- a par row can be copied onto the restock list as-is. Not a foreign key for that reason.
--
-- note holds the sheet's own free-text instruction (which loose bottles the cabinet also backs up),
-- returned to the assistant so a bottle it allows is not reported as out of place.

create table public.cabinets (
  id         text primary key,
  name       text not null,
  note       text,
  sort_order int  not null default 0
);

create table public.cabinet_pars (
  cabinet_id   text not null references public.cabinets(id) on delete cascade,
  product_id   text not null,
  product_kind text not null default 'liquor',
  name         text,
  quantity     int  not null check (quantity > 0),
  sort_order   int  not null default 0,
  primary key (cabinet_id, product_id)
);

alter table public.cabinets     enable row level security;
alter table public.cabinet_pars enable row level security;
create policy cg_anon_read on public.cabinets     for select to anon using (true);
create policy cg_anon_read on public.cabinet_pars for select to anon using (true);

-- The cabinet and par rows were loaded when this migration was applied and live only in the
-- database; they are not reproduced here.
