-- The restaurant menu app (repo Menu) holds no restaurant data in its
-- code: everything it shows or tells the model comes from these tables, and its key is the `apps`
-- publishable key, which reaches the database as the anon role.

-- Menu groups (lunch, dinner, ...): the title shown for each, its order, and the order of its sections.
-- menu_dishes.menu holds a group id.
create table if not exists public.menu_groups (
    id       text primary key,
    title    text not null,
    sort     integer not null default 0,
    sections text[] not null default '{}'
);
alter table public.menu_groups enable row level security;
create policy cg_anon_read on public.menu_groups for select to anon using (true);

-- Fields a dish carries that the app does not model, kept with the dish rather than dropped.
alter table public.menu_dishes add column if not exists extra jsonb;

-- The restaurant's name, interpolated into every prompt and display string that names it. One value:
-- it is set on the `default` profile row only, and the app reads it from there whatever its profile.
alter table public.app_config add column if not exists restaurant_name text;

-- Dish photos. Public read (the app loads them by URL, as it does bottle photos from `bottles`); only
-- the service key writes, so there is no storage policy for anon.
insert into storage.buckets (id, name, public)
values ('dishes', 'dishes', true)
on conflict (id) do nothing;

-- Inventory: scope anon to what the app does. RLS does not govern TRUNCATE, so it goes for all three.
revoke truncate on public.bottles, public.bottle_areas, public.restock_items from anon;

-- bottles: the app reads, adds (upsert on id), edits locations/details/image and soft-deletes
-- (deleted = true). It never deletes a row, and a readonly bottle is never soft-deleted.
drop policy if exists cg_anon_all on public.bottles;
revoke insert, update, delete on public.bottles from anon;
grant insert (id, name, kind, category, varietal,
              primary_area, primary_row, primary_column, backup_area, backup_row, backup_column)
    on public.bottles to anon;
-- PostgREST's upsert writes every column it was sent in DO UPDATE, id and kind included.
grant update (id, name, kind, category, varietal, tasting_notes, food_pairing, image_url, deleted,
              primary_area, primary_row, primary_column, backup_area, backup_row, backup_column)
    on public.bottles to anon;
create policy cg_anon_read   on public.bottles for select to anon using (true);
create policy cg_anon_insert on public.bottles for insert to anon with check (not readonly);
create policy cg_anon_update on public.bottles for update to anon
    using (true) with check (not (readonly and deleted));

-- bottle_areas (add, rename, remove) and restock_items (add, change, remove, clear) use every verb,
-- so they keep cg_anon_all.
