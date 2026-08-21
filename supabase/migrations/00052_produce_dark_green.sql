-- Retarget the second produce ring from LEAFY GREENS to DARK GREEN VEGETABLES.
--
-- Why: the nutrients that actually cluster (vitamin K1, lutein, folate) track GREENNESS, not
-- leafiness. Per 100 g, broccoli carries ~102 mcg K1 and ~1,400 mcg lutein — roughly 8x and 5x a
-- carrot, and orders of magnitude above mushrooms/onion/potato, which carry essentially none. It sits
-- clearly in the same tier as spinach, just lower. Splitting on "leafy" put broccoli on the wrong side
-- of the line and let a genuinely good vegetable day read as zero.
--
-- "Dark green vegetables" is one of the five USDA vegetable subgroups, so this is a standard category
-- rather than an invented one.
alter table nutrition_entries rename column leafy_g to dark_green_g;

-- Target rises 75 g → 150 g: the category is broader, and 150 g of broccoli alone clears the 120 mcg
-- daily K1 target, so meeting this ring guarantees K1 from food.
update app_settings
   set key = 'produce_target_dark_green_g', value = '150'
 where key = 'produce_target_leafy_g';
