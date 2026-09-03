-- Saved retailer item ids, so filling a cart is a lookup plus one URL rather than a browser session.
--
-- Walmart loads a whole basket from one navigation:
--   https://affil.walmart.com/cart/addToCart?items=<item_id>%7C<qty>,<item_id>%7C<qty>
-- Amazon has no working equivalent (its documented /gp/aws/cart/add.html adds nothing), so an
-- Amazon row still saves the search — the ASIN goes straight to /dp/<asin> — but not the clicking.

create table if not exists shopping_items (
  id            bigserial primary key,
  retailer      text not null check (retailer in ('walmart','amazon')),
  item_id       text not null,               -- Walmart /ip/<slug>/<id> id, or Amazon ASIN
  name          text not null,
  default_qty   integer not null default 1,  -- what "the usual" means for this item
  category      text,
  notes         text,
  last_verified date default current_date,   -- ids get retired; a stale row fails silently in a URL
  created_at    timestamptz not null default now(),
  unique (retailer, item_id)
);

create index if not exists shopping_items_retailer_idx on shopping_items (retailer);

insert into shopping_items (retailer, item_id, name, category) values
  ('walmart','44390948','Fresh Banana, Each','produce'),
  ('walmart','44390949','Fresh Hass Avocados, Each','produce'),
  ('walmart','44390950','Fresh Honeycrisp Apple, Each','produce'),
  ('walmart','41752773','Fresh Bulk Yellow Lemons','produce'),
  ('walmart','51259378','Fresh Whole Green Broccoli Crowns, 1 Each','produce'),
  ('walmart','586083289','Sliced Brown Mushroom, 8 oz','produce'),
  ('walmart','13893738','Marketside Fresh Spinach, 10 oz Bag','produce'),
  ('walmart','44390945','Fresh Green Bell Pepper, Each','produce'),
  ('walmart','47770124','Fresh Bell Peppers, 3 Count','produce'),
  ('walmart','14053328','Marketside Fresh Green Beans, 12 oz','produce'),
  ('walmart','134768563','Nasoya Organic Super Firm Tofu, 16 oz','protein'),
  ('walmart','624947837','Cleveland Kitchen Classic Kimchi, 16 oz','condiment'),
  ('walmart','5409811405','Cleveland Kitchen Spicy Kimchi, 16 oz','condiment'),
  ('walmart','10450117','Great Value Fat-Free Milk, Gallon','dairy'),
  ('walmart','48319449','Marketside Cage Free Large Brown Eggs, 18 Count','dairy'),
  ('walmart','26559565','Great Value Plain Nonfat Greek Yogurt, 32 oz','dairy'),
  ('walmart','10291058','Land O Lakes Salted Stick Butter, 16 oz','dairy'),
  ('walmart','19587153842','Thomas'' Plain Bagels, 6 count','bakery'),
  ('walmart','19603205958','Thomas'' Sourdough Bagels, 6 count','bakery'),
  ('walmart','45980580','Fresh Cravings Restaurant Style Mild Salsa, 16 oz','condiment'),
  ('walmart','390604173','Fresh Cravings Pico de Gallo Salsa Mild, 14 oz','condiment'),
  ('walmart','244627151','Mizkan Mirin Sweet Cooking Seasoning, 12 fl oz','pantry'),
  ('walmart','3521443523','Terry Ho''s Yum Yum Sauce, Reduced Calorie, 16 fl oz','condiment'),
  ('walmart','777839120','Jif Creamy Peanut Butter, 16 oz','pantry'),
  ('walmart','862748103','Great Value Organic Chia Seeds, 32 oz','pantry'),
  ('walmart','614782809','Great Value Sesame Seeds, 2.2 oz','pantry'),
  ('walmart','676979470','Great Value Garlic Powder, 3.4 oz','pantry'),
  ('walmart','10312440','Quaker Quick 1-Minute Instant Oats, 18 oz','pantry'),
  ('walmart','5015961236','Frosted Flakes Chocolate Milkshake Cereal, 22.2 oz','cereal'),
  ('walmart','5317217225','Frosted Mini-Wheats Original, 16 oz','cereal'),
  ('walmart','5014113090','Frosted Flakes Original, 12 oz','cereal'),
  ('walmart','716568979','Cap''n Crunch Crunch Berries, 11.7 oz','cereal'),
  ('walmart','5320852942','Special K Chocolatey Delight, 16.9 oz','cereal'),
  ('walmart','5319672103','Special K Fruit and Yogurt, 17.9 oz','cereal'),
  ('walmart','872651478','Cheerios Oat Crunch Oats ''N Honey, 24 oz','cereal'),
  ('walmart','42124215','Great Value Donut Shop Medium Roast Coffee Pods, 48 Count','coffee'),
  ('walmart','14580319069','Bounty Select-A-Size Paper Towels, 6 Mega Rolls','household')
on conflict (retailer, item_id) do nothing;
