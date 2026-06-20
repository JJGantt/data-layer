-- Optional per-ingredient breakdown for composite nutrition entries (captured going forward).
-- Shape: [{name, calories, protein_g, carbs_g, fat_g}]. Null/absent for simple or historical entries.
-- Powers the hub's "expand an entry → per-ingredient macros" + per-ingredient quick-add.
alter table nutrition_entries add column if not exists ingredients jsonb;
