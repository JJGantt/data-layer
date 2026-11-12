-- A TV Guide item's description (tvGuide.ts `describe`): a short plot summary drawn under its title,
-- as long as it runs. Null shows nothing.
alter table tv_shelf_items add column if not exists description text;
