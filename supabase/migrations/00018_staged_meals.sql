-- Staged meals: a meal you might eat / will eat later, living in the same nutrition_entries table
-- but flagged so it's EXCLUDED from every total (it isn't eaten yet) while still shown in the day
-- list. Committing flips staged→false and re-stamps occurred_at to the commit time. Uncommitted
-- staged rows are tied to the day they were staged (the `date` column) and are pruned at the next
-- 4am rollover so they never clutter the table.
alter table nutrition_entries
  add column if not exists staged boolean not null default false;

-- partial index: staged rows are queried/pruned on their own, keep that fast without bloating the
-- main (committed) path.
create index if not exists nutrition_entries_staged_idx on nutrition_entries(date) where staged;
