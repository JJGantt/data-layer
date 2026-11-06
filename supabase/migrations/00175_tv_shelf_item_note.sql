-- An annotation on a TV Guide item (tvGuide.ts `annotate`), drawn at the bottom of its thumbnail:
-- a score, a runtime, a tag. Null shows nothing.
alter table tv_shelf_items add column if not exists note text;
