-- A recipe ingredient becomes the SAME thing a logged meal's ingredient is.
--
-- Recipes predate the structured nutrition ingredient: they carried a shopping-list row (item,
-- quantity, unit) with no macros, and the only nutrition on a recipe was one set of totals on the
-- parent. Logging one therefore collapsed the whole dish into a single lump ingredient carrying those
-- totals, which loses everything the ingredient rows are for — produce never counted (85 g of banana
-- in the overnight oats scored zero fruit), subtract_leftovers could not weigh the dish, and the day
-- view had no breakdown to show.
--
-- After this a recipe ingredient is a nutrition ingredient: food/amount/unit + its own macros + its
-- produce classification. The parent's calories/protein/carbs/fat stay, but as a CACHED ROLLUP of the
-- ingredients (exactly as nutrition_entries carries its own) — the ingredients are the truth.

alter table public.recipe_ingredients rename column item     to food;
alter table public.recipe_ingredients rename column quantity to amount;

alter table public.recipe_ingredients
  add column calories     real,
  add column protein_g    real,
  add column carbs_g      real,
  add column fat_g        real,
  add column produce_g     real,
  add column produce_type  text;

-- Backfill the two recipes that predate this. Tofu's macros were already exact (its note records the
-- package: 14 P / 2 C / 7 F per 1/5 block, so half a block is 2.5x that, which is what the parent row
-- already said). The oats' per-ingredient macros are standard values for the gram amounts recorded;
-- they sum to 656/46.7/88/14.7 against the 665/51/87/15 the parent carried, the gap being whey
-- protein, whose scoop was never written down.
update public.recipe_ingredients set calories = 318, protein_g = 35, carbs_g = 5, fat_g = 17.5
  where food = 'Firm tofu';
update public.recipe_ingredients set calories =  30, protein_g =  1,   carbs_g =  1,   fat_g = 2.5
  where food = 'Unsweetened almond milk';
update public.recipe_ingredients set calories =  76, protein_g =  0.9, carbs_g = 19.4, fat_g = 0.3,
                                     produce_g = 85, produce_type = 'fruit'
  where food = 'Banana';
update public.recipe_ingredients set calories = 319, protein_g = 11.1, carbs_g = 56.9, fat_g = 5.5
  where food = 'Rolled oats';
update public.recipe_ingredients set calories = 120, protein_g = 24,   carbs_g =  3,   fat_g = 1.5
  where food = 'Whey protein';
update public.recipe_ingredients set calories =  58, protein_g =  7.9, carbs_g =  3.1, fat_g = 1.5
  where food = 'Greek yogurt (2%)';
update public.recipe_ingredients set calories =  53, protein_g =  1.8, carbs_g =  4.6, fat_g = 3.4
  where food = 'Chia seeds';

-- Every recipe ingredient now carries a portion and macros, the same floor log_nutrition enforces —
-- a recipe that cannot be logged is not worth saving.
alter table public.recipe_ingredients
  alter column amount    set not null,
  alter column calories  set not null,
  alter column protein_g set not null,
  alter column carbs_g   set not null,
  alter column fat_g     set not null;

-- Produce weight and type travel together or not at all; a type with no grams is a silent zero.
alter table public.recipe_ingredients
  add constraint recipe_ingredients_produce_pair
    check ((produce_g is null) = (produce_type is null)),
  add constraint recipe_ingredients_produce_type
    check (produce_type is null or produce_type in ('dark_green_vegetable', 'other_vegetable', 'fruit'));

-- Re-derive the parents from what their ingredients now say, so the cached rollup is not stale the
-- moment this lands.
update public.recipes r set
  calories  = t.calories,
  protein_g = t.protein_g,
  carbs_g   = t.carbs_g,
  fat_g     = t.fat_g
from (select recipe_id,
             round(sum(calories)::numeric,  1) as calories,
             round(sum(protein_g)::numeric, 1) as protein_g,
             round(sum(carbs_g)::numeric,   1) as carbs_g,
             round(sum(fat_g)::numeric,     1) as fat_g
      from public.recipe_ingredients group by recipe_id) t
where t.recipe_id = r.id;
