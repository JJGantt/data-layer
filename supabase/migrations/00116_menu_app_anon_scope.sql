-- THE RESTAURANT APP'S KEY REACHES ONLY ITS OWN TABLES.
--
-- The app ships to TestFlight testers, so whatever key is inside it is public. It carries the anon
-- key, and these policies are the whole of what that key can do: read the menu/catalog tables, edit
-- inventory (bottles, bottle_areas, restock_items), and append to app_logs. Every other table has RLS
-- on and no anon policy, so the anon key gets nothing there.
--
-- app_logs is insert-only on purpose: it records what every tester asked the assistant, so anon must
-- not read it. That is why the app writes it with ignore-duplicates (ON CONFLICT DO NOTHING) rather
-- than merge-duplicates, which would need SELECT and UPDATE.

-- read-only
create policy cg_anon_read on app_config         for select to anon using (true);
create policy cg_anon_read on app_content        for select to anon using (key in ('system_prompt', 'seasonal_programs'));
create policy cg_anon_read on cocktails          for select to anon using (true);
create policy cg_anon_read on glossary           for select to anon using (true);
create policy cg_anon_read on group_descriptions for select to anon using (true);
create policy cg_anon_read on menu_dishes        for select to anon using (true);
create policy cg_anon_read on section_views      for select to anon using (true);
create policy cg_anon_read on spirit_types       for select to anon using (true);
create policy cg_anon_read on style_pairings     for select to anon using (true);

-- inventory the app edits
create policy cg_anon_all on bottles       for all to anon using (true) with check (true);
create policy cg_anon_all on bottle_areas  for all to anon using (true) with check (true);
create policy cg_anon_all on restock_items for all to anon using (true) with check (true);

-- append-only log
create policy cg_anon_insert on app_logs for insert to anon with check (true);

-- RLS on with no policy: only the data-layer touches shopping_items, with the service key, which
-- bypasses RLS.
alter table shopping_items enable row level security;
