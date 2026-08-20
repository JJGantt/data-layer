-- Produce tracking: per-day vegetable / leafy-green / fruit grams, alongside the macros.
--
-- Model: each INGREDIENT optionally carries `produce_g` (as-eaten grams) + `produce_type`
-- ('leafy' | 'vegetable' | 'fruit') inside the existing `ingredients` jsonb. The entry-level
-- columns below are the ROLLUP of those ingredients — identical to how calories/protein/carbs/fat
-- already work (entry totals are always the sum of ingredients, never set directly).
--
-- Nesting is derived server-side, never trusted to the model: leafy counts INSIDE veg, so
--   leafy_g = sum(produce_g where type = 'leafy')
--   veg_g   = sum(produce_g where type in ('leafy','vegetable'))
--   fruit_g = sum(produce_g where type = 'fruit')
-- The model makes ONE judgment per ingredient (what kind of produce, how many grams); the subset
-- relationship is enforced in code so spinach can't be double-logged as both leafy and vegetable.
--
-- Columns are nullable: every historical row stays NULL and reads as 0 in the daily sums. No backfill.
alter table nutrition_entries add column if not exists veg_g   real;
alter table nutrition_entries add column if not exists leafy_g real;
alter table nutrition_entries add column if not exists fruit_g real;

-- Daily produce goals. FIXED constants (research-derived), unlike the macro targets which are
-- recomputed every stream build by the adaptive-maintenance/TDEE engine. That's why they live here
-- in app_settings rather than in the per-day nutrition_targets series — nothing recalculates them,
-- and storing them per-day would just duplicate the same three numbers forever.
--
-- Sources: US Dietary Guidelines vegetable/fruit amounts at a ~2600-3000 cal intake level
-- (~3.5-4 cup-eq vegetables, 2-2.5 cup-eq fruit). Leafy is a floor WITHIN the vegetable total.
insert into app_settings (key, value) values
  ('produce_target_veg_g',   '300'),
  ('produce_target_leafy_g',  '75'),
  ('produce_target_fruit_g', '250')
on conflict (key) do nothing;
